# Plan: Investigate plumbing rebase behavior with worktrees

## Problem [RESOLVED]

When running `sp sync` from a worktree while the main branch (or any Spry-managed branch) is checked out in another worktree, the plumbing operations that use `git update-ref` may update branch refs without updating the working directory of other worktrees, leaving them in a dirty state.

**Bug fixed**: The `fastForwardLocalMain()` function now checks if main is checked out in _any_ worktree before attempting to update the ref via `git update-ref`.

**Root cause was**: The check in `fastForwardLocalMain()` only checked if main is the current branch in the _current_ worktree, not if it's checked out in _any_ worktree.

**Resolution**: Added `isBranchCheckedOutInWorktree()` utility and updated `fastForwardLocalMain()` to skip fast-forward when main is checked out in another worktree (returns `skippedReason: "in-worktree"`).

## Current Status

### Phase 1: Add worktree test infrastructure [DONE]

Added worktree support to the repo helper in `src/scenario/core.ts`:

- `createWorktree(branch, path?)` - Creates a worktree for an existing branch
- `listWorktrees()` - Lists all worktrees with branch/head info
- `removeWorktree(path)` - Removes a worktree

### Phase 2: Write failing tests [DONE]

Created `tests/integration/worktree.test.ts` with scenarios:

1. **Main checked out in another worktree + fast-forward** - FAILS (confirms bug)
2. **Feature branch checked out in another worktree + rebase** - PASSES (plumbing rebase doesn't affect other feature branches)
3. **Worktree utility tests** - PASS
4. **Ancestry verification test** - Added

### Phase 2b: Add ancestry verification to all rebase tests [DONE]

Added ancestry verification to:

- `tests/integration/worktree.test.ts`:
  - Added `merge-base` check to "feature branch in another worktree" test
  - Added new "sync rebases feature branch on top of origin/main (ancestry verification)" test
- `tests/integration/sync.test.ts`:
  - Added ancestry check to "rebases onto origin/main even when local main has diverged"
  - Added new "fast-forwards local main when syncing from feature branch" test

### Phase 3: Implement fix [DONE]

Implemented:

1. **Added `isBranchCheckedOutInWorktree()` utility** in `src/git/commands.ts`
   - Uses `git worktree list --porcelain` to check all worktrees
   - Returns true if the specified branch is checked out anywhere

2. **Updated `fastForwardLocalMain()` in `src/git/behind.ts`**
   - Added check for main being in any worktree before updating ref
   - New skip reason: `"in-worktree"` when main is checked out elsewhere
   - Updated `FastForwardResult` type to include new reason

3. **Analyzed `finalizeRewrite()` - no changes needed**
   - Always operates on the current branch (via `getCurrentBranch()`)
   - Git doesn't allow the same branch in multiple worktrees
   - The `resetToCommit()` correctly updates the current worktree

## Files Modified

1. **`src/scenario/core.ts`** - Added worktree methods to repo helper [DONE]
2. **`tests/integration/worktree.test.ts`** - Worktree test scenarios with ancestry verification [DONE]
3. **`tests/integration/sync.test.ts`** - Added ancestry verification tests [DONE]
4. **`src/git/commands.ts`** - Added `isBranchCheckedOutInWorktree()` utility [DONE]
5. **`src/git/behind.ts`** - Updated `fastForwardLocalMain()` to check worktrees [DONE]
6. **`PLAN.md`** - This file [DONE]

## Verification

Run tests in docker (requires git 2.40+):

```bash
bun run test:local:docker
```

## Test Results (Final Run)

- **Worktree dirty bug: FIXED** - Main worktree stays clean after sync from feature worktree
- **Feature branch worktree: PASSES** - Plumbing rebase doesn't affect other feature branches
- **All 36 local tests pass**

---

## Follow-up Work

### Phase 4: Audit for hardcoded "main" references [DONE]

Ensure no runtime code hardcodes "main" as the default branch name.

**Finding**: Only 1 issue in runtime code:

- `src/scenario/definitions.ts:231` - `await repo.checkout("main")` should use `repo.defaultBranch`

**Fix**: Change line 231 from:

```typescript
await repo.checkout("main");
```

to:

```typescript
await repo.checkout(repo.defaultBranch);
```

Note: `src/scenario/core.ts:220` has `"main"` as a fallback default value which is appropriate - it's a configurable default, not a hardcoded assumption.

### Phase 5: Smart fast-forward for clean worktrees [DONE]

**Problem**: Currently we skip fast-forward entirely when main is in a worktree. But if the worktree is clean, it's safe to fast-forward using the normal method that updates the working directory.

**Current behavior** (in `src/git/behind.ts:97-101`):

```typescript
// Skip if main is checked out in any worktree - updating ref would desync that worktree
const mainInWorktree = await isBranchCheckedOutInWorktree(localMain, options);
if (mainInWorktree) {
  return { performed: false, skippedReason: "in-worktree" };
}
```

**New behavior**: If worktree is clean, do the fast-forward AND update the working directory.

#### Implementation Details

**Step 1: Add `getBranchWorktree()` in `src/git/commands.ts`**

Add after the existing `isBranchCheckedOutInWorktree()` function (around line 182):

```typescript
/**
 * Result of checking if a branch is in a worktree.
 */
export interface WorktreeCheckResult {
  /** Whether the branch is checked out in any worktree */
  checkedOut: boolean;
  /** Path to the worktree (if checked out) */
  worktreePath?: string;
}

/**
 * Check if a branch is checked out in any worktree and return its path.
 *
 * @param branch - Branch name (without refs/heads/ prefix)
 * @returns Object with checkedOut boolean and optional worktreePath
 */
export async function getBranchWorktree(
  branch: string,
  options: GitOptions = {},
): Promise<WorktreeCheckResult> {
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} worktree list --porcelain`.text()
    : await $`git worktree list --porcelain`.text();

  const output = result.trim();
  if (!output) return { checkedOut: false };

  const targetRef = `refs/heads/${branch}`;
  const entries = output.split("\n\n");

  for (const entry of entries) {
    const lines = entry.split("\n");
    let worktreePath = "";
    let branchRef = "";

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        branchRef = line.slice("branch ".length);
      }
    }

    if (branchRef === targetRef && worktreePath) {
      return { checkedOut: true, worktreePath };
    }
  }

  return { checkedOut: false };
}
```

**Step 2: Update `fastForwardLocalMain()` in `src/git/behind.ts`**

Change the import (line 3):

```typescript
import { getCurrentBranch, getBranchWorktree, hasUncommittedChanges } from "./commands.ts";
```

Replace the worktree check section (lines 97-101) with:

```typescript
// Check if main is checked out in any worktree
const worktreeInfo = await getBranchWorktree(localMain, options);

