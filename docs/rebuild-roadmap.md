# Rebuild Roadmap

This document tracks the feature gap between `main` and the `rebuild-spry` branch, and records decisions about what to do with each item.

The rebuild started fresh with better test infrastructure and a cleaner architecture. Not everything from `main` needs a direct port — some things should be redesigned, some merged, some dropped.

**Status as of 2026-06-25:** Only `sp clean` (plus its associated cleanup capabilities) remains unbuilt. Everything else from the original gap is either shipped or resolved by a recorded design decision below.

---

## What exists on this branch

- `sp view` — offline stack display, reads PR status from `refs/spry/prs` cache
- `sp sync` — push branches, open PRs (`--open`), retarget stacked PRs; **`--all`** pushes every tracked stack (push-only)
- `sp group` — interactive TUI for grouping/reordering commits
- `sp rebase` — fetch, behind-check, dry-run conflict predict, rebase if clean; **`--all`** rebases every tracked branch
- `sp land` — retarget in-scope PRs to trunk and fast-forward trunk to the target unit's tip; **`--through <id>`** lands from the bottom through a group/unit/commit id, bare `sp land` opens a single-select picker

Branch tracking (`refs/spry/local/tracked-branches`) is written automatically by `sp sync`, `sp group`, and `sp rebase`, and powers the `--all` variants.

## Remaining work

### `sp clean` (only unbuilt command)

| Feature    | `main` shape                                                                             | Status                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `sp clean` | Finds orphaned remote spry branches (both SHA-merged and commit-id-landed), deletes them | **Not built.** `sp land` already points users at it in its output. This is the next command to port. |

Cleanup capabilities that belong with `sp clean` (none are implemented yet, and `sp sync` deliberately does no cleanup today):

| Capability                                      | Notes                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Landed-commit detection                         | Detect which commits/units have landed, by merged SHA or `Spry-Commit-Id` trailer |
| `cleanupMergedPRs`                              | Detect units whose PRs were already merged and remove them from the active set    |
| `purgeOrphanedTitles` / `purgeOrphanedSettings` | Clean up stale group/PR refs when commits are removed from the stack              |

### Temporary commits — dropped

`main` had a "temporary commit" feature: commits whose subject matched a prefix
(`WIP`, `fixup!`, `amend!`, `squash!`, configurable via `spry.tempCommitPrefixes`)
were pushed but skipped for PR creation during `sp sync --open`, unless grouped.
This branch never had it — no `spry.tempCommitPrefixes` config, no skip logic.
It was still documented in the README until 2026-06-26; that section has been
removed. **Decided (2026-06-26): dropped for good.** Not porting it.

---

## Shipped since this roadmap was first written

- **`sp rebase`** (+ `--all`) — `src/commands/rebase.ts`, tests in `tests/commands/rebase.test.ts` + `rebase.doc.test.ts`, docs in `docs/generated/commands/rebase.*`.
- **`sp sync --all`** — push-only multi-stack loop in `src/commands/sync.ts`; prunes branches that no longer exist locally; operates entirely via git plumbing (working tree + `HEAD` untouched).
- **`sp land`** (+ `--through`) — `src/commands/land.ts` with readiness gating in `src/commands/land-readiness.ts`; real-`gh` paths covered by cassettes.
- **`src/git/behind.ts`** — `fetchRemote`, `isStackBehindTrunk`, `isStackBehindTrunkForBranch`.
- **`src/git/tracked-branches.ts`** — branch-tracking storage powering `--all`.

---

## Decisions

- **`sp rebase` is the home for fetch + rebase.** `sp sync` never rebases (see below). Fetch-before-anything moved from `main`'s sync into `sp rebase`.
- **`sp sync` never rebases.** Push-only. This applies to `sp sync`, `sp sync --open`, and `sp sync --all` — none of them rebase, ever.
- **`sp sync` fails when the stack is behind.** Exits with an error telling the user to run `sp rebase`. No partial work, no continue-anyway flag. We can do something smarter in the future.
- **`sp sync --all` is push-only.** Same rule: no rebase step per branch. Cannot be combined with `--open`.
- **`sp land` was redesigned, not ported.** `main`'s land merged PRs via the GitHub merge API (`--all` merged the stack bottom-up, waiting on each merge). This branch instead retargets every in-scope PR to trunk and does a single fast-forward push of trunk to the target tip. It never uses the merge API and never deletes branches (that's `sp clean`'s job). `--all` is replaced by `--through <id>` (whole stack = through the top unit). "Behind trunk" surfaces as a fast-forward rejection pointing at `sp rebase`.

---

## Resolved design notes (modules from the original gap)

The original roadmap listed internal modules from `main` that "don't exist here." Where they landed:

| `main` module                 | Resolution on this branch                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/git/behind.ts`           | **Built** (different surface: `isStackBehindTrunk[ForBranch]`, `fetchRemote`).                                                       |
| `src/git/conflict-predict.ts` | **Folded in.** Conflict prediction is a dry-run `rebasePlumbing` in `src/git/plumbing.ts` + `src/git/conflict.ts`; no separate file. |
| `src/git/trailers.ts`         | **Built** as `src/parse/trailers.ts`.                                                                                                |
| `src/tui/open-select.ts`      | Covered by `src/tui/select.ts`.                                                                                                      |
| `src/tui/pr-adopt-select.ts`  | Covered inline in `src/commands/group.ts` + `src/tui/select-one.ts`.                                                                 |
| `src/git/pr-detection.ts`     | **Still needed** for `sp clean` (landed-commit detection).                                                                           |
| `src/git/group-rebase.ts`     | Not needed so far — group structure rides on `refs/spry/groups`, not commit rewrites.                                                |
| `src/git/remote.ts`           | Not needed as a unit — sync status comes from `tracked-branches` + `gh` lookups.                                                     |
