# Rebuild Roadmap

This document tracks the feature gap between `main` and the `rebuild-spry` branch, and records decisions about what to do with each item.

The rebuild started fresh with better test infrastructure and a cleaner architecture. Not everything from `main` needs a direct port — some things should be redesigned, some merged, some dropped.

**Status as of 2026-06-27:** The rebuild gap is closed. `sp clean` is built (as a deliberately simpler "delete branches that are in remote trunk" reaper — see below), and the cleanup capabilities that `main` bundled into `clean` are instead handled deterministically by `sp land`'s post-land scrub. Everything from the original gap is either shipped or resolved by a recorded design decision below.

---

## What exists on this branch

- `sp view` — offline stack display, reads PR status from `refs/spry/prs` cache
- `sp sync` — push branches, open PRs (`--open`), retarget stacked PRs; **`--all`** pushes every tracked stack (push-only)
- `sp group` — interactive TUI for grouping/reordering commits
- `sp rebase` — fetch, behind-check, dry-run conflict predict, rebase if clean; **`--all`** rebases every tracked branch
- `sp land` — retarget in-scope PRs to trunk and fast-forward trunk to the target unit's tip; **`--through <id>`** lands from the bottom through a group/unit/commit id, bare `sp land` opens a single-select picker. After a successful ff-push it **scrubs the landed units' state** (drops their PR-cache entries and group records) and, when `spry.autoDeleteOnLand` is set, deletes their remote branches.
- `sp clean` — delete remote spry branches whose tip is an ancestor of remote trunk (i.e. "in remote trunk"); **`--dry-run`** previews. The manual reaper for branches `sp land` left behind (or that were merged through the GitHub UI).

Branch tracking (`refs/spry/local/tracked-branches`) is written automatically by `sp sync`, `sp group`, and `sp rebase`, and powers the `--all` variants.

## Remaining work

None — the rebuild gap is closed. `sp clean` was the last unbuilt command; it shipped on 2026-06-27, redesigned rather than ported (see Decisions). The cleanup capabilities `main` bundled into `clean` are resolved as follows:

| `main` capability                               | Resolution on this branch                                                                                                                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landed-commit detection (SHA or trailer)        | **Reduced.** `sp clean` detects "landed" as `merge-base --is-ancestor <branchTip> <remote>/<trunk>` only — no `Spry-Commit-Id` trailer, squash, or rebase-merge heuristics. `sp land` needs no detection at all: it knows the scope it just landed. |
| `cleanupMergedPRs`                              | **Deterministic in `sp land`.** After landing, land drops the landed units' entries from the PR cache (`refs/spry/prs`). No "detect already-merged" pass — land knows what it merged.                                                               |
| `purgeOrphanedTitles` / `purgeOrphanedSettings` | **Deterministic in `sp land`.** Land scrubs the landed units' group records (`refs/spry/groups`). Remaining stale refs self-heal: PR cache rebuilds on the next `sp sync`, group records on the next `sp group`.                                    |

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
- **`sp land` post-land scrub** — after a successful ff-push, land drops the landed units' PR-cache entries and group records (always), and deletes their remote branches when `spry.autoDeleteOnLand` is set. All cleanup is best-effort (warns, never aborts the completed land) and adds no `gh` calls, so the land cassettes stay valid. `src/commands/land.ts`, tests in `tests/commands/land.test.ts`.
- **`sp clean`** — `src/commands/clean.ts`; deletes remote spry branches whose tip is an ancestor of trunk, with `--dry-run`. Fetches with `--prune` and treats an already-gone branch as benign (idempotent). Pure git, fully offline — tests in `tests/commands/clean.test.ts` + `clean.doc.test.ts`, no cassettes. Helpers: `deleteRemoteBranch` / `isAlreadyGone` in `src/gh/push.ts`, `deletePRCacheRemote` in `src/gh/pr-cache.ts`.
- **`spry.autoDeleteOnLand`** — `SpryConfig` boolean (default false) in `src/git/config.ts`; opt-in because some repos have GitHub auto-delete head branches on merge.
- **`src/git/behind.ts`** — `fetchRemote`, `isStackBehindTrunk`, `isStackBehindTrunkForBranch`.
- **`src/git/tracked-branches.ts`** — branch-tracking storage powering `--all`.

