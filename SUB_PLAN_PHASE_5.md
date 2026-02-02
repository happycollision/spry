# Phase 5: Orchestration - `syncAllCommand()`

**Goal:** Wire everything together into a single command that syncs all Spry branches.

**Status:** Not Started

**Depends on:** Phases 1-4

---

## What This Phase Does

Combines all previous phases into the main orchestration function:

1. **Discover** - Find all Spry branches (Phase 1)
2. **Analyze** - For each branch, determine if it can be rebased (Phase 2)
3. **Execute** - Rebase branches that can be rebased (Phases 3-4)
4. **Report** - Show what happened

---

## Interface

**File:** `src/cli/commands/sync.ts`

```typescript
export interface SyncAllResult {
  /** Branches that were successfully rebased */
  rebased: Array<{
    branch: string;
    commitCount: number;
    wasInWorktree: boolean;
  }>;
  /** Branches that were skipped */
  skipped: Array<{
    branch: string;
    reason: "up-to-date" | "conflict" | "dirty-worktree" | "current-branch";
    conflictFiles?: string[];
  }>;
}

/**
 * Sync all Spry-tracked branches in the repository.
 */
export async function syncAllCommand(options: SyncOptions = {}): Promise<SyncAllResult>
```

---

## Implementation Notes

### Git Version Checking

**Do NOT add an early version check at the start of `syncAllCommand()`.** The plumbing functions (`rebasePlumbing`, `mergeTree`) will check the Git version lazily when first called. This ensures that `sp` commands which don't use Git 2.40+ features still work on older Git versions.

The version check happens inside `rebasePlumbing()` and is memoized, so it only runs once per session.

### Parallel Conflict Prediction

Since conflict predictions for different branches are independent, we can run them in parallel for better performance on repos with many branches:

```typescript
// Parallel prediction for all eligible branches
const predictions = await Promise.all(
  eligibleBranches.map(b => predictRebaseConflictsForBranch(b.name, target, options))
);
```

---

## Implementation

