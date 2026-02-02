# Plan: `sp sync --all` - Sync all Spry branches

## Background: Completed Worktree Infrastructure

Previous work added worktree-aware plumbing operations. Key utilities now available:

### Worktree Utilities (in `src/git/commands.ts`)

- **`isBranchCheckedOutInWorktree(branch)`** - Returns true if branch is checked out in any worktree
- **`getBranchWorktree(branch)`** - Returns `{ checkedOut: boolean, worktreePath?: string }`
- **`hasUncommittedChanges({ cwd })`** - Checks if working tree is dirty (line 81-87)

### Repo Helper Worktree Methods (in `src/scenario/core.ts`)

- `createWorktree(branch, path?)` - Creates a worktree for an existing branch
- `listWorktrees()` - Lists all worktrees with branch/head info
- `removeWorktree(path)` - Removes a worktree

### Git Worktree Porcelain Format

```
worktree /path/to/worktree
HEAD <sha>
branch refs/heads/branch-name

worktree /path/to/another
...
```

### Key Insight: `finalizeRewrite()` Behavior

- Always operates on the current branch (via `getCurrentBranch()`)
- Git doesn't allow the same branch in multiple worktrees
- `resetToCommit()` correctly updates the current worktree

---

## Problem

When working with multiple feature branches, users need to manually check out each branch and run `sp sync` to rebase them onto the latest `origin/main`. This is tedious and error-prone, especially with many branches.

## Goal

Add `sp sync --all` flag that syncs every Spry-tracked local branch in the repository:

- Same result as checking out each branch and running `sp sync`
- Since we're NOT checking out branches, use git plumbing for branches not in worktrees
- Pre-check for conflicts on each branch and SKIP any that would conflict
- Handle branches checked out in worktrees specially (need "real" rebase for working directory)
- Report all successful rebases and all skipped rebases
- NEVER get into a failed rebase state

## Key Insight

The existing `rebasePlumbing()` function creates new commit objects without modifying refs or working directory. Combined with `updateRef()`, we can rebase any branch that isn't currently checked out, without affecting the user's working directory at all.

## Implementation Plan

### Step 1: Add `listSpryLocalBranches()` utility

**File:** `src/git/commands.ts`

A local branch is "Spry-tracked" if it has commits with `Spry-Commit-Id` trailers between the branch tip and `origin/main`.

```typescript
export interface SpryBranchInfo {
  /** Branch name (without refs/heads/) */
  name: string;
  /** Branch tip SHA */
  tipSha: string;
  /** Number of commits in stack (between branch and origin/main) */
  commitCount: number;
  /** Whether branch is checked out in a worktree */
  inWorktree: boolean;
  /** Path to worktree if checked out */
  worktreePath?: string;
}

/**
 * List all local branches that have Spry-tracked commits.
 * A branch is Spry-tracked if it has commits with Spry-Commit-Id trailers
 * between the branch tip and origin/main.
 */
export async function listSpryLocalBranches(
  options: GitOptions = {},
): Promise<SpryBranchInfo[]>
```

**Implementation approach:**

1. Get all local branches: `git for-each-ref --format='%(refname:short) %(objectname)' refs/heads/`
2. Get default branch ref (e.g., `origin/main`)
3. For each branch (excluding default branch):
   - Get commits between branch and default: `git log --format=%H <default>..<branch>`
   - Check if any commit has `Spry-Commit-Id` trailer: `git log --format=%B <default>..<branch> | grep Spry-Commit-Id`
   - If has Spry commits, check if in worktree via `getBranchWorktree()`
4. Return list of Spry branch info

### Step 2: Add `predictRebaseConflictsForBranch()` function

**File:** `src/git/rebase.ts`

Adapt `predictRebaseConflicts()` to work on any branch, not just the current branch.

```typescript
/**
 * Check if rebasing a specific branch onto target would cause conflicts.
 * Works on any branch, not just the current one.
 *
 * @param branch - Branch name to check
 * @param onto - Target to rebase onto (e.g., "origin/main")
 * @returns Prediction of whether rebase would succeed
 */
export async function predictRebaseConflictsForBranch(
  branch: string,
  onto: string,
  options: GitOptions = {},
): Promise<RebaseConflictPrediction>
```

**Implementation:**

1. Get commits between `onto` and `branch`: `git log --format=%H <onto>..<branch>`
2. Call `rebasePlumbing(onto, commits, options)` to test
3. Return prediction result

### Step 3: Add `rebaseBranchPlumbing()` function

**File:** `src/git/rebase.ts`

Rebase a specific branch without checking it out (plumbing only).

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
 * For branches in worktrees: updates the worktree working directory.
 * For branches not in worktrees: only updates the ref (no working dir changes).
 *
 * @param branch - Branch name to rebase
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

**Implementation:**

