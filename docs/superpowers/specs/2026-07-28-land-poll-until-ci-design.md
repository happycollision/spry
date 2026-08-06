# `sp land --poll` — wait for CI, then auto-land

## Problem

`sp land` gates on PR readiness once. If CI is still running, it fails with
"not ready — run `sp sync`" and the user must come back and re-run land after CI
finishes. We want land to be able to **watch** CI and complete (or fail)
automatically when it resolves — and to do so robustly enough that the user can
keep working (switch branches, commit, rebase their local stack) while the wait
runs.

Concretely, this scenario must work:

1. User invokes `sp land --poll`.
2. User switches branches (or commits, or rebases their local stack).
3. CI completes passing.
4. Land completes successfully, pushing the commits it resolved at step 1 —
   despite the working tree having moved.

## Threat model (scope)

**Working-tree drift only.** We protect the land against the user changing what
is checked out while CI runs. We do **not** protect against process death: if
the terminal closes or `sp land --poll` is Ctrl-C'd, the wait is abandoned and
the user re-runs it. No daemon, no on-disk resumable state. This keeps the whole
feature in-process.

The thing we are protecting is **the push** (and the poll targets). The design
guarantees that once the plan is frozen at invocation time, nothing in the wait
loop or the final push reads `HEAD` or the working tree.

## Why this is safe: the frozen plan

`sp land` today resolves the stack from `HEAD` via `getStackCommits`
(`git log <mergeBase>..HEAD`, `src/git/queries.ts:91`) — inherently tied to the
current checkout. But everything land needs _after_ resolution is
working-tree-independent:

- The **push** is `pushBranch({ sha: <tip>, branch: <trunk>, forceWithLease:
false })` (`src/commands/land.ts:100`) — an explicit SHA to an explicit remote
  branch, pure git plumbing. It never reads `HEAD`.
- The **poll** needs only PR state per branch, via
  `findPRsForBranches(scopeBranches)` (`src/gh/pr.ts:344`) — a lookup by branch
  name against GitHub. It never reads `HEAD`.

So the design **freezes a plan** at invocation (while the working tree is still
trusted) and the wait loop + push consume only that plan:

```
interface LandPlan {
  tip: string;            // SHA to fast-forward trunk to
  trunk: string;          // config.trunk
  scopeUnitIds: Set<string>;
  scopeBranches: string[];      // branchForUnit(u) for each in-scope unit, in order
  prNumbersAtPlanTime: Map<string, number>; // branch -> PR number known at plan time
}
```

After the plan is frozen, checking out another branch, committing, or rebasing
the local stack cannot change `tip`, `trunk`, or `scopeBranches`. We push the
exact SHA we resolved; GitHub marks the in-scope PRs MERGED by reachability from
the default branch exactly as bare `sp land` does (see rebuild-roadmap: land
relies on default-branch reachability, not PR base).

## Command surface

```
sp land [--through <id>] [--poll] [--interval <sec>]
```

- `--poll` — after resolving the plan, watch PR readiness and land when the
  scope is green (or fail fast on a hard blocker). Composes with `--through` and
  with the bare picker exactly as land does today: `--poll` alone still resolves
  scope via the picker first.
- `--interval <sec>` — poll cadence, default **30**. Only meaningful with
  `--poll` (or after accepting the interactive nudge). No overall timeout: the
  loop runs until the scope resolves green, a hard blocker appears, or the user
  Ctrl-C's.

CLI wiring in `src/cli/index.ts`: add `.option("--poll", ...)` and
`.option("--interval <sec>", ...)`, parse `interval` to a number, pass
`{ through, poll, interval }` into `landCommand`.

## Flow

### Phase 1 — freeze the plan (the only read of `HEAD`)

Unchanged from today up through scope resolution:

1. `checkSync` → units, commits, prCache (`src/commands/land.ts:30`).
2. Resolve `--through`, or run the picker **now** while the user is present
   (`defaultPickThrough`). This is deliberately kept in the working-tree-trusted
   phase.
3. Resolve `scope`, `scopeUnits`, `target`, `tip` as today.
4. Run `analyzeStack` + `landBlockers` **once** to get the up-front verdict
   (structural flags + PR readiness).
5. Run the unresolved-review-threads confirm **now** while the user is present
   (`src/commands/land.ts:84`). The result ("user already said land-anyway") is
   remembered; the wait loop never re-prompts for it.