```typescript
export async function syncAllCommand(options: SyncOptions = {}): Promise<SyncAllResult> {
  // 1. Fetch from remote
  await fetchRemote();

  // 2. Get current branch (to skip it)
  const currentBranch = await getCurrentBranch();

  // 3. Get target ref
  const target = await getDefaultBranchRef();

  // 4. List all Spry branches
  const spryBranches = await listSpryLocalBranches();

  if (spryBranches.length === 0) {
    console.log("No Spry-tracked branches found.");
    return { rebased: [], skipped: [] };
  }

  console.log(`Syncing ${spryBranches.length} Spry branch(es)...\n`);

  const rebased: SyncAllResult["rebased"] = [];
  const skipped: SyncAllResult["skipped"] = [];

  // Phase 1: Filter out branches we can skip early (current, up-to-date, dirty worktree)
  const eligibleBranches: typeof spryBranches = [];

  for (const branch of spryBranches) {
    // Skip current branch
    if (branch.name === currentBranch) {
      skipped.push({ branch: branch.name, reason: "current-branch" });
      continue;
    }

    // Check if branch is behind target
    const isBehind = await isBranchBehindTarget(branch.name, target);
    if (!isBehind) {
      skipped.push({ branch: branch.name, reason: "up-to-date" });
      continue;
    }

    // If in worktree, check if clean
    if (branch.inWorktree) {
      const isDirty = await hasUncommittedChanges({ cwd: branch.worktreePath });
      if (isDirty) {
        skipped.push({ branch: branch.name, reason: "dirty-worktree" });
        continue;
      }
    }

    eligibleBranches.push(branch);
  }

  // Phase 2: Predict conflicts in parallel for all eligible branches
  const predictions = await Promise.all(
    eligibleBranches.map(b => predictRebaseConflictsForBranch(b.name, target, options))
  );

  // Phase 3: Rebase branches that won't conflict (sequentially to avoid ref races)
  for (let i = 0; i < eligibleBranches.length; i++) {
    const branch = eligibleBranches[i]!;
    const prediction = predictions[i]!;

    if (!prediction.wouldSucceed) {
      skipped.push({
        branch: branch.name,
        reason: "conflict",
        conflictFiles: prediction.conflictInfo?.files,
      });
      continue;
    }

    // Perform rebase
    const result = await rebaseBranchPlumbing(
      branch.name,
      target,
      branch.inWorktree ? branch.worktreePath : undefined,
      options,
    );

    if (result.success) {
      rebased.push({
        branch: branch.name,
        commitCount: result.commitCount,
        wasInWorktree: branch.inWorktree,
      });
    }
  }

  // Report results
  reportSyncAllResults(rebased, skipped, target);

  return { rebased, skipped };
}

function reportSyncAllResults(
  rebased: SyncAllResult["rebased"],
  skipped: SyncAllResult["skipped"],
  target: string,
): void {
  // Show rebased
  for (const r of rebased) {
    const wtNote = r.wasInWorktree ? " (worktree updated)" : "";
    console.log(`✓ ${r.branch}: rebased ${r.commitCount} commit(s) onto ${target}${wtNote}`);
  }

  // Show skipped
  for (const s of skipped) {
    switch (s.reason) {
      case "up-to-date":
        console.log(`⊘ ${s.branch}: skipped (up-to-date)`);
        break;
      case "conflict":
        const files = s.conflictFiles?.slice(0, 3).join(", ") ?? "unknown";
        console.log(`⊘ ${s.branch}: skipped (would conflict in: ${files})`);
        break;
      case "dirty-worktree":
        console.log(`⊘ ${s.branch}: skipped (worktree has uncommitted changes)`);
        break;
      case "current-branch":
        console.log(`⊘ ${s.branch}: skipped (current branch - run 'sp sync' without --all)`);
        break;
    }
  }

  // Summary
  console.log("");
  const upToDate = skipped.filter(s => s.reason === "up-to-date").length;
  const conflicts = skipped.filter(s => s.reason === "conflict").length;
  const dirty = skipped.filter(s => s.reason === "dirty-worktree").length;
  const current = skipped.filter(s => s.reason === "current-branch").length;

  console.log(`Rebased: ${rebased.length} branch(es)`);
  if (skipped.length > 0) {
    const parts = [];
    if (upToDate > 0) parts.push(`${upToDate} up-to-date`);
    if (conflicts > 0) parts.push(`${conflicts} conflict`);
    if (dirty > 0) parts.push(`${dirty} dirty`);
    if (current > 0) parts.push(`${current} current`);
    console.log(`Skipped: ${skipped.length} branch(es) (${parts.join(", ")})`);
  }
}

// Helper function
async function isBranchBehindTarget(branch: string, target: string): Promise<boolean> {
  const behindCount = (
    await $`git rev-list --count ${branch}..${target}`.text()
  ).trim();
  return parseInt(behindCount, 10) > 0;
}
```

---

## Test Cases

### Test 1: Syncs multiple Spry branches

**Setup:**

- Use `multiSpryBranches` scenario

**Assert:**

- `feature-behind` is rebased
- `feature-conflict` is skipped with conflict reason
- `feature-uptodate` is skipped (or rebased if behind)
- `feature-nospy` is not processed (not Spry-tracked)

### Test 2: Skips current branch

**Setup:**

- Create two Spry branches
- Stay on branch A

**Assert:**

- Branch A is skipped with "current-branch" reason
- Branch B is processed

### Test 3: Reports all results correctly

**Setup:**

- Various branches in different states

**Assert:**

- Output contains correct symbols (✓ for success, ⊘ for skip)
- Summary counts are accurate

### Test 4: Handles worktrees correctly

**Setup:**

- Branch in clean worktree
- Branch in dirty worktree

**Assert:**

- Clean worktree branch is rebased
- Dirty worktree branch is skipped

### Test 5: No Spry branches gracefully handled

**Setup:**

- Repo with only main and non-Spry branches

