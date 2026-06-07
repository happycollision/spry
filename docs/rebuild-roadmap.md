# Rebuild Roadmap

This document tracks the feature gap between `main` and the `rebuild-spry` branch, and records decisions about what to do with each item.

The rebuild started fresh with better test infrastructure and a cleaner architecture. Not everything from `main` needs a direct port — some things should be redesigned, some merged, some dropped.

---

## What exists on this branch

- `sp view` — offline stack display, reads PR status from `refs/spry/prs` cache
- `sp sync` — push branches, open PRs (`--open`), retarget stacked PRs
- `sp group` — interactive TUI for grouping/reordering commits

## What exists on `main` but not here

### Commands

| Feature          | `main` shape                                                                                                                     | Decision needed                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sp sync` rebase | `sync` fetches remote, checks if stack is behind, predicts conflicts, rebases automatically                                      | **Decided:** `sp sync` does not rebase. Becomes a standalone `sp rebase` command instead. `sp sync` warns if the stack is behind but does not act. |
| `sp sync --all`  | Loops over all local spry branches, syncs each one                                                                               | **Decided:** Push-only. No rebase, same rule as `sp sync`.                                                                                         |
| `sp land`        | Merges a PR (or `--all` merges the whole stack bottom-up), retargets downstream PRs after each merge, waits for merge to confirm | Port. May want to redesign the retry/wait flow.                                                                                                    |
| `sp land --all`  | Merges every PR in the stack bottom-up, retargeting as it goes                                                                   | Port alongside `sp land`.                                                                                                                          |
| `sp clean`       | Finds orphaned remote spry branches (both SHA-merged and commit-id-landed), deletes them                                         | Port. Useful housekeeping command.                                                                                                                 |

### Sync capabilities not yet on this branch

| Capability                                      | Notes                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Fetch remote before sync                        | `main` runs `git fetch` at the start of every sync                                            |
| `cleanupMergedPRs`                              | During sync, detects units whose PRs were already merged and removes them from the active set |
| `purgeOrphanedTitles` / `purgeOrphanedSettings` | Cleanup of stale refs when commits are removed from the stack                                 |

### Internal modules not yet on this branch

These are internal and don't map directly to user-facing features, but are needed to implement the above:

| Module                        | Purpose                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `src/git/behind.ts`           | `isStackBehindMain`, `getCommitsBehind`, `fastForwardLocalMain`, `fetchRemote`  |
| `src/git/conflict-predict.ts` | `predictRebaseConflicts` — dry-run rebase to detect conflicts before committing |
| `src/git/group-rebase.ts`     | Rebase logic that understands group structure                                   |
| `src/git/remote.ts`           | `getAllSyncStatuses`, `getSyncSummary`, sync status per branch                  |
| `src/git/trailers.ts`         | Likely trailer read/write utilities (we have this inline today)                 |
| `src/git/pr-detection.ts`     | Detects which commits have landed (by SHA or commit-id trailer)                 |
| `src/tui/open-select.ts`      | Likely the `--open` TUI (we have `select.ts` which may cover this)              |
| `src/tui/pr-adopt-select.ts`  | PR adoption picker for groups (we have inline in `group.ts`)                    |

---

## Immediate next steps (agreed)

1. **`sp rebase`** — standalone command: fetch, check if behind, predict conflicts, rebase. Clean separation from push/PR operations.
2. **`sp sync --all`** — implement the multi-branch push loop (push-only, no rebase).
3. **`sp land`** — port and redesign the merge/retarget/wait flow.
4. **`sp clean`** — port the orphaned-branch cleanup command.

---

## Decisions

- **`sp sync` never rebases.** Push-only. This applies to `sp sync`, `sp sync --open`, and `sp sync --all` — none of them rebase, ever.
- **`sp sync` fails when the stack is behind.** Exits with an error telling the user to run `sp rebase`. No partial work, no continue-anyway flag. We can do something smarter in the future.
- **`sp sync --all` is push-only.** Same rule: no rebase step per branch.