if (worktreeInfo.checkedOut && worktreeInfo.worktreePath) {
  // Main is in a worktree - check if it's clean
  const isDirty = await hasUncommittedChanges({ cwd: worktreeInfo.worktreePath });

  if (isDirty) {
    // Worktree has uncommitted changes - can't safely fast-forward
    return { performed: false, skippedReason: "in-worktree" };
  }

  // Worktree is clean - proceed with fast-forward below, but we'll need to update
  // the working directory too (flag this for later in the function)
}
```

Then after updating the ref (around line 116), add working directory update:

```typescript
// Update the local main ref directly
if (cwd) {
  await $`git -C ${cwd} update-ref refs/heads/${localMain} ${remoteSha}`.quiet();
} else {
  await $`git update-ref refs/heads/${localMain} ${remoteSha}`.quiet();
}

// If main was in a worktree, update that worktree's working directory
if (worktreeInfo.checkedOut && worktreeInfo.worktreePath) {
  await $`git -C ${worktreeInfo.worktreePath} reset --hard ${remoteSha}`.quiet();
}
```

**Step 3: Add test in `tests/integration/worktree.test.ts`**

Add after the "main checked out in another worktree - shows working directory status" test:

```typescript
test("main checked out in clean worktree - fast-forward updates both ref and working directory", async () => {
  const repo = await repos.create();

  // Create a feature branch
  const featureBranch = await repo.branch("feature");
  await repo.commit({ message: "Feature commit" });

  // Go back to main and create a worktree for the feature branch
  await repo.checkout("main");
  const worktree = await repo.createWorktree(featureBranch);

  // Update origin/main (simulates another developer pushing)
  await repo.updateOriginMain("Remote commit on main");
  await repo.fetch();

  // Get the remote SHA before sync
  const remoteSha = (await $`git -C ${repo.path} rev-parse origin/main`.text()).trim();

  // Verify main is behind origin/main
  const localMainBefore = (await $`git -C ${repo.path} rev-parse main`.text()).trim();
  expect(localMainBefore).not.toBe(remoteSha);

  // Main worktree should be clean
  const mainStatusBefore = await $`git -C ${repo.path} status --porcelain`.text();
  expect(mainStatusBefore.trim()).toBe("");

  // Run sync from the feature worktree
  const result = await runSync(worktree.path);
  expect(result.exitCode).toBe(0);

  // Verify main ref was updated
  const localMainAfter = (await $`git -C ${repo.path} rev-parse main`.text()).trim();
  expect(localMainAfter).toBe(remoteSha);

  // Verify main worktree is still clean AND has the new files
  const mainStatusAfter = await $`git -C ${repo.path} status --porcelain`.text();
  expect(mainStatusAfter.trim()).toBe("");

  // Verify the HEAD in main worktree matches the new SHA
  const mainHead = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();
  expect(mainHead).toBe(remoteSha);
});
```

#### Files to modify

- `src/git/commands.ts` - Add `getBranchWorktree()` and export `WorktreeCheckResult`
- `src/git/behind.ts` - Update imports and `fastForwardLocalMain()` logic
- `src/scenario/definitions.ts:231` - Fix hardcoded "main"
- `tests/integration/worktree.test.ts` - Add clean worktree fast-forward test

#### Existing utilities to use

- `hasUncommittedChanges()` in `src/git/commands.ts:81-87` - checks if worktree is dirty
- `git worktree list --porcelain` output format (used in existing code):

  ```
  worktree /path/to/worktree
  HEAD <sha>
  branch refs/heads/branch-name

  worktree /path/to/another
  ...
  ```

#### Verification

```bash
bun run test:local:docker
```
