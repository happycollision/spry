# Phase 3: Branch-Aware APIs and Plumbing Rebase

**Goal:** Make core APIs work on any branch (not just HEAD) and prove we can rebase branches using plumbing commands.

**Status:** Not Started

**Depends on:** Phase 2 (we use conflict prediction to pre-check)

---

## Why This Phase?

For `sync --all`, we need to:

1. Get commits for any branch (not just HEAD)
2. Inject missing Spry-Commit-Ids on any branch
3. Rebase any branch using plumbing commands

This phase provides the infrastructure for all three.

---

## Part A: Branch-Aware `getStackCommitsWithTrailers()`

### Current Limitation

The existing function is hardcoded to use `HEAD`:

```typescript
// Current: always uses HEAD
git log --reverse --format=... ${mergeBase}..HEAD
```

### Required Change

Add optional `branch` parameter:

```typescript
export async function getStackCommitsWithTrailers(
  options: GitOptions & { branch?: string } = {},
): Promise<CommitWithTrailers[]>
```

When `branch` is provided, use it instead of `HEAD`:

```typescript
const ref = options.branch ?? "HEAD";
git log --reverse --format=... ${mergeBase}..${ref}
```

### Test Case: Branch-aware getStackCommitsWithTrailers

**Setup:**

- Create two branches with different commits
- Stay on branch A

**Assert:**

- `getStackCommitsWithTrailers({ branch: "branchB" })` returns branchB's commits
- Current branch is still A

---

## Part B: Branch-Aware `injectMissingIds()`

### Current Limitation

The existing function only works on the current branch:

```typescript
// Current: uses HEAD and getCurrentBranch()
const commits = await getStackCommitsWithTrailers(options);
const branch = await getCurrentBranch(options);
```

### Required Change

Add optional `branch` parameter:

```typescript
export async function injectMissingIds(
  options: GitOptions & { branch?: string } = {},
): Promise<InjectIdsResult>
```

Implementation changes:

1. Skip `assertNotDetachedHead()` when branch is specified
2. Use branch-aware `getStackCommitsWithTrailers({ ...options, branch })`
3. Pass the branch name to `finalizeRewrite()` (already supports branch parameter)

### Test Case: Branch-aware injectMissingIds

**Setup:**

- Create branch with one commit that has ID and one without
- Stay on main

**Assert:**

- `injectMissingIds({ branch: "feature-..." })` succeeds
- Both commits on feature branch now have Spry-Commit-Id
- Current branch is still main
- Main's working directory is unchanged

---

## Part C: Plumbing Rebase - `rebaseBranchPlumbing()`

For branches not checked out in any worktree, we can rebase entirely with plumbing:

1. `rebasePlumbing()` - creates new commits without touching refs
2. `updateRef()` - atomically updates the branch ref

No working directory changes needed!

---

## Interface

**File:** `src/git/rebase.ts`

```typescript
export interface BranchRebaseResult {
  /** Whether the rebase succeeded */
  success: boolean;
  /** New tip SHA after rebase */
  newTip?: string;
  /** Number of commits rebased */
  commitCount: number;
  /** If skipped, the reason */
  skippedReason?: "up-to-date" | "conflict" | "dirty-worktree";
  /** Conflict files if skipped due to conflict */
  conflictFiles?: string[];
}

/**
 * Rebase a branch onto a target using plumbing commands.
 * Does NOT check out the branch - works entirely via git objects.
 *
 * For branches NOT in worktrees: only updates the ref.
 * For branches IN worktrees: caller must provide worktreePath for working dir update.
 *
 * @param branch - Branch name to rebase (without refs/heads/)
 * @param onto - Target to rebase onto
 * @param worktreePath - If branch is in a worktree, its path (for working dir update)
 */
export async function rebaseBranchPlumbing(
  branch: string,
  onto: string,
  worktreePath?: string,
  options: GitOptions = {},
): Promise<BranchRebaseResult>
```

---

## Implementation Approach

