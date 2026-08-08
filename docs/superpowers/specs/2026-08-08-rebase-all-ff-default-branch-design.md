# `sp rebase --all` fast-forwards the local default branch

## Problem

`sp rebase` operates on spry stack branches — branches with commits ahead of
`<remote>/<trunk>` that get replayed onto a freshly-fetched trunk. The local
default branch (`config.trunk`, e.g. `main`) is not a stack branch: it normally
has **no** commits of its own, it just trails `<remote>/<trunk>` after a fetch.

Today neither `sp rebase` nor `sp rebase --all` touches the local default
branch. So after `sp rebase --all` fetches and advances `origin/main`, the
user's local `main` is left behind, and they need a separate manual
`git fetch`/fast-forward to catch it up.

## Goal

Treat the local default branch as an implicit spry branch **only** during
`sp rebase --all` — same fetch, same behind-check, same loop — differing at the
one structurally-forced point: a branch with no commits of its own cannot
replay, so it **fast-forwards** to `<remote>/<trunk>` instead.

Bare `sp rebase` is **unchanged**.

## Behavior

### Bare `sp rebase` — no change

On the default branch, its stack (`<remote>/<trunk>..main`) is empty, so it
reports "Already up to date" / "No commits in stack" and rewrites nothing, exactly
as today. This spec does not alter the single-branch path at all.

### `sp rebase --all`

- The configured default branch (`config.trunk`) is an **implicit** member of
  the branch set on every run, whether or not it appears in
  `refs/spry/local/tracked-branches`. Nothing is written to the tracked store
  for it — it is re-injected implicitly next run.
- It flows through the **same** per-branch logic as any tracked branch:
  exists-locally check → `isStackBehindTrunkForBranch` → get stack commits.
- **Behind + zero stack commits** (the default branch's normal trailing state)
  → **fast-forward** it to `<remote>/<trunk>`:
  - `finalizeRewrite` when it is the checked-out branch (updates ref **and**
    working tree),
  - `updateRef` otherwise (ref only).
- **Not behind** → "✓ already up to date", same as any branch.
- **Behind + has commits** (someone committed directly on local `main`) → it
  replays those commits exactly like any other stack. No special-casing.

## Key insight

For the default branch, "behind" is already detected correctly by the existing
check: `merge-base main origin/main` is local `main`'s SHA (main is an ancestor
of origin/main), which ≠ `origin/main`'s SHA, so `isStackBehindTrunkForBranch`
returns `true`. But `getStackCommitsForBranch` logs `origin/main..main`, which is
**empty**, so control currently falls into the `commits.length === 0` "no commits
in stack" skip. **That skip is exactly where the fast-forward belongs.**

## Implementation

All changes are in `rebaseAllCommand` in `src/commands/rebase.ts`.

1. **Inject the default branch implicitly.** Iterate over
   `[config.trunk, ...tracked]`, de-duplicated (guard against `main` also being
   present in the tracked store).

2. **Fast-forward in the empty-stack branch.** In the `commits.length === 0`
   arm, split on "is this branch behind?":
   - behind + empty → fast-forward to `trunkRef` (= `<remote>/<trunk>`) using the
     existing current-branch-vs-background dispatch (`finalizeRewrite` for the
     checked-out branch, `updateRef` otherwise). The expected-old-SHA is the
     branch's current tip; the new SHA is `getFullSha(trunkRef)`.
   - not behind + empty → keep today's "✓ no commits in stack" message.

   Because the behind-check runs *before* the commit fetch in the loop, a branch
   that is not behind never reaches the FF path; and a real stack branch that is
   behind always has commits, so it never reaches the empty-stack arm. The FF
   therefore fires only for a branch that is genuinely behind with nothing to
   replay — in practice, the default branch.

3. **Keep the default branch out of the persisted store.** Do not push
   `config.trunk` into `stillTracked` solely because it was injected. (If it was
   *already* in the tracked list, existing behavior is preserved: it is visited
   once — the de-dup — and its membership persists as before.)

## Scope guard

The fast-forward fires only when `isStackBehindTrunkForBranch` is true **and**
the stack is empty. This narrowly targets the trailing-default-branch case and
never silently fast-forwards a normal stack branch (which always has commits when
behind).

## Error handling

`rebaseAllCommand` already begins with `requireCleanWorkingTree`, so
fast-forwarding the checked-out default branch via `finalizeRewrite` is safe.
`updateRef`/`finalizeRewrite` pass the expected-old-SHA for lease safety. A
failed fast-forward is reported per-branch and sets `hadFailure`, so the loop
continues and the command exits non-zero — same shape as a conflict.

## Testing

New tests in `tests/commands/rebase.test.ts`:

1. `--all`, checked-out `main` behind `origin/main` → local `main`
   fast-forwarded to `origin/main`; working tree updated.
2. `--all`, `main` behind while a **different** stack branch is checked out →
   local `main` fast-forwarded (ref only); working tree untouched.
3. `--all`, `main` already equal to `origin/main` → "already up to date"; no ref
   change.
4. `--all`, `main` behind **and** a real stack branch also behind → both handled
   in one run.
5. Bare `sp rebase` on `main` → unchanged no-op (regression guard).

Doc test (`rebase.doc.test.ts`) updated only if the output surface changes.
