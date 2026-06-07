# Test-First Rebuild Design

Date: 2026-02-26

## Problem

Testing strategy was discovered too late in development, leading to costly rewrites. The testing infrastructure needs to be the foundation, not an afterthought. Documentation drifted from actual behavior because it wasn't derived from tests.

## Decision

Reset from current HEAD. Delete `src/` and `tests/`. Keep tooling, Docker, CI, config. Rebuild with an infrastructure sprint (Phase 1) followed by incremental feature ports (Phase 2), each gated by full test coverage.

## Phase 1: Testing Infrastructure

Build four pillars before any feature code. Each pillar gets skeleton tests proving it works end-to-end.

### Pillar 1: Dependency Injection & Record/Replay

Every external boundary gets a thin interface. Production wires real implementations; tests wire mocks, recorders, or replayers.

**GhClient interface:**

```ts
interface GhClient {
  run(args: string[], options?: GhOptions): Promise<GhResult>;
}

interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

Three implementations:

- `RealGhClient` — calls `gh` via `Bun.spawn`. Production use.
- `RecordingGhClient` — wraps `RealGhClient`, records every call + response to a cassette file. Used during `bun test --record`.
- `ReplayingGhClient` — reads cassette file, returns recorded responses in order. Used during normal `bun test`.

**Same pattern for Git:**

```ts
interface GitRunner {
  run(args: string[], options?: GitOptions): Promise<GitResult>;
}
```

**DI wiring** — a plain context object, no framework:

```ts
interface SpryContext {
  gh: GhClient;
  git: GitRunner;
  // ...other boundaries added as needed
}
```

**Cassette storage:** `fixtures/<test-file-path>/<test-name>.json` — one cassette per test. Contains an ordered array of `{args, result}` entries. Cassettes are committed to the repo.

**Test commands:**

- `bun test` — all tests, replay mode (default)
- `bun test --record` — all tests, recording mode (hits real APIs)
- Cassettes committed as "known good" responses

### Pillar 2: RepoScenario Builder

Composable building blocks for constructing local + remote repo states.

```ts
const repo = await createRepo({ defaultBranch: "main" });

// Fluent builder
await repo.commit("Initial feature");
await repo.branch("feature-a");
await repo.commit("Feature A work");
await repo.checkout("main");

// Composable shortcuts
await repo.withStack(3);           // 3 commits on a feature branch
await repo.withSyncedStack(3);     // 3 commits already synced to GitHub
await repo.withGroups([2, 1]);     // 2 commits grouped, 1 ungrouped
```

**Isolation:** Unique IDs appended to branches/commits, temp directories in `/tmp/spry-test-*`, automatic cleanup.

**Remote simulation:** Each repo gets a bare clone as "origin" in `/tmp/spry-test-origin-*`. No GitHub needed for local scenarios.

**Named presets:** Common states (empty stack, diverged from main, merge conflict pending, etc.) extracted as features are ported.

### Pillar 3: TerminalDriver (Screen Capture TTY Testing)

Uses Bun's native PTY support (`Bun.spawn` with `terminal` option). Spawns `sp` in a real pseudo-terminal.

```ts
const term = await createTerminalDriver("sp", ["group"], {
  cwd: repo.path,
  cols: 80,
  rows: 24,
});

await term.press("ArrowDown");
await term.press("Enter");

await term.waitForText("Select commits to group");

const screen = term.capture();
// screen.lines: string[]     — each row of the terminal
// screen.cursor: {x, y}      — cursor position
// screen.text: string         — full screen as plain text

expect(screen).toMatchSnapshot();
expect(screen.lineAt(0)).toContain("sp group");