6. Freeze the `LandPlan` from `scopeUnits`, `tip`, `config`.

### Phase 2 — the readiness decision

This is where bare-land and `--poll` diverge, driven by the phase-1 verdict.

Define a helper that classifies the current blocker set for the scope:

```
type ScopeVerdict =
  | { kind: "ready" }                        // no blockers — land now
  | { kind: "ci-pending"; prNumbers: number[] } // ONLY blocker is CI still running
  | { kind: "hard"; perUnit: UnitBlockers[] }    // a non-pollable blocker exists
```

Classification rule (pure, over `landBlockers` output for the scope):

- `ready`: `landBlockers` reports nothing.
- `ci-pending`: every blocking reason across the scope is _exclusively_ "CI
  checks are still running" (i.e. `pr.checksStatus === "pending"` with no other
  reason on any unit, and no missing/mis-targeted/unpushed/missing-id/
  changes-requested/review-required/failing-CI). This is the **only** state
  where polling can help.
- `hard`: anything else — CI failing, changes requested, review required, a
  closed/missing PR, or a structural flag. Polling cannot clear these.

Note the mixed case is `hard`, not `ci-pending`: if a unit has CI pending **and**
changes requested, waiting on CI is pointless because the review still blocks.
We only offer/continue polling when CI is the _sole_ obstacle.

Bare `sp land` (no `--poll`):

