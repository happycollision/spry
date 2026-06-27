# Design: Real `gh` Cassettes via Deterministic Identity

**Date:** 2026-06-13
**Branch at design time:** rebuild integration branch
**Resolves:** Solo todo #18 — "Add a gh cassette injection seam to the CLI for record/replay in subprocess doc tests"

---

## Problem

Today's cassette infrastructure does **not** record real `gh` traffic, and nothing in the real
test suite uses it:

- `tests/lib/{cassette,recording-client,replaying-client}.ts` is a generic record/replay harness
  over the shared `run(args, options) => CommandResult` interface. It can wrap either a `GitRunner`
  or a `GhClient`.
- The only thing that ever exercises it is `record-replay.integration.test.ts`, which records
  `git --version`.
- Every `gh`-dependent test hand-writes a `stubGh()` returning canned `{ stdout, stderr, exitCode }`
  literals. Those literals were authored by hand, not captured from GitHub.
- `git` in tests runs live against a **local bare repo** origin (`createRepo()` in `tests/lib/repo.ts`),
  so git is already fast and deterministic; it just never talks to real GitHub.

Meanwhile `main` has a real target-repo testing concept (`tests/helpers/github-fixture.ts`,
`scripts/setup-spry-check.ts`, `SPRY_TEST_REPO_OWNER`/`SPRY_TEST_REPO_NAME`, a README safety marker,
and integration tests gated behind `GITHUB_INTEGRATION_TESTS`) that does **not** exist on this branch.

### The landmine (from todo #18, comment #3)

A previous attempt (`feat/gh-cassette-seam`, since reverted) built the _replay_ half of the seam and
then **hand-authored the gh responses** in the test, wrote them to a JSON file, and replayed them.
That is not a cassette — it is the in-process stub relocated to a file. The defining property of a
cassette is that the bytes were **recorded from the real service**. Synthetic responses are guesses;
a mismatch with GitHub's real JSON would silently produce wrong docs with no failing test (fiction
checked against fiction).

The reopened todo states the real constraint: a correct implementation must **record real `gh`
responses** (record mode against real GitHub), commit those cassettes, and replay them in the
fast/doc runs — bridging the synthetic-local-repo vs. real-GitHub gap. **Do not hand-author responses.**

---

## Goals

1. Cassettes that capture **real** `gh` traffic from the real `spry-check` repository.
2. Replay those cassettes **offline** (no network, no auth) as the default for `bun test` / CI /
   the docker suite.
3. Doc tests (`tests/commands/*.doc.test.ts`, the source of truth for `docs/generated/`) get **both**
   real-CLI coverage (subprocess through `src/cli/index.ts`) **and** realistic, deterministic gh
   output — resolving the false choice that motivated todo #18.
4. "Refresh the tapes" is a deliberate, low-friction human action.

## Non-goals

- Recording `git` traffic. `git` runs live; only `gh` is wrapped.
- Normalizing GitHub-minted values (PR numbers/URLs) — captured raw for now (see Decisions).
- Changing production behavior when no cassette env var is set.

---

## Key decisions

- **Both modes, one system.** The target repo exists primarily to record cassettes; replay is the
  default. Recording is the "refresh the tapes" mode.
- **Wrap only `gh`.** `git` always runs live. The only thing that differs between modes is what
  `origin` points at: real `spry-check` (record) vs. a local bare repo (replay).
- **Approach A — Deterministic identity, no scrubbing.** Pin commit dates + author/email + seed the
  unique-id generator so a given doc-test scenario produces byte-identical SHAs and branch names on
  every run. The local replay repo therefore reproduces the exact identifiers already embedded in the
  recorded gh responses — no scrubbing of git-side identifiers required. This is the bridge that the
  prior attempt left unsolved.
- **GitHub-minted values captured raw (option 2).** PR numbers, PR URLs, GraphQL node IDs, and
  timestamps are minted by GitHub and cannot be pinned. They are captured raw in the cassette.
  Re-recording may churn PR numbers in snapshots; that is accepted. If snapshot churn becomes painful,
  switch to normalize-on-record (rewrite to stable placeholders) later.
- **Record mode is mandatory, not optional.** The prior attempt descoped record-against-real-gh and
  that is exactly how it slid into hand-authoring. No record mode = no real cassette.
- **No hand-written response JSON, ever.** Every cassette byte comes from a real `gh` invocation
  against the real `spry-check` repo.

---

## Architecture

### Two modes, one seam

A single env-guarded seam in `src/cli/index.ts`. With no env var set, production is byte-identical to
today.

