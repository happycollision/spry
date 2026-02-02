# Plan: `sp sync --all` - Sync All Spry Branches

## Current Status

**Phase:** Not Started
**Branch:** `sp-all`

---

## Quick Start

1. Read this document for context
2. Read [PLAN_TESTING.md](./PLAN_TESTING.md) to understand the testing infrastructure
3. Start with [SUB_PLAN_PHASE_1.md](./SUB_PLAN_PHASE_1.md)
4. Complete each phase before moving to the next

**Important:** Only read the sub-plan for your current phase to keep context clean.

---

## Problem

When working with multiple feature branches, users need to manually check out each branch and run `sp sync` to rebase them onto the latest `origin/main`. This is tedious and error-prone, especially with many branches.

## Goal

Add `sp sync --all` flag that syncs every Spry-tracked local branch:

- Same result as checking out each branch and running `sp sync`
- Use git plumbing for branches not in worktrees (no checkout needed)
- Pre-check for conflicts on each branch and SKIP any that would conflict
- Handle branches checked out in worktrees specially (need working directory update)
- **Inject missing Spry-Commit-Ids** for branches with mixed commits (some with IDs, some without)
- **Validate stack structure** and skip branches with malformed groups (split groups)
- Report all successful rebases and all skipped rebases
- **NEVER** get into a failed rebase state

---

## Phase Overview

| Phase | Name                                                      | Purpose                                                     | Status      |
| ----- | --------------------------------------------------------- | ----------------------------------------------------------- | ----------- |
| 1     | [listSpryLocalBranches()](./SUB_PLAN_PHASE_1.md)          | Discover Spry branches + detect `hasMissingIds`             | Not Started |
| 2     | [Validation + Conflict Prediction](./SUB_PLAN_PHASE_2.md) | Validate stack structure (split groups) + predict conflicts | Not Started |
| 3     | [Branch-Aware APIs + Plumbing](./SUB_PLAN_PHASE_3.md)     | Branch-aware APIs + rebase branches not in worktrees        | Not Started |
| 4     | [Worktree-aware rebase](./SUB_PLAN_PHASE_4.md)            | Handle branches in worktrees                                | Not Started |
| 5     | [syncAllCommand()](./SUB_PLAN_PHASE_5.md)                 | Orchestrate: validate, inject IDs, rebase                   | Not Started |
| 6     | [CLI integration](./SUB_PLAN_PHASE_6.md)                  | Add --all flag to CLI                                       | Not Started |

Each phase builds on the previous. Complete them in order.

---

## Key Insight

The existing `rebasePlumbing()` function creates new commit objects without modifying refs or working directory. Combined with `updateRef()`, we can rebase any branch that isn't currently checked out, without affecting the user's working directory at all.

### Safe Two-Step Pattern

1. **`rebasePlumbing(onto, commits)`** - Creates new commit objects in `.git/objects`
   - These commits are "orphaned" (unreferenced) until we update a ref
   - If anything fails, git's garbage collection will clean them up
   - This is why we can safely "test" a rebase without side effects

2. **`updateRef(ref, newSha, oldSha)`** - Atomically points the branch to the new commits
   - Uses compare-and-swap for safety (fails if ref changed)
   - Only after this call do the commits become reachable

### Git Version Requirement

Git 2.40+ is required for `git merge-tree --write-tree --merge-base`. The version check happens **lazily** inside the plumbing functions (memoized), so commands that don't use these features still work on older Git.

---

## Expected Output

```
$ sp sync --all
Syncing 7 Spry branch(es)...

✓ feature-auth: rebased 3 commits onto origin/main
✓ feature-api: rebased 5 commits onto origin/main (worktree updated)
✓ feature-mixed: rebased 2 commits onto origin/main
⊘ feature-ui: skipped (up-to-date)
⊘ feature-db: skipped (would conflict in: src/db/schema.ts)
⊘ feature-wip: skipped (worktree has uncommitted changes)
⊘ feature-current: skipped (current branch - run 'sp sync' without --all)
⊘ feature-broken: skipped (split group "myGroup" - run 'sp group --fix' on that branch)

Rebased: 3 branch(es)
Skipped: 4 branch(es) (1 up-to-date, 1 conflict, 1 dirty, 1 current, 1 split-group)
```

