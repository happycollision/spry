# gh cassettes

These JSON files are **real recordings of `gh` traffic** captured against the
live `spry-check` test repository. Doc tests replay them offline (no network, no
auth) so they exercise the real `sp` binary while producing realistic, stable
output.

Design: `docs/plans/2026-06-13-gh-cassettes-real-recording-design.md`.

## The one hard rule

**Never hand-author a cassette.** Every byte here must come from a real `gh`
invocation in record mode. A JSON file you typed by hand is just an in-process
stub relocated to disk — it checks fiction against fiction and will silently
drift from GitHub's real responses. (Recording is what caught the broken PR
query that every stubbed test missed.)

## How it works

A doc fragment runs the same body two ways, switching on `SPRY_RECORD`:

- **Replay (default):** `git` origin is a local bare repo, the CLI's `gh` seam
  (`SPRY_GH_CASSETTE`) serves responses from the committed cassette. Offline.
- **Record (`SPRY_RECORD=1`):** `git` origin is a real `spry-check` clone, the
  seam (`SPRY_GH_CASSETTE_RECORD`) wraps real `gh` and writes the cassette.

Determinism is the bridge: fixed branch names, fixed `Spry-Commit-Id`s, and a
fixed `spry.repo` slug make the `gh` arguments byte-identical across both
modes, so the args-keyed replayer matches. (Commit SHAs are deliberately
unique per run — no `gh` call is keyed by SHA. See `tests/lib/repo.ts`.)
See also `tests/lib/cassette-harness.ts`.

Each fixture test runs in its own **namespace** on the fixture repo: a
per-test trunk (`trunk/<section>-<order>`, pushed from the baseline commit),
a per-test branch prefix (`spry/t-<section>-<order>`), and a per-test remote
home for spry's shared bookkeeping refs (`SPRY_REMOTE_REFS_PREFIX` →
`refs/spry/t-<section>-<order>/{prs,groups}`; see `src/lib/refs-seam.ts`),
all pinned by `setupDocRepo` (`tests/lib/doc-repo.ts`). The names are pinned
PER TEST, not per run, because they are cassette keys (`pr create --base
<trunk>` is recorded); `setupDocRepo` registers scrubs mapping them back to
`main` / `spry/dondenton`, so the generated docs still tell the plain-`main`
story.
The one exception is the canonical land test (`commands/land`, order 10),
which keeps `spry.trunk` on the real default branch to validate the genuine
MERGED transition. Namespacing is what lets record mode run the fixture tests
concurrently.

Cassettes are keyed by doc section + order, mirroring `fragmentPath`:
`commands__sync--020.json` ⇔ `{ section: "commands/sync", order: 20 }`.

## Re-recording

Recording mutates the real `spry-check` repo (pushes branches, opens/merges
PRs). The FIRST record-mode test in the process triggers one repo-wide
`reset()` (via `withGitHubFixture`'s suite-start reset, under the record
lock); after that, tests run **concurrently and lock-free**, each confined to
its own trunk/prefix namespace. The one exception is the canonical land test,
which takes the exclusive record lock, ff-pushes the real default branch, and
restores it to baseline afterward. There is no trailing cleanup: `spry-check`
is left dirty (each test's trunk branch, spry branches, and PRs) after a
recording session. That residue is expected and harmless — the next recording
session's suite-start reset clears it, and nothing reads the repo between
sessions.

Because the suite-start reset is once **per process**, always record with a
single `bun test` invocation (`bun run record` records the whole suite
concurrently). Two recording processes at once would each reset the repo and
destroy each other's in-flight work.

The fixture's own unit tests (`tests/lib/github-fixture.test.ts`) exercise
repo-wide destructive ops (`reset`, `restoreMainToBaseline`) that no namespace
can contain, so they target a second dedicated repo,
`happycollision/spry-check-fixture` (same safety marker; bootstrap with
`SPRY_TEST_REPO_NAME=spry-check-fixture bun run scripts/setup-spry-check.ts`).

Recording is **non-interactive** — the agent runs it itself (do not ask the
user) whenever `gh` is authenticated. See the AGENTS.md testing section.

Prerequisites:

- `gh` authenticated against an account that owns a `spry-check` repo carrying
  the safety marker `<!-- spry-test-repo:v1 -->` (run `bun run scripts/setup-spry-check.ts`).
- A git config that pushes to GitHub over **HTTPS**. If your global git config
  rewrites `https://github.com/` to SSH (e.g. a 1Password `insteadOf` rule), the
  non-interactive test subprocess will hang on the SSH agent. Point
  `GIT_CONFIG_GLOBAL` at a minimal HTTPS config for the recording run:

  ```
  # /tmp/rec-gitconfig
  [credential "https://github.com"]
  	helper = !gh auth git-credential
  ```

Record one fragment:

```sh
GIT_CONFIG_GLOBAL=/tmp/rec-gitconfig SPRY_RECORD=1 \
  bun test tests/commands/sync.doc.test.ts -t "Opening a new PR"
```

Then verify it replays offline and regenerate docs:

```sh
bun test tests/commands/sync.doc.test.ts -t "Opening a new PR"   # offline
bun run docs:build
```

Review the JSON diff — it must contain genuine GitHub fields (real URLs,
titles, check-run payloads), not anything you typed. (PR numbers are the one
exception: they are normalized at record time, see below.)

## Normalization at record time

The recording client (`src/lib/recording-client.ts`) normalizes every cassette
as it writes it, so re-recording is deterministic:

- **PR numbers** are rewritten to 1001, 1002, ... in first-seen order, via
  anchored patterns only (`pull/<n>` in URLs, `"number":<n>` in JSON) — never a
  bare numeric replace, which would collide with fields like `totalCount`. The
  same map is applied to recorded **args** and **stdin** (both replay match
  keys): the CLI derives tokens like `pr edit <n>` by parsing an earlier
  entry's stdout, so the rewrite must stay consistent across all three or the
  args-keyed replayer could never match.
- **Options are stripped to `stdin`** — the only option the replayer matches
  on. Recorded `cwd` temp paths were pure churn and are dropped.

The remaining nondeterminism across re-recordings is GitHub Actions check-run
state (`statusCheckRollup` arrays) captured while CI is still settling; see the
pre-merge gate section in AGENTS.md for how to treat that churn.

The cassette JSONs are excluded from oxfmt (`.oxfmtrc.json`): the recorder's
`JSON.stringify` output is the canonical format, so a formatter pass would
guarantee churn on the next re-record. Never reformat them.

## Notes

- `spry.repo` currently defaults to `happycollision/spry-check` to match the
  committed cassettes; override with `SPRY_TEST_REPO_OWNER`/`SPRY_TEST_REPO_NAME`
  when recording under a different account (and commit that account's cassettes).