### For branches NOT in worktrees:

```typescript
import { parseConflictOutput } from "./conflict-predict.ts";

export async function rebaseBranchPlumbing(
  branch: string,
  onto: string,
  worktreePath?: string,
  options: GitOptions = {},
): Promise<BranchRebaseResult> {
  const { cwd } = options;

  // 1. Get commits between onto and branch
  const logResult = cwd
    ? await $`git -C ${cwd} log --reverse --format=%H ${onto}..${branch}`.text()
    : await $`git log --reverse --format=%H ${onto}..${branch}`.text();

  const commitHashes = logResult.trim().split("\n").filter(Boolean);

  if (commitHashes.length === 0) {
    return { success: true, commitCount: 0, skippedReason: "up-to-date" };
  }

  // 2. Get the target SHA
  const ontoSha = await getFullSha(onto, options);

  // 3. Perform plumbing rebase
  const result = await rebasePlumbing(ontoSha, commitHashes, options);

  if (!result.ok) {
    // Use parseConflictOutput to properly extract conflict files
    const { files } = parseConflictOutput(result.conflictInfo ?? "");
    return {
      success: false,
      commitCount: commitHashes.length,
      skippedReason: "conflict",
      conflictFiles: files,
    };
  }

  // 4. Get old tip for compare-and-swap
  const oldTip = await getFullSha(branch, options);

  // 5. Update the ref atomically
  await updateRef(`refs/heads/${branch}`, result.newTip, oldTip, options);

  // 6. If worktree provided, update working directory
  if (worktreePath) {
    await $`git -C ${worktreePath} reset --hard ${result.newTip}`.quiet();
  }

  return {
    success: true,
    newTip: result.newTip,
    commitCount: commitHashes.length,
  };
}
```

---

## Test Cases

### Test 1: Rebases branch not in any worktree

**Setup:**

- Create repo with main
- Create feature branch with Spry commits
- Update origin/main
- Stay on main (feature is not checked out anywhere)

**Assert:**

- `rebaseBranchPlumbing()` returns `success: true`
- Branch ref is updated
- Working directory (main) is unchanged

### Test 2: Returns up-to-date when no rebase needed

**Setup:**

- Create branch at origin/main tip

**Assert:**

- `skippedReason: "up-to-date"`
- No ref changes

### Test 3: Returns conflict info when would conflict

**Setup:**

- Use `multiSpryBranches` scenario
- Try to rebase `feature-conflict`

**Assert:**

- `success: false`
- `skippedReason: "conflict"`
- `conflictFiles` contains the conflicting file

### Test 4: Does not affect current branch

**Setup:**

- On main, rebase a feature branch

**Assert:**

- Current branch still main
- Main's HEAD unchanged
- Main's working directory unchanged

### Test 5: Ref is updated atomically

**Setup:**

- Rebase a branch

**Assert:**

- Branch now points to new commits
- New commits have correct ancestry (on top of onto)

---

## Test File Addition

**File:** `tests/integration/sync-all.test.ts`