1. Get commits: `git log --format=%H <onto>..<branch>`
2. If no commits, return `{ success: true, skippedReason: "up-to-date" }`
3. Call `rebasePlumbing(onto, commits, options)`
4. If conflict, return with `skippedReason: "conflict"`
5. On success:
   - Get old tip: `git rev-parse <branch>`
   - Update ref: `updateRef("refs/heads/<branch>", newTip, oldTip)`
   - If `worktreePath` provided, update working directory:
     ```typescript
     await $`git -C ${worktreePath} reset --hard ${newTip}`.quiet();
     ```
6. Return success with new tip

### Step 4: Add `syncAllCommand()` function

**File:** `src/cli/commands/sync.ts`

Main orchestration for `--all` flag.

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

**Implementation:**

1. Fetch from remote: `await fetchRemote()`
2. Get current branch: `await getCurrentBranch()`
3. List Spry branches: `await listSpryLocalBranches()`
4. Get target: `await getDefaultBranchRef()` (e.g., `origin/main`)
5. For each Spry branch (excluding current branch):
   a. Check if behind target (if not, skip as "up-to-date")
   b. If in worktree, check if worktree is clean:
   - `await hasUncommittedChanges({ cwd: worktreePath })`
   - If dirty, skip as "dirty-worktree"
     c. Predict conflicts: `await predictRebaseConflictsForBranch(branch, target)`
   - If would conflict, skip as "conflict"
     d. Perform rebase: `await rebaseBranchPlumbing(branch, target, worktreePath)`
     e. Record result
6. Handle current branch specially:
   - Skip in `--all` mode (user should run `sp sync` without `--all` for current branch)
   - Or: run normal sync flow for current branch at the end
7. Return results

**Output format:**

```
Syncing all Spry branches...

✓ feature-auth: rebased 3 commits onto origin/main
✓ feature-api: rebased 5 commits onto origin/main (worktree updated)
⊘ feature-ui: skipped (up-to-date)
⊘ feature-db: skipped (would conflict in: src/db/schema.ts)
⊘ feature-wip: skipped (worktree has uncommitted changes)
⊘ feature-current: skipped (current branch - run 'sp sync' without --all)

Rebased: 2 branches
Skipped: 4 branches (1 up-to-date, 1 conflict, 1 dirty, 1 current)
```

### Step 5: Wire up CLI flag

**File:** `src/cli/index.ts`

Add `--all` flag to sync command:

```typescript
.option("--all", "Sync all Spry-tracked branches in the repository")
```

In command handler:

```typescript
if (options.all) {
  // Validate: --all is incompatible with --apply and --up-to
  if (options.apply || options.upTo) {
    console.error("Error: --all cannot be used with --apply or --up-to");
    process.exit(1);
  }
  await syncAllCommand(options);
} else {
  await syncCommand(options);
}
```

### Step 6: Add tests

**File:** `tests/integration/sync-all.test.ts`

Test scenarios:

1. **Basic multi-branch sync** - Two Spry branches, both get rebased
2. **Skip up-to-date branches** - Branch already on latest main
3. **Skip conflicting branches** - Branch would conflict, gets skipped with file list
4. **Handle worktrees** - Branch in clean worktree gets rebased with working dir update
5. **Skip dirty worktrees** - Branch in dirty worktree gets skipped
6. **Skip current branch** - Current branch excluded from --all
7. **Mixed results** - Some succeed, some skip, proper reporting
8. **No Spry branches** - Graceful message when no branches to sync
9. **Incompatible flags** - Error when --all used with --apply or --up-to

## Files to Create/Modify

1. **`src/git/commands.ts`** - Add `listSpryLocalBranches()`
2. **`src/git/rebase.ts`** - Add `predictRebaseConflictsForBranch()`, `rebaseBranchPlumbing()`
3. **`src/cli/commands/sync.ts`** - Add `syncAllCommand()`, update exports
4. **`src/cli/index.ts`** - Add `--all` flag, wire up command
5. **`tests/integration/sync-all.test.ts`** - New test file

## Edge Cases to Handle

1. **No Spry branches**: Graceful exit with message
2. **All branches up-to-date**: Report as success (nothing to do)
3. **All branches would conflict**: Report all skips, suggest manual resolution
4. **Branch deleted mid-operation**: Handle gracefully (branch may not exist)
5. **Detached HEAD in worktree**: Skip that worktree's branch
6. **Bare repository**: Error early (no working directory)

## Existing Utilities to Leverage

From `src/git/commands.ts`:

- `getCurrentBranch()` - Get current branch name
- `getBranchWorktree()` - Check if branch is in a worktree and get path
- `isBranchCheckedOutInWorktree()` - Simple boolean check
- `hasUncommittedChanges()` - Check if working tree is dirty
- `getStackCommitsWithTrailers()` - Get commits with parsed trailers

From `src/git/behind.ts`:

- `fetchRemote()` - Fetch latest from origin

From `src/git/config.ts`:

- `getDefaultBranchRef()` - Get `origin/main` or equivalent

From `src/git/plumbing.ts`:

- `rebasePlumbing()` - Rebase via plumbing without touching working dir
- `updateRef()` - Atomically update branch ref

## Verification

```bash
bun run test:local:docker
```
