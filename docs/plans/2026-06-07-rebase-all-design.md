# Design: `sp rebase --all`

## Summary

Add branch tracking via a local-only git ref, and a `--all` flag to `sp rebase` that rebases every tracked branch onto trunk in a single command.

---

## Branch Tracking

### Storage

- Ref: `refs/spry/local/tracked-branches`
- Format: JSON array of branch name strings — `["feature-a", "feature-b"]`
- The `local/` namespace signals that this ref is never pushed to the remote
- Same read/write pattern as `refs/spry/prs` (blob object, `update-ref`)

### New module: `src/git/tracked-branches.ts`

- `loadTrackedBranches(git, opts)` → `string[]`
- `saveTrackedBranches(git, branches, opts)` → `void`
- `registerBranch(git, branch, opts)` → `void` — adds branch if not present, saves

### Registration

At the start of `syncCommand`, `groupCommand`, and `rebaseCommand` (single-branch path), call `registerBranch` with the current branch. Silent — no output to the user.

`sp view` does **not** register branches.

---

## `sp rebase --all`

### CLI change

`rebaseCommand` gains an `all?: boolean` option. The CLI wires `--all` flag to it.

### Flow

1. Require clean working tree
2. Fetch remote once
3. Load tracked branches; register current branch if not already tracked
4. For each tracked branch (sequentially):
   - Branch does not exist locally → print `<branch>: removed (no longer exists)`, mark for removal
   - Not behind trunk → print `<branch>: ✓ already up to date`
   - Behind trunk → `getStackCommitsForBranch`, `rebasePlumbing`
     - Conflict → print error for this branch, continue to next
     - Success:
       - Non-current branch: `updateRef` only (no working-tree reset)
       - Current branch: full `finalizeRewrite` (updateRef + optional reset)
5. Save tracked list with removed branches stripped out
6. Exit non-zero if any branch had a conflict or failure

Sequential (not parallel) because rebasing the current branch may reset the working tree.

### Output

```
feature-a: ✓ Rebased 2 commits onto main
feature-b: ✓ Already up to date
old-branch: removed (branch no longer exists)
feature-c: ✗ Rebase would conflict on abc1234: Add login page
```

---

## Code changes

### New

- `src/git/tracked-branches.ts` — load/save/register

### Modified

- `src/git/behind.ts` — add `isStackBehindTrunkForBranch(git, branch, trunkRef, opts)`: same logic as `isStackBehindTrunk` but uses `git merge-base <branch> <trunkRef>` instead of `HEAD`
- `src/commands/rebase.ts` — add `all?: boolean` to `RebaseOptions`; call `registerBranch` on single-branch path; implement `--all` loop
- `src/commands/sync.ts` — call `registerBranch` at start
- `src/commands/group.ts` — call `registerBranch` at start
- `src/cli/index.ts` — add `--all` flag to `rebase` command

### Tests

- `tests/commands/rebase.doc.test.ts` — add doc tests for `--all`: already up to date, rebases multiple, removes missing, conflict on one branch continues
- Unit tests for `tracked-branches.ts`