| Env                              | gh client                         | git `origin`      | Network | Cassette            |
| -------------------------------- | --------------------------------- | ----------------- | ------- | ------------------- |
| _(none)_                         | `createRealGhClient()`            | real              | yes     | —                   |
| `SPRY_GH_CASSETTE_RECORD=<path>` | recording client wrapping real gh | real `spry-check` | yes     | **written** on exit |
| `SPRY_GH_CASSETTE=<path>`        | replaying client                  | local bare repo   | no      | **read**            |

### The determinism layer

The bridge that makes a real recording replayable against a synthetic local repo. All three are
**test-only** (env vars threaded into the subprocess + a seeded helper); no production code changes.

1. **Commit dates** — fixed `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` (e.g. `2020-01-01T00:00:00Z`)
   for every commit a test creates.
2. **Commit identity** — fixed `GIT_AUTHOR_NAME`/`EMAIL` + committer (today partly done via
   `git config` in `repo.ts`; move to pinned env so it is airtight).
3. **Unique IDs** — `generateUniqueId()` becomes seedable. In test mode it draws from a seeded PRNG
   keyed **per-test** (seed derived from the test title), so branch names/commit messages are
   reproducible run-to-run.

Result: a given doc-test scenario produces byte-identical SHAs and branch names on every execution.
The identifiers embedded in a recorded gh response still match what live local git produces during
replay — zero scrubbing of git-side identifiers.

**Known wrinkle (flagged, not solved here):** GitHub-minted, non-identity values — PR numbers and PR
URLs — are captured raw and canonicalized in doc output via `doc.scrub`. All flows (sync/view/open
and `land`) need this for PR numbers/URLs.

> **Correction (2026-06-18):** an earlier version of this note also warned about "merge commit SHAs
> from `sp land`" and "post-merge local state that won't mirror GitHub's merge." That was based on
> `main`'s old `land`, which merged through the GitHub API. **The implemented `land` on this branch
> does not merge via GitHub** — it fast-forward-pushes the stack's own local tip to trunk
> (`src/commands/land.ts:147-154`; `src/gh/index.ts` exports no merge function). The landed SHA is
> therefore deterministic (identity-pinned), there is no GitHub-minted merge commit, and nothing
> needs to reconcile a "post-merge" local ref. `land` has **no** merge-SHA wrinkle. See todo #20 for
> the actual (mild) migration concern: repeated same-branch PR queries with a changing
> `baseRefName`, served in order by the args-keyed replayer.

### The seam (`src/cli/index.ts`)

```ts
const gh = process.env.SPRY_GH_CASSETTE_RECORD
  ? createRecordingClient(createRealGhClient(), process.env.SPRY_GH_CASSETTE_RECORD)
  : process.env.SPRY_GH_CASSETTE
    ? await createReplayingClient(process.env.SPRY_GH_CASSETTE, { match: "args" })
    : createRealGhClient();
```

- **Unset → identical to production.** Both env branches are inert for real users.
- **Flush on completion:** wrap `program.parseAsync(...)` in `try/finally`; in record mode,
  `await recorder.flush()` in the `finally` so the cassette is written even if the command throws.
- **Eager load on replay:** `createReplayingClient` reads the JSON once at startup.

### Matching strategy

Reuse the prior attempt's sound part: **`match: "args"`** — consume the next unconsumed entry whose
`args` deep-equal the call (order-independent across branches, since determinism makes args
reproducible). Addition: **when a gh call carries `stdin`** (e.g. `gh pr create --body-file -`,
`gh api --input -`), match on `args` _and_ `stdin`. The current replayer ignores `options`; gh needs
`stdin` in the key.

Keep the shared argv builders (`buildPRQueryArgs`, `buildCreatePRArgs`, `buildRetargetArgs` in
`src/gh/`) as the single source for both the CLI and any arg assertions, so recorded args cannot drift
from what the CLI sends.

### Cassette storage & keying

- **Location:** `tests/fixtures/cassettes/<section>/<order>-<slug>.json`, committed. (Mirrors how doc
  fragments are keyed by `section`/`order`, so a doc test's cassette path is derived, not
  hand-managed.)
- **Format:** unchanged — `{ entries: [{ args, options, result }] }`. Human-readable JSON so a real
  recording is reviewable in PRs (and obviously real, vs. the synthetic JSON that got reverted).
- **One cassette per doc-test scenario.** Not one shared tape — keeps each test's tape small and
  independently re-recordable.

### Regeneration workflow — one test body, two modes

The doc test is written once. A harness wrapper switches on an env var:

- **Default (replay):** `SPRY_GH_CASSETTE=<path>`, `origin` = local bare repo, no network, no auth.
  What `bun test` / CI / the docker suite run.
- **Record (`SPRY_RECORD=1`):** `SPRY_GH_CASSETTE_RECORD=<path>`, `origin` = real `spry-check` clone,
  real gh, cleanup after. Run deliberately by a human with auth to refresh tapes, then commit the JSON.