- `ready` → land immediately (today's behavior).
- `hard` → print the per-unit blockers and exit non-zero (today's behavior,
  `src/commands/land.ts:73`).
- `ci-pending` → **new**: surface `--poll` availability (see Phase 2a), instead
  of today's generic "not ready" error.

`sp land --poll`:

- `ready` → land immediately (no reason to loop).
- `hard` → same fail-fast as bare land. `--poll` does not wait out a hard
  blocker.
- `ci-pending` → print the polling banner and enter the wait loop (Phase 3).

### Phase 2a — `--poll` availability nudge (bare land, `ci-pending` only)

When bare `sp land` finds `ci-pending` as the sole blocker:

- **Interactive shell** (`process.stdin.isTTY` truthy): prompt
  `Would you like to poll until CI passes, then auto-land? [Y/n]`.
  - **Yes** (default on empty) → continue **in-process** into the Phase-3 wait
    loop using the already-frozen plan and the default interval (30s, since no
    `--interval` was parsed on a bare invocation). No re-invocation, no
    re-resolving scope.
  - **No** → exit non-zero with a short "Not landed; CI still running." message.
- **Non-interactive shell** (no TTY): print the exact copy/paste re-invocation
  and exit non-zero:
  `Run \`sp land --through <id> --poll\` to wait for CI and land automatically.`The`<id>` is reconstructed from the resolved scope's top unit id (`target.id`)
so the printed command reproduces *this* land. If land was already invoked with
an explicit `--through`, echo that same id.

The interactive prompt reuses the injectable `confirm` seam already on
`LandOptions` (so tests drive it). TTY detection is read through an injectable
predicate (default `() => process.stdin.isTTY === true`) so both branches are
testable without a real terminal.

### Phase 3 — the wait loop (working-tree-independent)

Entered from either `sp land --poll` or an accepted interactive nudge. Both
converge on one loop with one banner.

1. Print the banner once:
   `⧗ CI pending on #<n>[, #<n>…]; polling every <interval>s (Ctrl-C to stop)…`
2. Loop:
   a. `findPRsForBranches(plan.scopeBranches)` — fresh PR state, by branch name.
   b. Build `prByBranch`, then re-run `evaluateReadiness` over the scope
   (`src/commands/land-readiness.ts:22`). **Only PR-derived readiness is
   re-evaluated** — the structural flags (missingId/unpushed/misTargeted) are
   frozen from Phase 1, because they cannot change without a working-tree
   edit we are explicitly choosing to ignore.
   c. Classify with the same `ScopeVerdict` rule:
   - `ready` → break, proceed to land (Phase 4).
   - `hard` → print the newly-appeared blocker(s) and exit non-zero
     (fail-fast: CI turned failing, a PR was closed/merged out from under us,
     or a review flipped to changes-requested).
   - `ci-pending` → print a dim progress line
     (`  …still pending (checked <hh:mm:ss>)`), `sleep(interval)`, repeat.
     d. Unresolved review threads that appear _after_ Phase 1 are advisory only —
     a dim note, never a blocker and never a new prompt (the land-anyway
     decision was made up front). Threads already confirmed in Phase 1 are
     likewise ignored.
3. A PR whose lookup returns `null` mid-loop (branch/PR vanished) is a `hard`
   blocker ("no open PR for <branch>"), consistent with `evaluateReadiness`'s
   missing rule.

`sleep` and a `now` clock are injected via `LandOptions` (defaults: real
`setTimeout` promise and `() => new Date()`), so tests advance the loop
deterministically with no real timers or wall-clock reads.

### Phase 4 — land

Identical to today (`src/commands/land.ts:99` onward): `pushBranch({ sha:
plan.tip, branch: plan.trunk, forceWithLease: false })`, the stale-ref/error
handling, the success line, and the cleanup tail (drop landed PR-cache entries,
scrub landed group records, optional `autoDeleteOnLand` branch deletes, closing
guidance). No changes — the push already consumes only `plan.tip`/`plan.trunk`.

## Testability seams (added to `LandOptions`)

```
interface LandOptions {
  through?: string;
  poll?: boolean;
  interval?: number;              // seconds; default 30
  cwd?: string;
  confirm?: (message: string) => Promise<boolean>;   // existing
  pickThrough?: (units: PRUnit[]) => Promise<string | null>; // existing
  // new:
  isInteractive?: () => boolean;  // default: () => process.stdin.isTTY === true
  sleep?: (seconds: number) => Promise<void>;         // default: real setTimeout
  now?: () => Date;               // default: () => new Date()
  // new poll seam: allows a test to script successive PR-state responses without gh
  pollPRs?: (branches: string[]) => Promise<Map<string, PRInfo | null>>;
  // default: (b) => findPRsForBranches(ctx, b, { owner, repo, cwd })
}
```

`pollPRs` is the seam that makes the loop unit-testable offline: a test supplies
a queue of responses (pending → pending → passing; or pending → failing) and
asserts the loop lands, fails fast, or keeps polling accordingly — with a
synchronous `sleep` stub so no real time passes.

## Shared classification helper

Extract `classifyScope(analysis, prByUnitOrBranch)` → `ScopeVerdict` as a pure
function (likely in `stack-analysis.ts` alongside `landBlockers`, or a new
`land-poll.ts`). Phase 1 and each Phase-3 iteration both call it. It wraps
`landBlockers`/`evaluateReadiness` and folds the "is CI the _sole_ blocker?"
rule so bare-land, the nudge, and the loop all agree on what `ci-pending` means.
The wait loop passes frozen structural flags + fresh PR state; Phase 1 passes
both fresh.

## Testing

Per project convention, every user-facing behavior gets doc-producing tests in
`tests/commands/land.doc.test.ts` (and unit tests in `tests/commands/land.test.ts`).

Unit tests (offline, via seams — no gh, no real timers):

- `classifyScope`: ready / ci-pending (sole) / hard for each blocker kind, and
  the mixed CI-pending-plus-changes-requested → `hard` case.
- Wait loop lands when `pollPRs` transitions pending→passing.
- Wait loop fails fast when `pollPRs` transitions pending→failing (and on a PR
  going CLOSED/null, and on changes-requested appearing).
- Wait loop keeps polling (N sleeps) while pending, using a counting `sleep`
  stub.
- Bare-land nudge: interactive `isInteractive: () => true` + `confirm: yes`
  continues into the loop; `confirm: no` exits without landing; non-interactive
  `isInteractive: () => false` prints the `--through <id> --poll` command and
  does not land.
- Working-tree-drift guarantee: after freezing the plan, the loop and push use
  only `plan` fields — assert `pollPRs` is called with `plan.scopeBranches` and
  `pushBranch` with `plan.tip`, with no `getStackCommits`/`HEAD` read in between.

Doc tests: capture the `ci-pending` nudge output (interactive prompt text and
non-interactive copy/paste line) and a `--poll` banner + land sequence.

The `gh` GraphQL path is unchanged (`findPRsForBranches` is reused as-is), so no
new cassettes are required for the offline suite; the pre-merge record+playback
gate still applies to whatever land doc tests exercise real `gh`.

## Non-goals

- Surviving process death / resumable land (explicitly out of scope — see threat
  model).
- An overall timeout (`--poll` waits indefinitely by design; Ctrl-C aborts).
- Re-reading or re-resolving the stack during the wait (the plan is frozen).
- Retargeting PR bases or any new `gh` mutation (land does not retarget today).
