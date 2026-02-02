# Phase 4: Worktree-Aware Rebase

**Goal:** Prove we can safely rebase branches that ARE checked out in worktrees, updating both the ref and the working directory.

**Status:** Not Started

**Depends on:** Phase 3 (extends `rebaseBranchPlumbing()` for worktree case)

---

## Why This Phase?

Phase 3 handles branches not checked out anywhere. But what about branches in worktrees?

**Problem:** If we update a ref via `git update-ref` but don't update the working directory, the worktree becomes "dirty" - git status shows changes because the index/HEAD doesn't match the working tree.

**Solution:** When rebasing a branch in a worktree:

1. Check if worktree is clean first (skip if dirty)
2. Perform plumbing rebase as usual
3. Update the ref
4. Reset the worktree to the new tip: `git -C <worktree> reset --hard <new-tip>`

---

## Key Insight

The `rebaseBranchPlumbing()` from Phase 3 already accepts a `worktreePath` parameter. In Phase 4, we:

1. Add the dirty check BEFORE calling `rebaseBranchPlumbing()`
2. Verify the worktree update works correctly

---

## Extended Interface

No new function needed! We use the existing interface from Phase 3:

```typescript
export async function rebaseBranchPlumbing(
  branch: string,
  onto: string,
  worktreePath?: string,  // <-- This enables worktree support
  options: GitOptions = {},
): Promise<BranchRebaseResult>
```

But the **caller** must:

1. Check if the branch is in a worktree
2. Check if that worktree is clean
3. Pass the `worktreePath` to enable working dir update

---

## Orchestration Logic (Preview)

This logic will live in `syncAllCommand()` (Phase 5), but we test it here:

```typescript
// For each Spry branch:
const worktreeInfo = await getBranchWorktree(branch, options);

if (worktreeInfo.checkedOut) {
  // Branch is in a worktree - check if clean
  const isDirty = await hasUncommittedChanges({ cwd: worktreeInfo.worktreePath });

  if (isDirty) {
    // Skip with reason
    return { skippedReason: "dirty-worktree" };
  }

  // Safe to rebase with worktree update
  return await rebaseBranchPlumbing(branch, onto, worktreeInfo.worktreePath, options);
} else {
  // Not in worktree - simple plumbing rebase
  return await rebaseBranchPlumbing(branch, onto, undefined, options);
}
```

---

## Test Cases

### Test 1: Rebases branch in clean worktree

**Setup:**

- Create feature branch with Spry commits
- Create worktree for feature branch
- Update origin/main
- Worktree is clean

**Assert:**

- Rebase succeeds
- Worktree HEAD matches new tip
- Worktree is still clean (no dirty state)
- New files from rebase are present in worktree

### Test 2: Skips branch in dirty worktree

**Setup:**

- Create feature branch with Spry commits
- Create worktree for feature branch
- Modify a file in worktree (make it dirty)
- Update origin/main

**Assert:**

- Helper function detects dirty state
- Rebase is skipped
- Worktree is unchanged

### Test 3: Does not affect other worktrees

**Setup:**

- Create two feature branches
- Create worktrees for both
- Rebase branch A

**Assert:**

- Branch B's worktree is unchanged
- Branch A's worktree is updated

### Test 4: Worktree has correct files after rebase

**Setup:**

- Origin/main adds new file `upstream.txt`
- Feature branch in worktree
- Rebase feature onto origin/main

**Assert:**

- After rebase, worktree contains `upstream.txt`

---

## Scenario Addition

Add to `src/scenario/definitions.ts`:

```typescript
/**
 * Spry branches with worktrees for testing sync --all worktree behavior.
 * Extends multiSpryBranches with worktree scenarios.
 */
multiSpryBranchesWithWorktrees: {
  name: "multi-spry-branches-worktrees",
  description: "Spry branches with worktrees (clean and dirty)",
  repoType: "local",
  setup: async (repo: ScenarioRepo) => {
    // First do the standard multiSpryBranches setup
    await scenarios.multiSpryBranches.setup(repo);

    // Now add worktree-specific branches
    await repo.checkout(repo.defaultBranch);

    // Clean worktree branch
    await repo.branch("feature-wt-clean");
    await repo.commit({
      message: "Clean worktree commit",
      trailers: { "Spry-Commit-Id": "wtcl0001" },
    });
    await repo.checkout(repo.defaultBranch);
    // Worktree will be created by test as needed

    // Dirty worktree branch
    await repo.branch("feature-wt-dirty");
    await repo.commit({
      message: "Dirty worktree commit",
      trailers: { "Spry-Commit-Id": "wtdr0001" },
    });
    await repo.checkout(repo.defaultBranch);
    // Worktree will be created and dirtied by test

    // Return to feature-behind as current
    await repo.checkout("feature-behind-" + repo.uniqueId);
  },
}
```