---

## Decisions

- **`sp rebase` is the home for fetch + rebase.** `sp sync` never rebases (see below). Fetch-before-anything moved from `main`'s sync into `sp rebase`.
- **`sp sync` never rebases.** Push-only. This applies to `sp sync`, `sp sync --open`, and `sp sync --all` — none of them rebase, ever.
- **`sp sync` fails when the stack is behind.** Exits with an error telling the user to run `sp rebase`. No partial work, no continue-anyway flag. We can do something smarter in the future.
- **`sp sync --all` is push-only.** Same rule: no rebase step per branch. Cannot be combined with `--open`.
- **`sp land` was redesigned, not ported.** `main`'s land merged PRs via the GitHub merge API (`--all` merged the stack bottom-up, waiting on each merge). This branch instead retargets every in-scope PR to trunk and does a single fast-forward push of trunk to the target tip. It never uses the merge API. `--all` is replaced by `--through <id>` (whole stack = through the top unit). "Behind trunk" surfaces as a fast-forward rejection pointing at `sp rebase`.
- **`sp land` cleans up after itself; `sp clean` is the recovery tool.** Because land ff-pushes the exact commits it landed, it knows its scope deterministically — so it scrubs the landed units' PR-cache entries and group records on every land, with no detection needed. Remote-branch deletion is opt-in via `spry.autoDeleteOnLand` (default off), because some repos already auto-delete head branches on merge. `sp clean` is the manual reaper for branches land left behind (flag off) or branches merged through the GitHub UI.
- **`sp clean` detects "landed" as ancestor-of-trunk only.** `git merge-base --is-ancestor <branchTip> <remote>/<trunk>`. No `Spry-Commit-Id` trailer matching, no squash/rebase-merge heuristics, no `--unsafe`/`--force` modes from `main`. A GitHub merge-commit or `sp land`'s ff-push both leave the branch reachable from trunk and so are reaped; a GitHub squash- or rebase-merge (new SHAs) is intentionally **not** reaped by this simple version. clean fetches with `--prune` and treats an already-gone branch as benign, so it's idempotent.
- **`sp land` does not rebase.** A pre-land auto-rebase was rejected: it would risk reordering/altering the stack underneath the land logic. A post-land rebase is unnecessary — land's ff-push moves the local `<remote>/<trunk>` up to a commit already on the stack, so `getStackCommits` immediately resolves to just the unlanded units; the local branch is already correctly based and no working tree is touched. Rebasing remains `sp rebase`'s job.

---

## Resolved design notes (modules from the original gap)

The original roadmap listed internal modules from `main` that "don't exist here." Where they landed:

| `main` module                 | Resolution on this branch                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/git/behind.ts`           | **Built** (different surface: `isStackBehindTrunk[ForBranch]`, `fetchRemote`).                                                         |
| `src/git/conflict-predict.ts` | **Folded in.** Conflict prediction is a dry-run `rebasePlumbing` in `src/git/plumbing.ts` + `src/git/conflict.ts`; no separate file.   |
| `src/git/trailers.ts`         | **Built** as `src/parse/trailers.ts`.                                                                                                  |
| `src/tui/open-select.ts`      | Covered by `src/tui/select.ts`.                                                                                                        |
| `src/tui/pr-adopt-select.ts`  | Covered inline in `src/commands/group.ts` + `src/tui/select-one.ts`.                                                                   |
| `src/git/pr-detection.ts`     | **Not needed.** `sp clean` uses an inline `merge-base --is-ancestor` check; `sp land` knows its own landed scope. No detection module. |
| `src/git/group-rebase.ts`     | Not needed so far — group structure rides on `refs/spry/groups`, not commit rewrites.                                                  |
| `src/git/remote.ts`           | Not needed as a unit — sync status comes from `tracked-branches` + `gh` lookups.                                                       |
