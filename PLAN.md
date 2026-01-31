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
