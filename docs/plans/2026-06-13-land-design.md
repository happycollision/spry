# `sp land` — Design

## Purpose

`sp land` merges work into trunk by **fast-forwarding `origin/<trunk>` to a
commit tip**, rather than merging each PR through the GitHub API (which is how
`main` does it). Because a spry stack is a linear chain of commits on top of
trunk, "merge" is just moving the trunk ref forward to a commit that already
sits on top of it.

Landing is always **bottom-up and contiguous** — you land everything from the
bottom of the stack _through_ a chosen point. That single "through" concept
subsumes the old bottom-only and whole-stack modes:

- **`sp land --through <id>`** — land from the bottom **through** the unit
  identified by `<id>`: ff trunk to that unit's tip. `<id>` is a **spry group
  ID** when the target commit is grouped, or a **plain spry commit ID** (or
  commit-hash prefix) when it isn't. Landing the whole stack = `--through` the top
  unit; landing just the bottom = `--through` the first unit.
- **`sp land`** (no args) — a TUI to pick the "through" point interactively, then
  runs the exact `--through` path under the hood with the chosen unit's ID.

The contiguous-from-bottom constraint is inherent to ff: you can only advance
trunk to a commit whose ancestors are already on trunk. There is no "land only a
middle PR" — that's not expressible as a fast-forward, and it's not a goal.

## The core idea: retarget-all, then fast-forward

Land in two moves, no GitHub merge API:

1. **Retarget every PR in the landed scope to trunk** (`base = <trunk>`).
2. **One non-force fast-forward push** of the tip SHA to trunk:
   ```
   git push <remote> <tip-sha>:refs/heads/<trunk>     # no --force
   ```

Why this exact order is the whole game (see "Race avoidance" below): GitHub marks
a PR **MERGED** — not **CLOSED** — when its head commits land in **its own base
branch**. If we make every PR's base trunk _first_, then ff trunk past all their
heads, every PR's head is now contained in its base. GitHub marks each one merged
directly. No inference by SHA-containment across stacked bases, no merge API, no
sleep.

A non-force push to an existing remote branch is fast-forward-only by definition,
which also gives us the behind-check for free:

- **Stack is current** → clean fast-forward; the exact SHAs land in trunk.
- **Stack is behind trunk** → git rejects the push as non-fast-forward. That is
  precisely the "rebase first" signal. `pushBranch` already classifies
  `rejected.*non-fast-forward` as `reason: "stale-ref"`, so we map that to a
  "stack is behind `<trunk>`, run `sp rebase`" message and exit non-zero. No work
  is done, nothing is half-landed.

This is why `sp sync` not having a behind-check (deferred per the roadmap) is
fine for `land`: the ff push is the behind-check, at the exact moment it matters.

## Race avoidance — why not jaspr's way

