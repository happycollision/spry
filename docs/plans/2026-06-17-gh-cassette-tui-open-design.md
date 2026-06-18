# Design: migrate `sp sync --open` TUI fragment to a real gh cassette

Date: 2026-06-17
Todo: solo #19 (follow-up to #18, "real gh cassettes")

## Problem

`tests/commands/sync.doc.test.ts` → "Selecting which branches to open as PRs"
(`{ section: "commands/sync", order: 25 }`) drives the real `sp sync --open` TUI in a
PTY via `createTerminalDriver("bun", [harnessPath, repo.path], ...)`, where `harnessPath`
is `tests/fixtures/sync-tui-harness.ts`. The harness spawns a separate process and stubs
`gh` **inline, in-process** (returns a fake `pull/42`). It is the last `sp sync` fragment
not backed by a real recorded cassette.

The committed cassette seam lives in `src/cli/index.ts` and is selected by env
(`SPRY_GH_CASSETTE_RECORD` to record, `SPRY_GH_CASSETTE` to replay). The TUI harness is a
separate entrypoint with its own hand-stubbed `gh`, so the seam never reaches it.

## Verified facts (read from code, not assumed)

- With `open: null`, `syncCommand` runs the TUI (`selectUnits`), then `openPRs` calls
  **`createPR`** (`gh pr create`) and **`findPRsForBranches`** (`gh api graphql`). Those are
  the gh calls the cassette captures.
- gh calls receive `{ cwd }`; `createRealGhClient` honors `options.cwd`, so real gh runs
  against the repo path even though the harness process cwd differs (the harness injects
  cwd into its git runner for the same reason).
- `buildOpenCandidates` disables already-published branches, so the recorded branch must
  stay **unpublished** to appear as an open candidate.
- The TUI menu screenshot is built from local git data, so it is deterministic regardless
  of gh.
- `createTerminalDriver` already forwards `options.env` spread over `process.env`
  (`tests/lib/terminal-driver.ts:49`), so threading cassette env needs no driver change.

## Approach (chosen: extract shared seam helper)

### 1. Extract the seam — `src/lib/gh-seam.ts` (new)

```ts
export async function createSeamedGhClient(
  env = process.env,
): Promise<{ gh: GhClient; flush(): Promise<void> }>
```

Three-way logic lifted verbatim from `src/cli/index.ts`:

- `env.SPRY_GH_CASSETTE_RECORD` → wrap real gh in `createRecordingClient`; `flush` =
  `recorder.flush`.
- `env.SPRY_GH_CASSETTE` → `createReplayingClient(path, { match: "args" })`; `flush` = no-op.
- else → real gh; `flush` = no-op.

Re-export through `tests/lib/index.ts`.

### 2. Refactor `src/cli/index.ts`

Replace the inline record/replay block with `const { gh, flush } = await
createSeamedGhClient();` and `await flush()` in the existing `finally`. Behavior-preserving;
covered by the existing 020/050/060 cassette replays.

### 3. Rewrite `tests/fixtures/sync-tui-harness.ts`

Build `gh` via `createSeamedGhClient()` (reads its own env) instead of the inline stub, and
`await flush()` after `syncCommand`.

### 4. Rewrite the order-25 fragment (mirror order 50)

- `createRepo({ origin: isRecording() ? "github" : "local" })`, use `repo.git`.
- Set `spry.repo` to the deterministic slug (owner/spry-check) and the usual trunk/remote/
  branchPrefix config.
- `createGitHubFixture` + `fixture.reset()` before and after in record mode — sync _creates_
  the PR here, so the trailing reset cleans it up.
- Branch stays unpublished so it is an open candidate.
- Thread `cassetteEnv({ section: "commands/sync", order: 25 })` into the
  `createTerminalDriver` `env`.
- Scrub the PR URL/number like order 50; replace the `toContain("pull/42")` assertion with a
  canonicalized URL/number check.

### 5. Record & verify

`SPRY_RECORD=1` against spry-check (HTTPS workaround per
`tests/fixtures/cassettes/README.md`), commit `commands__sync--025.json`, confirm offline
replay and `bun run docs:build`. Tests run via the docker alias (local git too old).

## Testing strategy

- TDD `createSeamedGhClient` (record/replay/real selection + flush wiring) before wiring it
  in.
- CLI refactor proven by existing sync doc-test cassette replays.
- The fragment itself is the doc test, exercised offline via replay.

## Out of scope

- The other remaining stubbed fragment (tracked separately).
- Any change to sync behavior.