Refreshing the tapes: `SPRY_RECORD=1 bun run test:github` (against `spry-check`) → review the JSON
diff → commit. Everyday runs never touch the network.

---

## Target-repo fixture (ported from `main`, adapted)

- **`tests/lib/github-fixture.ts`** — `createGitHubFixture()` resolving the repo from
  `SPRY_TEST_REPO_OWNER` / `SPRY_TEST_REPO_NAME` (default `spry-check`), with `reset()`
  (closeAllPRs + deleteAllBranches), `mergePR()`, and branch/PR helpers. **Record mode only.**
- **`scripts/setup-spry-check.ts`** — one-time script to create/configure the real `spry-check`
  repo, stamping the README safety marker `<!-- spry-test-repo:v1 -->`.
- **Safety check (non-negotiable):** before any destructive op (push, reset, PR close, branch
  delete), `verifyTestRepo()` confirms the README carries the marker; if missing, hard-fail. Record
  mode can never mutate a real project repo even if env vars are misconfigured.

### Cleanup discipline (record mode only)

- **Suite start:** `reset()` for a clean slate.
- **`afterEach`:** delete branches / close PRs the test created, so one test's PRs cannot leak into
  the next test's recording.
- Best-effort and logged: a cleanup failure warns but does not fail the recording.
- Replay mode skips all of this; it touches nothing remote.

### Mode-aware repo factory

`createRepo()` gains a mode-aware origin:

- **Replay/default:** local bare origin (as today).
- **Record:** clones the verified `spry-check` repo as origin; pushes go to real GitHub.

Either way the test body creates the same deterministic commits/branches — only `origin` differs.

### What a migrated doc test looks like

```ts
docTest("Opening a new PR", { section: "commands/sync", order: 20 }, async (doc) => {
  const repo = await createRepo();           // local bare OR spry-check clone, per mode
  doc.scrub(repo);
  // deterministic commits/branches (pinned dates + seeded ids)
  // ...
  const { command, result } = await runSp(repo.path, "sync", ["--open"], {
    env: cassetteEnv({ section: "commands/sync", order: 20 }), // RECORD or REPLAY
  });
  doc.command(command);
  doc.output(result.stdout);
});
```

In replay (default) this runs offline against the committed cassette through the **real CLI binary** —
real-CLI coverage _and_ real (recorded) gh output. In record mode the same body regenerates the tape.

---

## Rollout

1. **Determinism layer first** — pin dates/identity, seed `generateUniqueId`; prove SHAs/branch names
   are byte-stable across runs (a test asserting two runs match).
2. **Seam + replay** — wire the CLI env seam; reuse `createReplayingClient` with `args`+`stdin`
   matching.
3. **Fixture + record mode** — port `github-fixture`, `setup-spry-check`, safety marker; implement
   the `SPRY_RECORD` path.
4. **Migrate one fragment end-to-end** — `sp sync --open` "Opening a new PR": record against
   `spry-check`, commit the tape, confirm the docker suite replays it offline and generated docs are
   correct.
5. **Migrate the rest** — remaining sync fragments, then `land` last. (`land` has no merge-SHA
   wrinkle — it ff-pushes the local tip, see the Correction above; its only concern is repeated
   same-branch queries with a changing `baseRefName`.)
6. **Mark todo #18 done** when real recordings replay in the offline suite.

Gating: record-mode tests sit behind `SPRY_RECORD`, so default/CI runs never need auth
or network. (As of 2026-06-22 the live fixture test shares this same `SPRY_RECORD` gate
rather than a separate `GITHUB_INTEGRATION_TESTS` knob.)

---

## Risks & open questions

- ~~**Merge-commit SHA non-determinism in `sp land`.**~~ Not a risk: `land` does not merge via
  GitHub, it ff-pushes the stack's own (deterministic) local tip to trunk. See the Correction note
  above and todo #20.
- **PR-number churn on re-record.** Accepted under option 2; revisit with normalize-on-record if
  snapshot churn becomes painful.
- **gh JSON shape drift.** Because cassettes are recorded from real gh, a GitHub API shape change
  surfaces when tapes are re-recorded (diff visible in review) — the correct failure mode, unlike the
  reverted synthetic approach.
- **Determinism completeness.** Any unpinned source of entropy (e.g. a stray timestamp in a commit
  body) breaks SHA stability; step 1's byte-stability test is the guard.

---

## Testing notes (project conventions)

- Git on this machine is too old to run `bun test` directly; use the docker aliases
  (`test:docker`, `test:github`, `test:ci`) per `CLAUDE.md`.
- Every user-facing command/output keeps its `tests/commands/<command>.doc.test.ts` companion; this
  design changes the _mechanism_ (cassette-backed `runSp`), not the requirement.