git-jaspr (`GitJaspr.kt` `merge()`) uses the same ff push, but only retargets the
**top** PR of the merge scope to trunk; the **middle** PRs keep their stacked
bases (each based on the previous commit's branch, which never advances). It then
relies on GitHub _inferring_ those middle PRs are merged by SHA-containment, and
papers over the timing with a fixed `delay(2_000)` before deleting branches. Its
own comment admits the failure mode: _"if we delete the branches too quickly, GH
will show them as closed instead [of merged]."_ That inference + blind-sleep is
the long-standing "intermediaries show as closed" bug.

spry `main` avoided it differently — by **not** using ff at all: it merged each PR
through the GitHub **merge API** (which sets `MERGED` directly) and polled
`waitForPRState(MERGED, 30000)` instead of sleeping. Correct, but it gives up the
ff model.

Our approach keeps ff **and** removes the inference jaspr depends on: **retarget
_every_ landed PR to trunk before the push.** With every base already trunk, the
ff push makes every head contained in its own base → every PR merges, none can be
inferred-wrong. Two further decisions harden it:

- **`sp land` never deletes remote branches.** The jaspr race is fundamentally a
  _branch-deletion-timing_ problem; if land never deletes, no intermediary can be
  force-closed by a premature deletion. Cleanup is `sp clean`'s job.
- **`sp clean` polls for `MERGED` before deleting** (main's deterministic wait,
  not jaspr's fixed sleep). Handed off as a `sp clean` requirement, out of scope
  here.

Order matters: retarget **first**, ff **second**. If the ff push fails (e.g. a
late behind-trunk rejection), the PRs are left pointed at trunk — recoverable, and
the next `sp sync` re-derives correct stacked bases via `retargetMismatched`.

## Scope and decisions

- **Land = retarget-all-to-trunk, then ff push. No GitHub merge API.** Preserves
  SHAs and makes "behind trunk" a natural push rejection. The retarget-first step
  is what makes GitHub mark every PR merged (not closed) — see Race avoidance.
- **`sp land` runs the full sync code path first.** Landing requires the remote
  branches and PR status to be current. `land` invokes `syncCommand` directly —
  the complete path, nothing lighter — for its side effects (push branches,
  retarget, refresh PR cache), then reads **live** PR status for the unit(s) it
  is about to land. `syncCommand` `process.exit`s on failure, and that's the
  intended behavior: if something substantial changed out from under us, we fail
  rather than land on a stale or failed publish.
- **Branch protection is the real safety net; readiness checks are advisory UX.**
  The repo's own merge rules prevent a bad merge — the ff push to a protected
  trunk is server-rejected if the contained PRs aren't actually mergeable. So our
  readiness gate is there to fail _early and legibly_, not to be authoritative.
  This is why `checksStatus: none` / `reviewDecision: none` are not blockers: a
  repo with no required checks has decided it doesn't need them.
- **Readiness blocks; unresolved comments only prompt.** See the policy table
  below. Failing/pending checks and requested/required review **abort**.
  Unresolved review threads **prompt for confirmation** (your explicit ask).
- **No remote branch deletion in `land`.** Orphaned remote spry branches are
  `sp clean`'s job (next roadmap item). `land` leaves them; the PRs are already
  marked merged by GitHub. `sp clean` must poll for `MERGED` before deleting.

## Readiness policy (proposed — needs sign-off)

Evaluated per PR from live `PRInfo` (`src/gh/pr.ts` already exposes all three):

| Signal                                                                  | `PRInfo` field                           | Effect      |
| ----------------------------------------------------------------------- | ---------------------------------------- | ----------- |
| Checks failing                                                          | `checksStatus === "failing"`             | **Abort**   |
| Checks still running                                                    | `checksStatus === "pending"`             | **Abort**   |
| Changes requested                                                       | `reviewDecision === "changes_requested"` | **Abort**   |
| Review required (and not yet given)                                     | `reviewDecision === "review_required"`   | **Abort**   |
| Unresolved review threads                                               | `reviewThreads.resolved < total`         | **Confirm** |
| Checks `none`/`passing`, review `approved`/`none`, threads all resolved | —                                        | **Land**    |

- `checksStatus === "none"` (no CI configured) is **not** a blocker — many repos
  have no checks. Same for `reviewDecision === "none"` (no review required).
- **Every** open PR in the landed scope (bottom **through** the target) must pass
  the abort gate before anything is pushed; unresolved threads across any of them
  roll up into a single confirmation prompt. We compute readiness for the whole
  scope up front, then do one ff push — never a partial land. PRs _above_ the
  target are untouched.

## Flow

There is one real code path — `landThrough(throughId)`. The no-arg command is a
thin TUI wrapper that resolves a `throughId` and calls it.

### `sp land --through <id>` (the one path)

1. `loadConfig`.
2. **Run the full sync** (`syncCommand(ctx, {})`) — pushes branches, retargets,
   refreshes PR cache. It `process.exit`s on failure (intended).
3. Parse the stack (same machinery as sync: `injectMissingIds` →
   `getStackCommits` → `parseCommitTrailers` → `parseStack`, including group
   records so grouped units resolve). Empty stack → `✓ No commits in stack`,
   return.
4. **Resolve the scope** with `resolveUpTo(id, units, commits)` — returns the set
   of unit IDs from the bottom **through** the target unit (group ID, unit-ID
   prefix, or commit-hash prefix all resolve via `resolveIdentifier`).
   - Resolution error → `formatResolutionError`, exit 1 (not-found / ambiguous).
   - The **landed scope** = units whose ID is in that set; the **target unit** is
     the last one in the scope (stack order); the **tip** is
     `targetUnit.commits.at(-1)`.
5. Fetch **live** PR status for the scope's branches in one `findPRsForBranches`.
   - Any unit in the scope with no open PR → error: it isn't published; can't
     land through it. Point to `sp sync --open`.
6. Apply the readiness gate to **every** PR in the scope. Abort signals → report
   which PR and why, exit 1. Unresolved threads across the scope → one
   confirmation prompt; "no" → exit 0 without landing.
7. **Retarget every PR in the scope to trunk** whose base isn't already trunk
   (`retargetPR`, `base = config.trunk`). Must happen **before** the push (the
   secret sauce). A retarget failure here aborts before the push — never ff with
   an un-retargeted middle PR.
8. **One ff push** to the tip:
   `pushBranch({ remote, sha: tip, branch: config.trunk, forceWithLease: false })`.
   - `ok` → `✓ Landed N PR(s) to <trunk>`.
   - `reason: "stale-ref"` → "stack is behind `<trunk>`; run `sp rebase`", exit 1.
   - `reason: "rejected"` (other) → print stderr, exit 1.
9. **Downstream:** units _above_ the scope keep their stacked bases (the lowest of
   them is now based on a landed branch). We **defer** their retarget to the next
   `sp sync`: it drops the landed units, the next unit becomes the bottom, and
   sync retargets it to trunk. Because `land` deletes no branches, nothing above
   the scope can be closed in the meantime. Print a hint to run `sp rebase`/`sync`
   (clean up local state) and `sp clean` (remove merged remote branches).

### `sp land` (no args) — the TUI wrapper

1. Resolve config + parse the stack (steps 1, 3 above) so the picker has units.
   (Sync still runs inside `landThrough`; the picker just needs the unit list —
   decide whether to sync before or after the pick. Proposed: pick **first** so a
   cancel does no work, then `landThrough` runs sync.)
2. **Single-select TUI** over the units, bottom→top, one cursor position = the
   "through" point. Show unit ID + title; a group renders as one row.
   - Cancel → `Cancelled.`, exit 0.
3. Call `landThrough(selectedUnit.id)`.

## New / changed code

- **`src/commands/land.ts`** (new) — `landCommand(ctx, { through?: string; cwd? })`.
  `through` set → `landThrough`; unset → run the TUI picker then `landThrough`.
- **`src/cli/index.ts`** — register `land` with `--through <id>` (string-valued).
- **`src/tui/`** — a **single-select** picker (`selectUnit`?). `selectUnits` is
  multi-select with toggles; the through-point is one cursor position + Enter, so
  this is a new (simpler) component. Must be test-friendly like `selectUnits`
  (programmable selection under the harness).
- **Reuse, don't reinvent:**
  - `resolveUpTo` / `resolveIdentifier` / `formatResolutionError` — the "through"
    scope resolution already exists; bind `--through` straight to it.
  - `syncCommand` for the pre-land publish.
  - `pushBranch` with `forceWithLease: false` for the ff push (the only genuinely
    new git interaction — verify it surfaces non-ff as `stale-ref`).
  - `findPRsForBranches` for live status; `PRInfo` for readiness.
  - `retargetPR` for the retarget-to-trunk step.
  - `branchForUnit`, `parseStack`, `getStackCommits`, group records — from sync's
    flow.
- **Confirmation prompt** — need a small interactive yes/no for unresolved
  threads. Check whether `src/tui/` already has a confirm helper before adding
  one; must be test-friendly.

## Edge cases

- **`<id>` not found / ambiguous** — surfaced by `resolveIdentifier` via
  `formatResolutionError`; exit 1 with the matches listed.
- **`<id>` resolves to a grouped commit** — `resolveIdentifier` maps it to the
  group unit; the group lands as a whole (you can't land through _part_ of a
  group — same reason as the split-group rule). Giving the group ID and giving any
  member commit's ID resolve to the same unit.
- **No open PR for a unit in the scope** — `land` does not open PRs. Error and
  point to `sp sync --open`.
- **Detached HEAD** — `land` needs a current branch like sync's single path;
  reject with the same message as sync.
- **Dirty working tree** — `requireCleanWorkingTree` (sync already enforces this;
  land inherits it via the sync call, but should also guard before doing its own
  push).
- **PR shows CLOSED instead of MERGED** — the jaspr failure mode. Prevented by
  retargeting every PR to trunk before the ff push (so each head lands in its own
  base) and by deleting no branches in `land`. Covered by the integration
  regression test.
- **`reviewThreads` capped at 100** in the GraphQL query — fine for the
  confirmation heuristic; note it.

## Resolved decisions

- **Command shape** — `--all` is replaced by `--through <id>` (group ID or plain
  spry/commit ID). No-arg `sp land` is a single-select TUI that picks the through
  point and calls the same path. "Through the top unit" = land the whole stack.
- **Above-scope retarget** — defer to next `sp sync` (land deletes no branches, so
  nothing above the landed scope can be closed in the interim).
- **Readiness gate is soft / advisory.** `checksStatus: none` and
  `reviewDecision: none` are **not** blockers — repo branch protection is the
  authoritative gate. Keep the soft policy; do **not** require approval the way
  jaspr does.
- **"Run a sync" = full sync path.** Call `syncCommand` directly; let it
  `process.exit` on failure. Nothing lighter.

## Open questions (for sign-off)

- **Pending checks** — abort (proposed) or prompt? Leaning abort: a `pending` PR
  isn't done, and the ff push would likely be server-rejected anyway, so failing
  early is cleaner. (Lowest-stakes remaining call; default to abort unless you
  say otherwise.)

## Testing

- `tests/commands/land.test.ts`:
  - `--through <first-unit>` lands only the bottom PR; trunk advances to its tip.
  - `--through <top-unit>` lands the whole stack in one push to the stack tip.
  - `--through <middle-unit>` lands the bottom-through-middle scope; units above
    are untouched (not retargeted, not landed).
  - `--through <group-id>` and `--through <member-commit-of-that-group>` resolve
    to the same scope and land identically.
  - every PR in the scope is retargeted to trunk **before** the push (assert
    retarget calls precede the push); a retarget failure aborts before pushing.
  - behind-trunk → non-ff rejection → "run `sp rebase`", exit 1, nothing pushed.
  - readiness gate: failing checks / pending / changes-requested / review-required
    each abort with the right reason.
  - unresolved threads → confirmation prompt; decline = no land, accept = land.
  - unknown / ambiguous `<id>` → resolution error, nothing landed.
  - a unit in the scope with no open PR → actionable error.
  - no-arg TUI: selecting a unit drives the same `--through` path; cancel does
    nothing.
- `tests/commands/land.doc.test.ts` — required by `CLAUDE.md`; doc test covering
  `sp land --through <id>` and the no-arg picker output.
- Integration (`test:github`): the race regression — after retarget-scope + ff
  push, **every** PR in the landed scope reports `MERGED`, none `CLOSED`. This is
  the jaspr failure mode we're explicitly guarding against.

## Out of scope (for now)

- **Landing a non-contiguous / single middle PR** — not expressible as a
  fast-forward; `--through` is always bottom-up and contiguous.
- **Remote branch cleanup** — `sp clean`.
- **Rebasing / local stack cleanup after land** — `sp rebase`.
- **Waiting/polling for not-yet-ready PRs** — `land` is fire-once; if a PR isn't
  ready, it aborts (or prompts for threads). A `--wait` flow can come later.
