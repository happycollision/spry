# `sp sync --all` — Design

## Purpose

`sp sync --all` is the publish half of the multi-stack workflow. Spry tracks
multiple independent stacks (in `refs/spry/local/tracked-branches`). After
`sp rebase --all` rewrites every tracked stack onto the new trunk, every remote
branch is stale. `sp sync --all` publishes all of them in one command, instead
of checking out each stack and running `sp sync` individually.

Its value scales with the number of independent stacks in flight. For a
single-stack user, plain `sp sync` already covers the current stack.

## Scope and decisions

- **Push-only, across all tracked stacks.** No rebase, ever — same rule as
  `sp sync`.
- **No behind-check.** Single-branch `sp sync` does not check whether a stack is
  behind trunk today, and `--all` matches that. The roadmap's "fail when behind"
  decision is deferred uniformly for both `sp sync` and `sp sync --all`, to be
  revisited as its own task.
- **Mutually exclusive with `--open`.** `--all` is a non-interactive, push-only
  loop; `--open` is interactive and per-stack. `sp sync --all --open` is
  rejected with a clear error.
- **No checkout.** The working tree never moves. All off-HEAD work is done via
  plumbing, mirroring `sp rebase --all`.

## Module changes

### 1. `src/git/rebase.ts` — off-HEAD ID injection

`injectMissingIds` currently reads commits from HEAD (`getStackCommits`) and
applies the rewrite via `finalizeRewrite` (which moves the working tree). That
makes it unusable for a branch that isn't checked out.

Split it, mirroring the existing `getStackCommits` / `getStackCommitsForBranch`
and `rebasePlumbing` / `finalizeRewrite` patterns:

- `injectMissingIds` (current branch) — unchanged behavior. Reads
  `getStackCommits`, applies via `finalizeRewrite`.
- `injectMissingIdsForBranch(branch)` — reads
  `getStackCommitsForBranch(branch, trunkRef)`, applies via `updateRef` (ref
  only; working tree untouched).

The rewrite machinery itself (`rewriteCommitChain`) is pure plumbing — verified
to contain no HEAD/checkout/read-tree/reset — and is shared by both appliers.

### 2. `src/commands/sync.ts`

- Add `all?: boolean` to `SyncOptions`.
- When `all` is set, branch to a new `syncAllCommand`.
- Reuse existing helpers: `pushExistingBranches`, `retargetMismatched`.

### 3. `src/cli/index.ts`

- Add the `--all` option to the `sync` command.
- Reject `--all --open` with a clear error before doing any work.

## `syncAllCommand` flow

1. `requireCleanWorkingTree`.
2. **Once:** fetch group records (`fetchGroupRecords`) and PR cache
   (`fetchPRCache`); `listRemoteBranches`. These are remote/global reads — done a
   single time, not per branch.
3. Register the current branch (skip if detached HEAD); load tracked branches.
   If the list is empty → print `✓ No tracked branches` and return.
4. **Per branch** (output prefixed with the branch name, like `sp rebase --all`):
   - `rev-parse --verify refs/heads/<branch>` — if the branch no longer exists
     locally, print `<branch>: removed (branch no longer exists)`, prune it
     (omit from `stillTracked`), and skip.
   - Otherwise add to `stillTracked`.
   - Inject missing IDs: `finalizeRewrite` path if this is the current branch,
     otherwise `injectMissingIdsForBranch` (ref-only).
   - Compute units: `getStackCommitsForBranch` + `parseCommitTrailers` +
     `parseStack`, using the already-loaded group records. On parse failure,
     report it for that branch, mark a failure, and continue to the next branch.
   - Push existing branches via `pushExistingBranches`. Accumulate
     `{ units, pushedBranches }` for the post-loop phases.
5. **Once, after the loop:** batch `findPRsForBranches` over _all_ branch names
   across all stacks → a single `prMap`.
6. **Per stack:** `retargetMismatched(units, pushedBranches, prMap)` using the
   shared `prMap`. Retarget must stay per-stack because the expected base
   depends on each stack's unit ordering.
7. **Once:** build a _single combined_ `PRCache` from every stack's units +
   `prMap`, then `savePRCache` + `pushPRCache`.
8. `saveTrackedBranches(stillTracked)`.
9. If any branch failed, exit 1; otherwise print `✓ Sync complete`.

### The PR-cache clobber fix

`savePRCache(cache)` **replaces** the entire cache tree — it does not merge with
what is already stored. The single-branch `writePRCache` builds a fresh cache
object from only its own stack's units. Calling that per branch in a loop would
make each branch clobber the previous branch's entries.

`PRCache` is keyed by globally-unique unit IDs (Spry-Commit-Ids, no slashes), so
the fix is to accumulate entries from every stack into one cache object and call
`savePRCache` + `pushPRCache` exactly once, after the loop.

## Edge cases

- **Detached HEAD:** allowed for `--all` — there is no current branch to
  register, matching `sp rebase --all`.
- **Stack with no remote branches yet** (never opened via `--open`): the push
  phase only pushes branches that already exist remotely, so such a stack is
  simply skipped. `--all` does not open PRs.
- **Off-HEAD inject:** must leave the working tree and `HEAD` untouched for every
  branch that is not the current branch.

## Testing

- `tests/commands/sync.test.ts`:
  - multi-stack push across several tracked branches;
  - pruning a tracked branch that no longer exists locally;
  - `sp sync --all --open` is rejected;
  - **combined PR cache across stacks (no clobber)** — entries from every stack
    survive;
  - off-HEAD inject leaves the working tree and `HEAD` untouched.
- `tests/commands/sync.doc.test.ts`: doc test for `sp sync --all` output
  (required by `CLAUDE.md` — every user-facing command needs a doc test).

## Out of scope

- Rebasing (use `sp rebase` / `sp rebase --all`).
- Behind-check / fail-when-behind (deferred for both `sp sync` and
  `sp sync --all`).
- Opening new PRs in bulk (`--open` remains per-stack and interactive).