---

## Files to Create/Modify

| File                                 | Changes                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/git/commands.ts`                | Add `listSpryLocalBranches()`, extend `getStackCommitsWithTrailers()` for branch                                                   |
| `src/git/rebase.ts`                  | Add `validateBranchStack()`, `predictRebaseConflictsForBranch()`, `rebaseBranchPlumbing()`, extend `injectMissingIds()` for branch |
| `src/cli/commands/sync.ts`           | Add `syncAllCommand()`, update `syncCommand()`                                                                                     |
| `src/cli/index.ts`                   | Add `--all` flag                                                                                                                   |
| `src/scenario/definitions.ts`        | Add `multiSpryBranches` scenario (with `feature-mixed`, `feature-split`)                                                           |
| `tests/integration/sync-all.test.ts` | New test file (includes mixed commits and split group tests)                                                                       |
| `tests/integration/helpers.ts`       | Update `runSync()` helper                                                                                                          |

---

## Testing

See [PLAN_TESTING.md](./PLAN_TESTING.md) for details on:

- How to use `repoManager()` and `LocalRepo`
- How scenarios work
- How story testing generates documentation
- The new `multiSpryBranches` scenario

Run tests with:

```bash
bun run test:docker tests/integration/sync-all.test.ts
```

---

## Existing Utilities to Leverage

These are already implemented and available:

### From `src/git/commands.ts`

- `getCurrentBranch()` - Get current branch name
- `getBranchWorktree()` - Check if branch is in a worktree and get path
- `isBranchCheckedOutInWorktree()` - Simple boolean check
- `hasUncommittedChanges()` - Check if working tree is dirty
- `getStackCommitsWithTrailers()` - Get commits with parsed trailers

### From `src/git/behind.ts`

- `fetchRemote()` - Fetch latest from origin

### From `src/git/config.ts`

- `getDefaultBranchRef()` - Get `origin/main` or equivalent

### From `src/git/plumbing.ts`

- `rebasePlumbing()` - Rebase via plumbing without touching working dir
- `updateRef()` - Atomically update branch ref
- `getFullSha()` - Resolve ref to full SHA
- `checkGitVersion()` - Verify Git 2.40+ (required for merge-tree features)

### From `src/git/conflict-predict.ts`

- `parseConflictOutput()` - Parse git merge-tree output to extract conflict files (needs to be exported)

---

## Notes for Implementation

1. **TDD Approach:** Write tests first in each phase, then implement
2. **One Phase at a Time:** Complete each phase before starting the next
3. **Use Scenarios:** Create the `multiSpryBranches` scenario in Phase 1
4. **Verify with Docker:** Use `bun run test:docker` since local git may be too old

---

## Key Considerations: Mixed Commits and Validation

### Mixed Commits (Some With IDs, Some Without)

Branches may have commits where some have `Spry-Commit-Id` trailers and some don't (if user created commits after last sync). The `sync --all` command must:

1. Detect branches with missing IDs (`hasMissingIds` in `SpryBranchInfo`)
2. Inject missing IDs using `injectMissingIds({ branch })` BEFORE rebasing
3. This requires branch-aware versions of `getStackCommitsWithTrailers()` and `injectMissingIds()`

### Malformed Groups (Split Groups)

Branches may have "split groups" - commits with the same `Spry-Group` ID that aren't contiguous. This is a structural error. The `sync --all` command must:

1. Validate each branch's stack using `validateBranchStack()`
2. Skip branches with split groups (reason: `"split-group"`)
3. Report clear error message directing user to `sp group --fix`

### Processing Order

For each branch:

1. **Validate** - Check for split groups (skip if invalid)
2. **Inject IDs** - If `hasMissingIds`, inject them
3. **Predict conflicts** - Test if rebase would conflict (skip if would conflict)
4. **Rebase** - Perform the rebase via plumbing