---

## Test File Addition

**File:** `tests/integration/sync-all.test.ts`

```typescript
describe("sync --all: Phase 4 - Worktree-aware rebase", () => {
  const repos = repoManager();

  test("rebases branch in clean worktree", async () => {
    const repo = await repos.create();

    // Create feature branch
    const featureBranch = await repo.branch("feature");
    await repo.commit({
      message: "Feature commit",
      trailers: { "Spry-Commit-Id": "wt000001" },
    });

    // Go back to main and create worktree
    await repo.checkout("main");
    const worktree = await repo.createWorktree(featureBranch);

    // Update origin/main with a new file
    await repo.updateOriginMain("Add upstream file", {
      "upstream.txt": "Upstream content\n",
    });
    await repo.fetch();

    // Verify worktree is clean
    const dirtyBefore = await hasUncommittedChanges({ cwd: worktree.path });
    expect(dirtyBefore).toBe(false);

    // Rebase with worktree path
    const result = await rebaseBranchPlumbing(
      featureBranch,
      "origin/main",
      worktree.path,
      { cwd: repo.path },
    );

    expect(result.success).toBe(true);

    // Verify worktree is still clean
    const dirtyAfter = await hasUncommittedChanges({ cwd: worktree.path });
    expect(dirtyAfter).toBe(false);

    // Verify worktree has the upstream file
    const upstreamExists = await Bun.file(join(worktree.path, "upstream.txt")).exists();
    expect(upstreamExists).toBe(true);

    // Verify worktree HEAD matches new tip
    const wtHead = (await $`git -C ${worktree.path} rev-parse HEAD`.text()).trim();
    expect(wtHead).toBe(result.newTip);
  });

  test("detects dirty worktree (test helper for orchestration)", async () => {
    const repo = await repos.create();

    // Create feature branch
    const featureBranch = await repo.branch("feature");
    await repo.commit({ message: "Feature commit" });

    // Go back to main and create worktree
    await repo.checkout("main");
    const worktree = await repo.createWorktree(featureBranch);

    // Make worktree dirty
    await Bun.write(join(worktree.path, "dirty.txt"), "Dirty content\n");

    // Verify dirty detection works
    const isDirty = await hasUncommittedChanges({ cwd: worktree.path });
    expect(isDirty).toBe(true);

    // This test just verifies the helper - actual skip logic is in Phase 5
  });

  test("does not affect unrelated worktrees", async () => {
    const repo = await repos.create();

    // Create two feature branches
    const featureA = await repo.branch("feature-a");
    await repo.commit({
      message: "Feature A commit",
      trailers: { "Spry-Commit-Id": "fta00001" },
    });
    await repo.checkout("main");

    const featureB = await repo.branch("feature-b");
    await repo.commit({
      message: "Feature B commit",
      trailers: { "Spry-Commit-Id": "ftb00001" },
    });
    await repo.checkout("main");

    // Create worktrees for both
    const wtA = await repo.createWorktree(featureA);
    const wtB = await repo.createWorktree(featureB);

    // Record B's HEAD before
    const headBBefore = (await $`git -C ${wtB.path} rev-parse HEAD`.text()).trim();

    // Update origin/main
    await repo.updateOriginMain("Upstream change");
    await repo.fetch();

    // Rebase only A
    await rebaseBranchPlumbing(featureA, "origin/main", wtA.path, { cwd: repo.path });

    // B should be unchanged
    const headBAfter = (await $`git -C ${wtB.path} rev-parse HEAD`.text()).trim();
    expect(headBAfter).toBe(headBBefore);
  });
});
```

---

## Definition of Done

- [ ] Worktree update logic works in `rebaseBranchPlumbing()` when `worktreePath` provided
- [ ] All Phase 4 tests pass
- [ ] Clean worktrees are updated correctly
- [ ] Dirty worktree detection works (for use in Phase 5)
- [ ] Unrelated worktrees are not affected

---

## Next Phase

Once this phase is complete, proceed to [SUB_PLAN_PHASE_5.md](./SUB_PLAN_PHASE_5.md) - Orchestration.