```typescript
describe("sync --all: Phase 3 - Branch-aware APIs", () => {
  const repos = repoManager();

  test("getStackCommitsWithTrailers works on non-current branch", async () => {
    const repo = await repos.create();

    // Create branch A with a commit
    const branchA = await repo.branch("feature-a");
    await repo.commit({
      message: "Commit on A",
      trailers: { "Spry-Commit-Id": "aaa00001" },
    });

    // Create branch B with different commits
    await repo.checkout("main");
    const branchB = await repo.branch("feature-b");
    await repo.commit({
      message: "Commit on B",
      trailers: { "Spry-Commit-Id": "bbb00001" },
    });
    await repo.commit({
      message: "Second commit on B",
      trailers: { "Spry-Commit-Id": "bbb00002" },
    });

    // Stay on B, query A
    const commitsA = await getStackCommitsWithTrailers({
      cwd: repo.path,
      branch: branchA,
    });

    expect(commitsA).toHaveLength(1);
    expect(commitsA[0].trailers["Spry-Commit-Id"]).toBe("aaa00001");

    // Verify still on B
    expect(await repo.currentBranch()).toBe(branchB);
  });

  test("injectMissingIds works on non-current branch", async () => {
    const repo = await repos.create();

    // Create branch with mixed commits (one with ID, one without)
    const branch = await repo.branch("feature-mixed");
    await repo.commit({
      message: "Commit with ID",
      trailers: { "Spry-Commit-Id": "mix00001" },
    });
    await repo.commit({ message: "Commit without ID" });

    // Go back to main
    await repo.checkout("main");

    // Inject IDs on the feature branch
    const result = await injectMissingIds({
      cwd: repo.path,
      branch,
    });

    expect(result.modifiedCount).toBe(1);

    // Verify all commits now have IDs
    const commits = await getStackCommitsWithTrailers({
      cwd: repo.path,
      branch,
    });
    for (const commit of commits) {
      expect(commit.trailers["Spry-Commit-Id"]).toBeDefined();
    }

    // Verify still on main
    expect(await repo.currentBranch()).toBe("main");
  });
});

describe("sync --all: Phase 3 - rebaseBranchPlumbing (no worktree)", () => {
  const repos = repoManager();

  test("rebases branch not checked out anywhere", async () => {
    const repo = await repos.create();

    // Create feature branch with Spry commit
    const featureBranch = await repo.branch("feature");
    await repo.commit({
      message: "Feature commit",
      trailers: { "Spry-Commit-Id": "feat0001" },
    });

    // Go back to main
    await repo.checkout("main");

    // Update origin/main
    await repo.updateOriginMain("Upstream change");
    await repo.fetch();

    // Rebase the feature branch (not checked out)
    const result = await rebaseBranchPlumbing(
      featureBranch,
      "origin/main",
      undefined, // no worktree
      { cwd: repo.path },
    );

    expect(result.success).toBe(true);
    expect(result.commitCount).toBe(1);
    expect(result.newTip).toBeDefined();

    // Verify feature is now on top of origin/main
    const mergeBase = await $`git -C ${repo.path} merge-base ${featureBranch} origin/main`.text();
    const originMain = await $`git -C ${repo.path} rev-parse origin/main`.text();
    expect(mergeBase.trim()).toBe(originMain.trim());

    // Verify we're still on main
    expect(await repo.currentBranch()).toBe("main");
  });

  test("returns up-to-date when branch already on target", async () => {
    const repo = await repos.create();

    // Create feature at same point as main
    const featureBranch = await repo.branch("feature");
    await repo.checkout("main");

    const result = await rebaseBranchPlumbing(
      featureBranch,
      "origin/main",
      undefined,
      { cwd: repo.path },
    );

    expect(result.success).toBe(true);
    expect(result.skippedReason).toBe("up-to-date");
  });

  test("returns conflict info for conflicting branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await rebaseBranchPlumbing(
      `feature-conflict-${repo.uniqueId}`,
      "origin/main",
      undefined,
      { cwd: repo.path },
    );

    expect(result.success).toBe(false);
    expect(result.skippedReason).toBe("conflict");
    expect(result.conflictFiles).toContain("conflict.txt");
  });
});
```

---

## Definition of Done

- [ ] `getStackCommitsWithTrailers()` extended with optional `branch` parameter
- [ ] `injectMissingIds()` extended with optional `branch` parameter
- [ ] `rebaseBranchPlumbing()` function implemented in `src/git/rebase.ts`
- [ ] All Phase 3 tests pass
- [ ] Branch-aware APIs work without modifying current branch or working directory
- [ ] `rebaseBranchPlumbing()` correctly rebases branches not in worktrees
- [ ] Ref is updated atomically with compare-and-swap

---

## Next Phase

Once this phase is complete, proceed to [SUB_PLAN_PHASE_4.md](./SUB_PLAN_PHASE_4.md) - Worktree-Aware Rebase.