await term.close();
```

**Under the hood:**

- Spawns process with `Bun.spawn({ terminal: { cols, rows, data(term, data) {...} } })`
- Maintains a virtual screen buffer (80x24 grid) updated by parsing ANSI escape sequences
- `waitForText` polls the screen buffer with a timeout
- `capture()` returns a frozen snapshot of the current buffer

**ANSI parser:** Handles the VT100/xterm sequences spry's TUI emits. Either use an existing TypeScript parser or write a focused one scoped to what spry actually uses.

### Pillar 4: DocEmitter (Tests to User-Facing Docs)

Tests produce the actual documentation users read.

```ts
docTest("Syncing a stack to GitHub", {
  section: "commands/sync",
  order: 10,
}, async (doc) => {
  const repo = await createRepo();
  await repo.withStack(3);

  doc.prose("Create three commits on a feature branch, then sync them to GitHub:");

  const { input, result } = await runSpry(repo.path, "sync", ["--open"]);

  doc.command(input);       // captured from what actually ran — single source of truth
  doc.output(result.stdout);

  expect(result.exitCode).toBe(0);

  doc.prose("Each commit becomes its own PR, chained with proper base branches.");
});
```

Key details:

- `docTest` wraps `test()` from bun:test. Only tests wrapped in `docTest` produce documentation.
- `runSpry` returns `{ input, result }` where `input` is the command string it actually executed. No manual `doc.command("sp sync --open")` duplication — the command shown in docs is always exactly what ran.
- Fragments are ephemeral build artifacts — written to tmp during test, consumed by `bun run docs:build`, not committed.
- If a doc test fails, docs for that section aren't generated.
- Screen captures from TerminalDriver can be included via `doc.screen(capture)`.

**Generated output:**

```
docs/
├── commands/
│   ├── sync.md
│   ├── view.md
│   ├── land.md
│   ├── group.md
│   └── clean.md
├── concepts/
│   ├── stacking.md
│   └── grouping.md
└── index.md             # auto-generated table of contents
```

The `docs/` folder is gitignored — it's a build artifact.

## Docker & CI

**Docker setup (preserved from today):**

- `dev` service: Git 2.40.0 (minimum supported)
- `dev-old-git` service: Git 2.38.5 (unsupported, for error handling tests)

**CI pipeline:**

1. lint + typecheck
2. `bun test` (unit tests, fast, replay mode, no Docker)
3. `bun test:docker` (integration tests in Docker with Git 2.40)
4. `bun test:unsupported:docker` (version error handling with Git 2.38)
5. `bun run docs:build` (generate docs — fails if any doc test fails)

**Recording workflow:**

- CI runs with replayed cassettes by default (fast, no GitHub auth needed)
- Manual-trigger workflow runs with `--record` to refresh cassettes (requires GH_TOKEN)
- Cassettes committed to the repo

## Phase 2: Feature Port Order

Features ported in dependency order. Each feature only lands with full test coverage.

1. **Core parsing** — git log, trailers, PRUnit detection, stack validation. Pure logic, unit tests only.
2. **Git operations** — commands wrapper, rebase, conflict prediction. Uses `GitRunner` DI, RepoScenario builder.
3. **`sp view` (local)** — stack display without GitHub enrichment. First doc-producing tests.
4. **GitHub integration** — `GhClient`, PR operations, retry logic. Record/replay cassettes created here.
5. **`sp view` (enriched)** — view with PR status, checks, reviews. Combines git + GitHub.
6. **`sp sync`** — trailer injection, branch pushing, PR creation/update. Heavy record/replay use.
7. **`sp group`** — TUI interactive grouping. TerminalDriver workout. Screen snapshot tests.
8. **`sp land`** — PR merging, retargeting.
9. **`sp clean`** — orphaned branch cleanup.
10. **`sp sync --all`** — multi-branch orchestration. Last because most complex.

## The Reset

From current HEAD (`v1.0.0-beta.5`):

- Delete `src/` and `tests/`
- Keep: `package.json`, `docker/`, `scripts/`, `.github/`, config files, `CHANGELOG.md`
- Strip `package.json` dependencies to what test infrastructure needs
- Add dependencies back as features are ported
- Commit: `chore: reset for test-first rebuild`

**Post-reset structure:**

```
spry/
├── src/                    # Empty, ready for feature ports
├── tests/
│   └── lib/                # Testing infrastructure (Phase 1)
├── docker/
├── scripts/
├── .github/
├── fixtures/               # Record/replay cassettes (committed)
├── docs/                   # Generated docs (gitignored)
└── package.json
```