**Assert:**

- Returns empty result
- No errors

### Test 6: All branches up-to-date

**Setup:**

- All Spry branches already on target

**Assert:**

- All marked as up-to-date
- No rebase operations performed

---

## Test File Addition

**File:** `tests/integration/sync-all.test.ts`

```typescript
describe("sync --all: Phase 5 - syncAllCommand orchestration", () => {
  const repos = repoManager();

  test("syncs multiple Spry branches", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await syncAllCommand({ cwd: repo.path });

    // feature-behind should be rebased
    expect(result.rebased.map(r => r.branch)).toContain(
      expect.stringContaining("feature-behind")
    );

    // feature-conflict should be skipped
    const conflictSkip = result.skipped.find(s =>
      s.branch.includes("feature-conflict")
    );
    expect(conflictSkip).toBeDefined();
    expect(conflictSkip?.reason).toBe("conflict");
  });

  test("skips current branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const currentBranch = await repo.currentBranch();
    const result = await syncAllCommand({ cwd: repo.path });

    const currentSkip = result.skipped.find(s => s.branch === currentBranch);
    expect(currentSkip).toBeDefined();
    expect(currentSkip?.reason).toBe("current-branch");
  });

  test("handles clean and dirty worktrees", async () => {
    const repo = await repos.create();

    // Create clean worktree branch
    const cleanBranch = await repo.branch("feature-clean");
    await repo.commit({
      message: "Clean commit",
      trailers: { "Spry-Commit-Id": "cln00001" },
    });
    await repo.checkout("main");
    const cleanWt = await repo.createWorktree(cleanBranch);

    // Create dirty worktree branch
    const dirtyBranch = await repo.branch("feature-dirty");
    await repo.commit({
      message: "Dirty commit",
      trailers: { "Spry-Commit-Id": "drt00001" },
    });
    await repo.checkout("main");
    const dirtyWt = await repo.createWorktree(dirtyBranch);
    await Bun.write(join(dirtyWt.path, "dirty.txt"), "Dirty\n");

    // Update origin/main
    await repo.updateOriginMain("Upstream");
    await repo.fetch();

    const result = await syncAllCommand({ cwd: repo.path });

    // Clean worktree branch should be rebased
    expect(result.rebased.find(r => r.branch === cleanBranch)).toBeDefined();

    // Dirty worktree branch should be skipped
    const dirtySkip = result.skipped.find(s => s.branch === dirtyBranch);
    expect(dirtySkip?.reason).toBe("dirty-worktree");
  });

  test("handles no Spry branches gracefully", async () => {
    const repo = await repos.create();

    // Create only non-Spry branches
    await repo.branch("feature-plain");
    await repo.commit({ message: "No Spry-Commit-Id" });

    const result = await syncAllCommand({ cwd: repo.path });

    expect(result.rebased).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});
```

---

## Output Format

```
Syncing 5 Spry branch(es)...

✓ feature-auth: rebased 3 commits onto origin/main
✓ feature-api: rebased 5 commits onto origin/main (worktree updated)
⊘ feature-ui: skipped (up-to-date)
⊘ feature-db: skipped (would conflict in: src/db/schema.ts)
⊘ feature-wip: skipped (worktree has uncommitted changes)
⊘ feature-current: skipped (current branch - run 'sp sync' without --all)

Rebased: 2 branch(es)
Skipped: 4 branch(es) (1 up-to-date, 1 conflict, 1 dirty, 1 current)
```

---

## Definition of Done

- [ ] `syncAllCommand()` function implemented in `src/cli/commands/sync.ts`
- [ ] Helper function `isBranchBehindTarget()` implemented
- [ ] Reporting function `reportSyncAllResults()` implemented
- [ ] All Phase 5 tests pass
- [ ] All skip cases handled correctly
- [ ] Output format matches specification

---

## Next Phase

Once this phase is complete, proceed to [SUB_PLAN_PHASE_6.md](./SUB_PLAN_PHASE_6.md) - CLI Integration.
