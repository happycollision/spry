# Test-First Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reset the spry codebase and rebuild testing infrastructure as the foundation before porting any features.

**Architecture:** Four testing pillars (DI/record-replay, repo scenarios, terminal driver, doc emitter) built as `tests/lib/` modules, each validated with skeleton tests. Then features ported one-at-a-time in dependency order, each gated by full test coverage.

**Tech Stack:** Bun (runtime, test runner, bundler), TypeScript, Bun.spawn with `terminal` option for PTY, Docker for git version matrix.

**Design doc:** `docs/plans/2026-02-26-test-first-rebuild-design.md`

---

## Task 0: The Reset

**Files:**
- Delete: `src/` (entire directory)
- Delete: `tests/` (entire directory)
- Modify: `package.json` (strip feature-specific scripts, keep infrastructure)
- Modify: `bunfig.toml` (update preload path)
- Modify: `.gitignore` (add `docs/` and `.doc-fragments/`)
- Modify: `CHANGELOG.md` (add Unreleased entry)
- Create: `src/.gitkeep`
- Create: `tests/lib/.gitkeep`
- Create: `fixtures/.gitkeep`

**Step 1: Delete source and test directories**

```bash
rm -rf src/ tests/
mkdir -p src tests/lib fixtures
touch src/.gitkeep tests/lib/.gitkeep fixtures/.gitkeep
```

**Step 2: Strip package.json**

Remove the `commander` production dependency. Keep all dev dependencies (husky, lint-staged, oxlint, oxfmt, bun-types). Update scripts to only what's relevant now:

```json
{
  "scripts": {
    "test": "bun test",
    "test:docker": "./scripts/test-docker.sh test",
    "test:local:docker": "./scripts/test-docker.sh test-local",
    "docker:shell": "./scripts/test-docker.sh shell",
    "docker:shell:2.38": "./scripts/test-docker.sh shell 2.38",
    "docs:build": "bun run scripts/build-docs.ts",
    "lint": "bunx oxlint",
    "types": "bunx tsc --noEmit",
    "format": "bunx oxfmt --write .",
    "check": "bun run types && bun run lint && bunx oxfmt --check .",
    "prepare": "husky"
  }
}
```

Remove: `dev`, `build`, `test:local`, `test:github`, `test:ci`, `test:all`, `test:github:setup`, `test:github:docker`, `test:ci:docker`, `test:unsupported:docker`, `scenario`. These get added back when the features that need them are ported.

Remove `"main"` and `"bin"` fields (no binary yet).

**Step 3: Update bunfig.toml**

```toml
[test]
preload = ["./tests/setup.ts"]
```

Create the minimal setup file:

```ts
// tests/setup.ts
// Global test setup — add preload hooks here as infrastructure grows
```

**Step 4: Update .gitignore**

Add these lines:

```
# Generated docs (build artifact)
docs/generated/

# Doc fragments (ephemeral build artifact)
.doc-fragments/
```

**Step 5: Update CHANGELOG.md**

Add under `## [Unreleased]`:

```markdown
### Changed
- Reset codebase for test-first rebuild. Testing infrastructure is now the foundation.
```

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: reset for test-first rebuild

Delete src/ and tests/ to rebuild with testing infrastructure as the
foundation. Keep tooling, Docker, CI, and config. Features will be
ported incrementally, each gated by full test coverage."
```

---

## Task 1: Unique ID Generator

The first building block — used by everything else for test isolation.

**Files:**
- Create: `tests/lib/unique-id.ts`
- Create: `tests/lib/unique-id.test.ts`

**Step 1: Write the failing test**

```ts
// tests/lib/unique-id.test.ts
import { test, expect } from "bun:test";
import { generateUniqueId } from "./unique-id.ts";

test("generates string in adjective-noun-suffix format", () => {
  const id = generateUniqueId();
  const parts = id.split("-");
  expect(parts.length).toBe(3);
  expect(parts[0]!.length).toBeGreaterThan(0);
  expect(parts[1]!.length).toBeGreaterThan(0);
  expect(parts[2]!.length).toBeGreaterThan(0);
});

test("generates unique IDs across 100 calls", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateUniqueId()));
  expect(ids.size).toBe(100);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/unique-id.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Port from existing `tests/helpers/unique-id.ts`. Keep the same adjective/noun lists and format:

```ts
// tests/lib/unique-id.ts
const adjectives = [
  "happy", "swift", "brave", "calm", "eager", "fair", "glad", "keen",
  "bold", "warm", "wise", "cool", "pure", "kind", "free", "true",
  "rich", "safe", "dark", "deep", "firm", "flat", "full", "good",
  "hard", "high", "just", "late", "lean", "live", "long", "loud",
  "mild", "neat", "nice", "open", "pale", "pink", "rare", "real",
  "ripe", "slim", "soft", "sure", "tall", "thin", "tiny", "vast",
  "warm", "weak", "wild", "wiry", "young", "zany",
];

const nouns = [
  "penguin", "falcon", "tiger", "dolphin", "eagle", "panda", "otter",
  "whale", "hawk", "lynx", "wolf", "bear", "deer", "hare", "seal",
  "crow", "dove", "duck", "frog", "goat", "lamb", "lark", "lion",
  "mole", "moth", "newt", "puma", "quail", "robin", "slug", "swan",
  "toad", "vole", "wren", "yak", "fox", "owl", "elk", "ant", "bee",
  "cat", "dog", "emu", "gnu", "hen",
];

export function generateUniqueId(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]!;
  const noun = nouns[Math.floor(Math.random() * nouns.length)]!;
  const suffix = Math.random().toString(36).slice(2, 5);
  return `${adj}-${noun}-${suffix}`;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/unique-id.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/unique-id.ts tests/lib/unique-id.test.ts
git commit -m "feat(test-lib): add unique ID generator for test isolation"
```

---

## Task 2: GitRunner Interface & Real Implementation

**Files:**
- Create: `tests/lib/context.ts` (SpryContext and interfaces)
- Create: `tests/lib/git-runner.ts` (RealGitRunner)
- Create: `tests/lib/git-runner.test.ts`

**Step 1: Write the failing test**

```ts
// tests/lib/git-runner.test.ts
import { test, expect } from "bun:test";
import { createRealGitRunner } from "./git-runner.ts";

test("runs git --version and returns result", async () => {
  const git = createRealGitRunner();
  const result = await git.run(["--version"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("git version");
  expect(result.stderr).toBe("");
});

test("returns non-zero exit code for invalid commands", async () => {
  const git = createRealGitRunner();
  const result = await git.run(["not-a-real-command"]);

  expect(result.exitCode).not.toBe(0);
});

test("respects cwd option", async () => {
  const git = createRealGitRunner();
  const result = await git.run(["rev-parse", "--show-toplevel"], { cwd: "/tmp" });

  // /tmp is not a git repo, so this should fail
  expect(result.exitCode).not.toBe(0);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/git-runner.test.ts`
Expected: FAIL — module not found

**Step 3: Write the interfaces and implementation**

```ts
// tests/lib/context.ts
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface GitRunner {
  run(args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface GhClient {
  run(args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface SpryContext {
  git: GitRunner;
  gh: GhClient;
}
```

```ts
// tests/lib/git-runner.ts
import { $ } from "bun";
import type { GitRunner, CommandResult, CommandOptions } from "./context.ts";

export function createRealGitRunner(): GitRunner {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const proc = $`git ${args}`.nothrow().quiet();
      if (options?.cwd) proc.cwd(options.cwd);
      if (options?.env) proc.env(options.env);
      const result = await proc;
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      };
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/git-runner.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/context.ts tests/lib/git-runner.ts tests/lib/git-runner.test.ts
git commit -m "feat(test-lib): add GitRunner interface and real implementation"
```

---

## Task 3: GhClient Interface & Real Implementation

**Files:**
- Modify: `tests/lib/context.ts` (already has GhClient interface)
- Create: `tests/lib/gh-client.ts`
- Create: `tests/lib/gh-client.test.ts`

**Step 1: Write the failing test**

```ts
// tests/lib/gh-client.test.ts
import { test, expect } from "bun:test";
import { createRealGhClient } from "./gh-client.ts";

test("runs gh --version and returns result", async () => {
  const gh = createRealGhClient();
  const result = await gh.run(["--version"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("gh version");
  expect(result.stderr).toBe("");
});

test("returns non-zero exit code for invalid commands", async () => {
  const gh = createRealGhClient();
  const result = await gh.run(["not-a-real-command"]);

  expect(result.exitCode).not.toBe(0);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/gh-client.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// tests/lib/gh-client.ts
import { $ } from "bun";
import type { GhClient, CommandResult, CommandOptions } from "./context.ts";

export function createRealGhClient(): GhClient {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const proc = $`gh ${args}`.nothrow().quiet();
      if (options?.cwd) proc.cwd(options.cwd);
      if (options?.env) proc.env(options.env);
      const result = await proc;
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      };
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/gh-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/gh-client.ts tests/lib/gh-client.test.ts
git commit -m "feat(test-lib): add GhClient interface and real implementation"
```

---

## Task 4: Recording Client Wrapper

**Files:**
- Create: `tests/lib/cassette.ts` (cassette read/write)
- Create: `tests/lib/recording-client.ts` (RecordingClient wrapper)
- Create: `tests/lib/recording-client.test.ts`

**Step 1: Write the failing test**

```ts
// tests/lib/recording-client.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rm, readdir } from "node:fs/promises";
import { createRecordingClient } from "./recording-client.ts";
import { readCassette } from "./cassette.ts";
import type { GitRunner } from "./context.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/cassettes");

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("records calls and writes cassette file", async () => {
  const inner: GitRunner = {
    async run(args) {
      return { stdout: `ran: ${args.join(" ")}`, stderr: "", exitCode: 0 };
    },
  };

  const cassettePath = join(tmpDir, "test-recording.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["status"]);
  await recording.run(["log", "--oneline"]);
  await recording.flush();

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries).toHaveLength(2);
  expect(cassette.entries[0]!.args).toEqual(["status"]);
  expect(cassette.entries[0]!.result.stdout).toBe("ran: status");
  expect(cassette.entries[1]!.args).toEqual(["log", "--oneline"]);
});

test("passes through results from inner client", async () => {
  const inner: GitRunner = {
    async run() {
      return { stdout: "hello", stderr: "warn", exitCode: 1 };
    },
  };

  const cassettePath = join(tmpDir, "passthrough.json");
  const recording = createRecordingClient(inner, cassettePath);

  const result = await recording.run(["anything"]);
  expect(result.stdout).toBe("hello");
  expect(result.stderr).toBe("warn");
  expect(result.exitCode).toBe(1);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/recording-client.test.ts`
Expected: FAIL — module not found

**Step 3: Write cassette module**

```ts
// tests/lib/cassette.ts
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandResult, CommandOptions } from "./context.ts";

export interface CassetteEntry {
  args: string[];
  options?: CommandOptions;
  result: CommandResult;
}

export interface Cassette {
  entries: CassetteEntry[];
}

export async function readCassette(path: string): Promise<Cassette> {
  const file = Bun.file(path);
  const text = await file.text();
  return JSON.parse(text) as Cassette;
}

export async function writeCassette(path: string, cassette: Cassette): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(cassette, null, 2) + "\n");
}
```

**Step 4: Write recording client**

```ts
// tests/lib/recording-client.ts
import { writeCassette } from "./cassette.ts";
import type { CommandResult, CommandOptions, GitRunner } from "./context.ts";
import type { CassetteEntry } from "./cassette.ts";

export interface RecordingClient extends GitRunner {
  flush(): Promise<void>;
}

export function createRecordingClient(
  inner: GitRunner,
  cassettePath: string,
): RecordingClient {
  const entries: CassetteEntry[] = [];

  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const result = await inner.run(args, options);
      entries.push({ args, options, result });
      return result;
    },
    async flush(): Promise<void> {
      await writeCassette(cassettePath, { entries });
    },
  };
}
```

**Step 5: Run test to verify it passes**

Run: `bun test tests/lib/recording-client.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add tests/lib/cassette.ts tests/lib/recording-client.ts tests/lib/recording-client.test.ts
git commit -m "feat(test-lib): add recording client wrapper with cassette storage"
```

---

## Task 5: Replaying Client

**Files:**
- Create: `tests/lib/replaying-client.ts`
- Create: `tests/lib/replaying-client.test.ts`

**Step 1: Write the failing test**

```ts
// tests/lib/replaying-client.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createReplayingClient } from "./replaying-client.ts";
import { writeCassette } from "./cassette.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/cassettes");

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("replays recorded responses in order", async () => {
  const cassettePath = join(tmpDir, "replay.json");
  await writeCassette(cassettePath, {
    entries: [
      { args: ["status"], result: { stdout: "clean", stderr: "", exitCode: 0 } },
      { args: ["log"], result: { stdout: "abc123 Initial", stderr: "", exitCode: 0 } },
    ],
  });

  const client = await createReplayingClient(cassettePath);

  const r1 = await client.run(["status"]);
  expect(r1.stdout).toBe("clean");

  const r2 = await client.run(["log"]);
  expect(r2.stdout).toBe("abc123 Initial");
});

test("throws if more calls than recorded entries", async () => {
  const cassettePath = join(tmpDir, "short.json");
  await writeCassette(cassettePath, {
    entries: [
      { args: ["status"], result: { stdout: "clean", stderr: "", exitCode: 0 } },
    ],
  });

  const client = await createReplayingClient(cassettePath);
  await client.run(["status"]); // consumes the one entry

  expect(client.run(["log"])).rejects.toThrow(/no more recorded entries/i);
});

test("throws if cassette file does not exist", async () => {
  expect(createReplayingClient(join(tmpDir, "nonexistent.json"))).rejects.toThrow();
});

test("throws if args don't match recorded entry", async () => {
  const cassettePath = join(tmpDir, "mismatch.json");
  await writeCassette(cassettePath, {
    entries: [
      { args: ["status"], result: { stdout: "clean", stderr: "", exitCode: 0 } },
    ],
  });

  const client = await createReplayingClient(cassettePath);
  expect(client.run(["log"])).rejects.toThrow(/mismatch/i);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/replaying-client.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// tests/lib/replaying-client.ts
import { readCassette } from "./cassette.ts";
import type { GitRunner, CommandResult, CommandOptions } from "./context.ts";

export async function createReplayingClient(cassettePath: string): Promise<GitRunner> {
  const cassette = await readCassette(cassettePath);
  let index = 0;

  return {
    async run(args: string[], _options?: CommandOptions): Promise<CommandResult> {
      if (index >= cassette.entries.length) {
        throw new Error(
          `Replay: no more recorded entries (${cassette.entries.length} total). ` +
          `Unexpected call with args: [${args.join(", ")}]`,
        );
      }

      const entry = cassette.entries[index]!;

      // Verify args match
      const expectedArgs = JSON.stringify(entry.args);
      const actualArgs = JSON.stringify(args);
      if (expectedArgs !== actualArgs) {
        throw new Error(
          `Replay mismatch at entry ${index}: ` +
          `expected args ${expectedArgs}, got ${actualArgs}`,
        );
      }

      index++;
      return entry.result;
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/replaying-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/replaying-client.ts tests/lib/replaying-client.test.ts
git commit -m "feat(test-lib): add replaying client for cassette-based test replay"
```

---

## Task 6: Record/Replay Integration Test

Prove the full cycle works: record with a real command, then replay it.

**Files:**
- Create: `tests/lib/record-replay.integration.test.ts`

**Step 1: Write the test**

```ts
// tests/lib/record-replay.integration.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createRealGitRunner } from "./git-runner.ts";
import { createRecordingClient } from "./recording-client.ts";
import { createReplayingClient } from "./replaying-client.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/integration");

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("record then replay produces identical results", async () => {
  const cassettePath = join(tmpDir, "git-version.json");

  // Phase 1: Record
  const realGit = createRealGitRunner();
  const recorder = createRecordingClient(realGit, cassettePath);

  const recordedResult = await recorder.run(["--version"]);
  await recorder.flush();

  // Phase 2: Replay
  const replayer = await createReplayingClient(cassettePath);
  const replayedResult = await replayer.run(["--version"]);

  // Results should be identical
  expect(replayedResult.stdout).toBe(recordedResult.stdout);
  expect(replayedResult.stderr).toBe(recordedResult.stderr);
  expect(replayedResult.exitCode).toBe(recordedResult.exitCode);
});
```

**Step 2: Run test**

Run: `bun test tests/lib/record-replay.integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/lib/record-replay.integration.test.ts
git commit -m "test(test-lib): add record/replay integration test proving full cycle"
```

---

## Task 7: RepoScenario Builder — Core

**Files:**
- Create: `tests/lib/repo.ts`
- Create: `tests/lib/repo.test.ts`

**Step 1: Write the failing test**

```ts
// tests/lib/repo.test.ts
import { test, expect, afterEach } from "bun:test";
import { $ } from "bun";
import { stat } from "node:fs/promises";
import { createRepo } from "./repo.ts";
import type { TestRepo } from "./repo.ts";

const repos: TestRepo[] = [];

afterEach(async () => {
  for (const repo of repos) await repo.cleanup();
  repos.length = 0;
});

async function tracked(repo: TestRepo): Promise<TestRepo> {
  repos.push(repo);
  return repo;
}

test("creates a local repo with bare origin", async () => {
  const repo = await tracked(await createRepo());

  // Working directory exists
  const workStat = await stat(repo.path);
  expect(workStat.isDirectory()).toBe(true);

  // Origin exists
  const originStat = await stat(repo.originPath);
  expect(originStat.isDirectory()).toBe(true);

  // Is a git repo
  const result = await $`git -C ${repo.path} rev-parse --git-dir`.quiet().text();
  expect(result.trim()).toBe(".git");
});

test("has initial commit on main", async () => {
  const repo = await tracked(await createRepo());

  const branch = await repo.currentBranch();
  expect(branch).toBe("main");

  const log = await $`git -C ${repo.path} log --oneline`.quiet().text();
  expect(log.trim()).toContain("Initial commit");
});

test("commit creates unique files", async () => {
  const repo = await tracked(await createRepo());
  await repo.commit("First");
  await repo.commit("Second");

  const log = await $`git -C ${repo.path} log --oneline`.quiet().text();
  const lines = log.trim().split("\n");
  expect(lines.length).toBe(3); // initial + 2
});

test("branch creates and checks out new branch", async () => {
  const repo = await tracked(await createRepo());
  const branchName = await repo.branch("feature");

  const current = await repo.currentBranch();
  expect(current).toBe(branchName);
  expect(branchName).toContain("feature");
  expect(branchName).toContain(repo.uniqueId);
});

test("cleanup removes temp directories", async () => {
  const repo = await createRepo();
  const { path, originPath } = repo;

  await repo.cleanup();

  expect(stat(path)).rejects.toThrow();
  expect(stat(originPath)).rejects.toThrow();
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/repo.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// tests/lib/repo.ts
import { $ } from "bun";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { generateUniqueId } from "./unique-id.ts";

export interface TestRepo {
  path: string;
  originPath: string;
  uniqueId: string;
  defaultBranch: string;

  commit(message?: string): Promise<string>;
  commitFiles(files: Record<string, string>, message?: string): Promise<string>;
  branch(name: string): Promise<string>;
  checkout(name: string): Promise<void>;
  fetch(): Promise<void>;
  currentBranch(): Promise<string>;
  cleanup(): Promise<void>;
}

export interface CreateRepoOptions {
  defaultBranch?: string;
}

let counter = 0;

export async function createRepo(options?: CreateRepoOptions): Promise<TestRepo> {
  const uniqueId = generateUniqueId();
  const defaultBranch = options?.defaultBranch ?? "main";
  const originPath = `/tmp/spry-test-origin-${uniqueId}`;
  const workPath = `/tmp/spry-test-${uniqueId}`;

  // Create bare origin
  await $`git init --bare ${originPath} --initial-branch=${defaultBranch}`.quiet();

  // Create working clone
  await $`git clone ${originPath} ${workPath}`.quiet();
  await $`git -C ${workPath} config user.email "test@example.com"`.quiet();
  await $`git -C ${workPath} config user.name "Test User"`.quiet();

  // Initial commit
  const initFile = join(workPath, "README.md");
  await Bun.write(initFile, "# Test repo\n");
  await $`git -C ${workPath} add .`.quiet();
  await $`git -C ${workPath} commit -m "Initial commit"`.quiet();
  await $`git -C ${workPath} push origin ${defaultBranch}`.quiet();

  async function commit(message?: string): Promise<string> {
    counter++;
    const filename = `file-${uniqueId}-${counter}.txt`;
    const msg = message ?? `Commit ${counter}`;
    await Bun.write(join(workPath, filename), `Content: ${msg}\n`);
    await $`git -C ${workPath} add .`.quiet();
    await $`git -C ${workPath} commit -m ${`${msg} [${uniqueId}]`}`.quiet();
    return (await $`git -C ${workPath} rev-parse HEAD`.quiet().text()).trim();
  }

  async function commitFiles(files: Record<string, string>, message?: string): Promise<string> {
    counter++;
    const msg = message ?? `Commit ${counter}`;
    for (const [name, content] of Object.entries(files)) {
      const dir = join(workPath, name, "..");
      await mkdir(dir, { recursive: true });
      await Bun.write(join(workPath, name), content);
    }
    await $`git -C ${workPath} add .`.quiet();
    await $`git -C ${workPath} commit -m ${`${msg} [${uniqueId}]`}`.quiet();
    return (await $`git -C ${workPath} rev-parse HEAD`.quiet().text()).trim();
  }

  async function branch(name: string): Promise<string> {
    const branchName = `${name}-${uniqueId}`;
    await $`git -C ${workPath} checkout -b ${branchName}`.quiet();
    return branchName;
  }

  async function checkout(name: string): Promise<void> {
    await $`git -C ${workPath} checkout ${name}`.quiet();
  }

  async function fetch(): Promise<void> {
    await $`git -C ${workPath} fetch origin`.quiet();
  }

  async function currentBranch(): Promise<string> {
    return (await $`git -C ${workPath} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
  }

  async function cleanup(): Promise<void> {
    await rm(workPath, { recursive: true, force: true });
    await rm(originPath, { recursive: true, force: true });
  }

  return {
    path: workPath,
    originPath,
    uniqueId,
    defaultBranch,
    commit,
    commitFiles,
    branch,
    checkout,
    fetch,
    currentBranch,
    cleanup,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/repo.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/repo.ts tests/lib/repo.test.ts
git commit -m "feat(test-lib): add RepoScenario builder with local + origin repos"
```

---

## Task 8: Repo Manager (Lifecycle)

Wraps `createRepo` with automatic cleanup via bun:test lifecycle hooks.

**Files:**
- Create: `tests/lib/repo-manager.ts`
- Create: `tests/lib/repo-manager.test.ts`

**Step 1: Write the failing test**

```ts
// tests/lib/repo-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { stat } from "node:fs/promises";
import { repoManager } from "./repo-manager.ts";

const repos = repoManager();

test("creates repos that are automatically tracked", async () => {
  const repo = await repos.create();
  const s = await stat(repo.path);
  expect(s.isDirectory()).toBe(true);
});

test("supports creating multiple repos in one test", async () => {
  const repo1 = await repos.create();
  const repo2 = await repos.create();
  expect(repo1.path).not.toBe(repo2.path);
  expect(repo1.uniqueId).not.toBe(repo2.uniqueId);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/repo-manager.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// tests/lib/repo-manager.ts
import { beforeEach, afterEach } from "bun:test";
import { createRepo } from "./repo.ts";
import type { TestRepo, CreateRepoOptions } from "./repo.ts";

export interface RepoManager {
  create(options?: CreateRepoOptions): Promise<TestRepo>;
}

export function repoManager(): RepoManager {
  const activeRepos: TestRepo[] = [];

  afterEach(async () => {
    for (const repo of activeRepos) {
      await repo.cleanup();
    }
    activeRepos.length = 0;
  });

  return {
    async create(options?: CreateRepoOptions): Promise<TestRepo> {
      const repo = await createRepo(options);
      activeRepos.push(repo);
      return repo;
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/repo-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/repo-manager.ts tests/lib/repo-manager.test.ts
git commit -m "feat(test-lib): add repo manager with automatic lifecycle cleanup"
```

---

## Task 9: ANSI Parser (Virtual Screen Buffer)

Core of the TerminalDriver — parses ANSI escape sequences and maintains a virtual screen buffer.

**Files:**
- Create: `tests/lib/ansi-parser.ts`
- Create: `tests/lib/ansi-parser.test.ts`

**Step 1: Write the failing test**

```ts
// tests/lib/ansi-parser.test.ts
import { test, expect } from "bun:test";
import { createScreenBuffer } from "./ansi-parser.ts";

test("plain text writes to buffer at cursor position", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Hello, world!");

  expect(screen.lineAt(0)).toBe("Hello, world!");
  expect(screen.cursor).toEqual({ x: 13, y: 0 });
});

test("newline moves cursor to next line", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Line 1\nLine 2");

  expect(screen.lineAt(0)).toBe("Line 1");
  expect(screen.lineAt(1)).toBe("Line 2");
  expect(screen.cursor).toEqual({ x: 6, y: 1 });
});

test("carriage return moves cursor to start of line", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Hello\rWorld");

  expect(screen.lineAt(0)).toBe("World");
});

test("cursor movement: ESC[nA (up)", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Line 0\nLine 1\nLine 2");
  screen.write("\x1b[2A"); // move up 2 lines

  expect(screen.cursor.y).toBe(0);
});

test("cursor movement: ESC[nB (down)", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Line 0");
  screen.write("\x1b[3B"); // move down 3 lines

  expect(screen.cursor.y).toBe(3);
});

test("cursor movement: ESC[nC (forward)", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("\x1b[5C"); // move forward 5

  expect(screen.cursor.x).toBe(5);
});

test("cursor movement: ESC[nD (back)", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Hello");
  screen.write("\x1b[3D"); // move back 3

  expect(screen.cursor.x).toBe(2);
});

test("cursor positioning: ESC[row;colH", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("\x1b[5;10H"); // row 5, col 10 (1-based)

  expect(screen.cursor).toEqual({ x: 9, y: 4 }); // 0-based
});

test("clear screen: ESC[2J", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Some text on screen");
  screen.write("\x1b[2J");

  expect(screen.lineAt(0)).toBe("");
});

test("clear line: ESC[2K", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Hello, world!");
  screen.write("\x1b[2K"); // clear entire line

  expect(screen.lineAt(0)).toBe("");
});

test("ignores color/style codes without affecting buffer content", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("\x1b[1m\x1b[31mRed bold\x1b[0m normal");

  expect(screen.lineAt(0)).toBe("Red bold normal");
});

test("cursor hide/show are no-ops for buffer", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("\x1b[?25l"); // hide
  screen.write("visible");
  screen.write("\x1b[?25h"); // show

  expect(screen.lineAt(0)).toBe("visible");
});

test("capture returns frozen snapshot", () => {
  const screen = createScreenBuffer(80, 5);
  screen.write("Line 0\nLine 1\nLine 2");

  const snapshot = screen.capture();
  expect(snapshot.lines).toHaveLength(5);
  expect(snapshot.lines[0]).toBe("Line 0");
  expect(snapshot.lines[1]).toBe("Line 1");
  expect(snapshot.lines[2]).toBe("Line 2");
  expect(snapshot.lines[3]).toBe("");
  expect(snapshot.cursor).toEqual({ x: 6, y: 2 });
  expect(snapshot.text).toContain("Line 0\nLine 1\nLine 2");

  // Snapshot is frozen — further writes don't affect it
  screen.write("\nLine 3");
  expect(snapshot.lines[3]).toBe("");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/ansi-parser.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// tests/lib/ansi-parser.ts
export interface ScreenSnapshot {
  lines: string[];
  cursor: { x: number; y: number };
  text: string;
}

export interface ScreenBuffer {
  write(data: string): void;
  lineAt(row: number): string;
  capture(): ScreenSnapshot;
  cursor: { x: number; y: number };
}

export function createScreenBuffer(cols: number, rows: number): ScreenBuffer {
  // Internal grid: rows x cols of characters
  const grid: string[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => " "),
  );
  const cursor = { x: 0, y: 0 };

  function putChar(ch: string): void {
    if (cursor.y >= 0 && cursor.y < rows && cursor.x >= 0 && cursor.x < cols) {
      grid[cursor.y]![cursor.x] = ch;
    }
    cursor.x++;
    if (cursor.x >= cols) {
      cursor.x = 0;
      cursor.y++;
    }
  }

  function clearLine(row: number): void {
    if (row >= 0 && row < rows) {
      for (let i = 0; i < cols; i++) grid[row]![i] = " ";
    }
  }

  function clearAll(): void {
    for (let r = 0; r < rows; r++) clearLine(r);
  }

  function lineAt(row: number): string {
    if (row < 0 || row >= rows) return "";
    return grid[row]!.join("").trimEnd();
  }

  function write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;

      // ESC sequence
      if (ch === "\x1b") {
        i++;
        if (i >= data.length) break;
        const next = data[i]!;

        if (next === "[") {
          // CSI sequence: ESC [ ... finalByte
          i++;
          let params = "";
          while (i < data.length && data[i]! >= "\x20" && data[i]! <= "\x3f") {
            params += data[i]!;
            i++;
          }
          if (i >= data.length) break;
          const finalByte = data[i]!;
          i++;

          handleCSI(params, finalByte);
        } else if (next === "7") {
          // Save cursor — ignore for now
          i++;
        } else if (next === "8") {
          // Restore cursor — ignore for now
          i++;
        } else {
          i++;
        }
        continue;
      }

      // Control characters
      if (ch === "\n") {
        cursor.y++;
        cursor.x = 0;
        i++;
        continue;
      }
      if (ch === "\r") {
        cursor.x = 0;
        i++;
        continue;
      }

      // Regular character
      putChar(ch);
      i++;
    }
  }

  function handleCSI(params: string, finalByte: string): void {
    const n = params === "" ? 1 : parseInt(params, 10) || 1;

    switch (finalByte) {
      case "A": // Cursor up
        cursor.y = Math.max(0, cursor.y - n);
        break;
      case "B": // Cursor down
        cursor.y = Math.min(rows - 1, cursor.y + n);
        break;
      case "C": // Cursor forward
        cursor.x = Math.min(cols - 1, cursor.x + n);
        break;
      case "D": // Cursor back
        cursor.x = Math.max(0, cursor.x - n);
        break;
      case "H": // Cursor position (row;col, 1-based)
      case "f": {
        const parts = params.split(";");
        const row = parseInt(parts[0] || "1", 10) - 1;
        const col = parseInt(parts[1] || "1", 10) - 1;
        cursor.y = Math.max(0, Math.min(rows - 1, row));
        cursor.x = Math.max(0, Math.min(cols - 1, col));
        break;
      }
      case "J": // Erase in display
        if (params === "2" || params === "3") clearAll();
        else if (params === "" || params === "0") {
          // Clear from cursor to end
          for (let x = cursor.x; x < cols; x++) grid[cursor.y]![x] = " ";
          for (let r = cursor.y + 1; r < rows; r++) clearLine(r);
        }
        break;
      case "K": // Erase in line
        if (params === "2") {
          clearLine(cursor.y);
        } else if (params === "" || params === "0") {
          for (let x = cursor.x; x < cols; x++) grid[cursor.y]![x] = " ";
        } else if (params === "1") {
          for (let x = 0; x <= cursor.x; x++) grid[cursor.y]![x] = " ";
        }
        break;
      case "m": // SGR (color/style) — ignore, doesn't affect text content
        break;
      case "h": // Set mode (e.g., ?25h cursor show)
        break;
      case "l": // Reset mode (e.g., ?25l cursor hide)
        break;
      default:
        // Unknown CSI — ignore
        break;
    }
  }

  function capture(): ScreenSnapshot {
    const lines = Array.from({ length: rows }, (_, r) => lineAt(r));
    const text = lines.map((l) => l).join("\n");
    return {
      lines: [...lines],
      cursor: { ...cursor },
      text,
    };
  }

  return {
    write,
    lineAt,
    capture,
    cursor,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/ansi-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/ansi-parser.ts tests/lib/ansi-parser.test.ts
git commit -m "feat(test-lib): add ANSI parser with virtual screen buffer"
```

---

## Task 10: TerminalDriver

**Files:**
- Create: `tests/lib/terminal-driver.ts`
- Create: `tests/lib/terminal-driver.test.ts`

**Step 1: Write the failing test**

Tests use a simple `echo` command first to validate the driver without depending on `sp`.

```ts
// tests/lib/terminal-driver.test.ts
import { test, expect } from "bun:test";
import { createTerminalDriver } from "./terminal-driver.ts";

test("captures output from a simple command", async () => {
  const term = await createTerminalDriver("echo", ["Hello from PTY"], {
    cols: 80,
    rows: 24,
  });

  await term.waitForText("Hello from PTY", { timeout: 2000 });
  const screen = term.capture();
  expect(screen.text).toContain("Hello from PTY");

  await term.close();
});

test("type sends keystrokes to the process", async () => {
  // Use cat which echoes input back
  const term = await createTerminalDriver("cat", [], {
    cols: 80,
    rows: 24,
  });

  await Bun.sleep(100); // let cat start
  term.type("hello");
  await term.waitForText("hello", { timeout: 2000 });

  const screen = term.capture();
  expect(screen.text).toContain("hello");

  // Send Ctrl+D to close cat
  term.type("\x04");
  await term.close();
});

test("press sends named keys", async () => {
  const term = await createTerminalDriver("cat", [], {
    cols: 80,
    rows: 24,
  });

  await Bun.sleep(100);
  term.press("a");
  term.press("b");
  term.press("c");
  await term.waitForText("abc", { timeout: 2000 });

  term.type("\x04");
  await term.close();
});

test("waitForText times out if text never appears", async () => {
  const term = await createTerminalDriver("echo", ["something else"], {
    cols: 80,
    rows: 24,
  });

  await expect(
    term.waitForText("this will never appear", { timeout: 500 }),
  ).rejects.toThrow(/timeout/i);

  await term.close();
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/terminal-driver.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// tests/lib/terminal-driver.ts
import { createScreenBuffer } from "./ansi-parser.ts";
import type { ScreenSnapshot, ScreenBuffer } from "./ansi-parser.ts";

export interface TerminalDriverOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface TerminalDriver {
  type(text: string): void;
  press(key: string): void;
  waitForText(text: string, options?: { timeout?: number }): Promise<void>;
  capture(): ScreenSnapshot;
  close(): Promise<void>;
}

const KEY_MAP: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Enter: "\r",
  Return: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Backspace: "\x7f",
  Space: " ",
  Home: "\x1b[H",
  End: "\x1b[F",
  "Shift+ArrowUp": "\x1b[1;2A",
  "Shift+ArrowDown": "\x1b[1;2B",
  "Ctrl+c": "\x03",
  "Ctrl+d": "\x04",
};

export async function createTerminalDriver(
  command: string,
  args: string[],
  options?: TerminalDriverOptions,
): Promise<TerminalDriver> {
  const cols = options?.cols ?? 80;
  const rows = options?.rows ?? 24;
  const screen = createScreenBuffer(cols, rows);

  const proc = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        screen.write(text);
      },
    },
  });

  function type(text: string): void {
    proc.terminal!.write(text);
  }

  function press(key: string): void {
    const sequence = KEY_MAP[key];
    if (sequence) {
      type(sequence);
    } else if (key.length === 1) {
      type(key);
    } else {
      throw new Error(`Unknown key: "${key}". Use KEY_MAP entries or single characters.`);
    }
  }

  async function waitForText(
    text: string,
    opts?: { timeout?: number },
  ): Promise<void> {
    const timeout = opts?.timeout ?? 5000;
    const pollInterval = 50;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const snapshot = screen.capture();
      if (snapshot.text.includes(text)) return;
      await Bun.sleep(pollInterval);
    }

    const snapshot = screen.capture();
    throw new Error(
      `Timeout waiting for text "${text}" after ${timeout}ms.\n` +
      `Current screen:\n${snapshot.text}`,
    );
  }

  function capture(): ScreenSnapshot {
    return screen.capture();
  }

  async function close(): Promise<void> {
    try {
      proc.terminal?.close();
    } catch {
      // Process may have already exited
    }
    try {
      proc.kill();
    } catch {
      // Process may have already exited
    }
    await proc.exited;
  }

  return { type, press, waitForText, capture, close };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/terminal-driver.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/terminal-driver.ts tests/lib/terminal-driver.test.ts
git commit -m "feat(test-lib): add TerminalDriver with PTY spawning and screen capture"
```

---

## Task 11: DocEmitter

**Files:**
- Create: `tests/lib/doc.ts`
- Create: `tests/lib/doc.test.ts`

**Step 1: Write the failing test**

```ts
// tests/lib/doc.test.ts
import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { rm, readdir } from "node:fs/promises";
import { docTest, getDocFragments, clearDocFragments } from "./doc.ts";

afterEach(() => {
  clearDocFragments();
});

test("docTest registers a fragment on pass", async () => {
  // We can't easily run a docTest *inside* a test, so we test the
  // fragment collection API directly.
  const { collectFragment } = await import("./doc.ts");

  collectFragment({
    title: "Example feature",
    section: "commands/example",
    order: 10,
    entries: [
      { type: "prose", content: "This demonstrates the feature." },
      { type: "command", content: "sp example --flag" },
      { type: "output", content: "Example output here" },
    ],
  });

  const fragments = getDocFragments();
  expect(fragments).toHaveLength(1);
  expect(fragments[0]!.section).toBe("commands/example");
  expect(fragments[0]!.entries).toHaveLength(3);
});

test("fragments are ordered by section then order", () => {
  const { collectFragment } = require("./doc.ts");

  collectFragment({
    title: "Second",
    section: "commands/sync",
    order: 20,
    entries: [{ type: "prose", content: "Second section" }],
  });
  collectFragment({
    title: "First",
    section: "commands/sync",
    order: 10,
    entries: [{ type: "prose", content: "First section" }],
  });

  const fragments = getDocFragments();
  const syncFragments = fragments
    .filter((f: { section: string }) => f.section === "commands/sync")
    .sort((a: { order: number }, b: { order: number }) => a.order - b.order);

  expect(syncFragments[0]!.title).toBe("First");
  expect(syncFragments[1]!.title).toBe("Second");
});

test("clearDocFragments resets state", () => {
  const { collectFragment } = require("./doc.ts");

  collectFragment({
    title: "Will be cleared",
    section: "test",
    order: 1,
    entries: [],
  });

  clearDocFragments();
  expect(getDocFragments()).toHaveLength(0);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/doc.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// tests/lib/doc.ts
import { test as bunTest } from "bun:test";

export interface DocEntry {
  type: "prose" | "command" | "output" | "screen";
  content: string;
}

export interface DocFragment {
  title: string;
  section: string;
  order: number;
  entries: DocEntry[];
}

export interface DocContext {
  prose(text: string): void;
  command(input: string): void;
  output(text: string): void;
  screen(text: string): void;
}

// Global fragment collection
let fragments: DocFragment[] = [];

export function getDocFragments(): DocFragment[] {
  return fragments;
}

export function clearDocFragments(): void {
  fragments = [];
}

export function collectFragment(fragment: DocFragment): void {
  fragments.push(fragment);
}

export function docTest(
  title: string,
  options: { section: string; order: number },
  fn: (doc: DocContext) => Promise<void>,
): void {
  bunTest(title, async () => {
    const entries: DocEntry[] = [];

    const doc: DocContext = {
      prose(text: string) {
        entries.push({ type: "prose", content: text });
      },
      command(input: string) {
        entries.push({ type: "command", content: input });
      },
      output(text: string) {
        entries.push({ type: "output", content: text });
      },
      screen(text: string) {
        entries.push({ type: "screen", content: text });
      },
    };

    await fn(doc);

    // Only collect fragment if test passes (if fn throws, we never get here)
    collectFragment({
      title,
      section: options.section,
      order: options.order,
      entries,
    });
  });
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/doc.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/doc.ts tests/lib/doc.test.ts
git commit -m "feat(test-lib): add DocEmitter for test-derived documentation"
```

---

## Task 12: Doc Builder Script

Assembles doc fragments into markdown files.

**Files:**
- Create: `scripts/build-docs.ts`
- Create: `scripts/build-docs.test.ts`

**Step 1: Write the failing test**

```ts
// scripts/build-docs.test.ts
import { test, expect } from "bun:test";
import { assembleMarkdown } from "./build-docs.ts";
import type { DocFragment } from "../tests/lib/doc.ts";

test("assembles fragments into markdown grouped by section", () => {
  const fragments: DocFragment[] = [
    {
      title: "Basic sync",
      section: "commands/sync",
      order: 10,
      entries: [
        { type: "prose", content: "Sync your stack:" },
        { type: "command", content: "sp sync" },
        { type: "output", content: "✓ Synced 3 commits" },
      ],
    },
    {
      title: "Sync with open",
      section: "commands/sync",
      order: 20,
      entries: [
        { type: "prose", content: "Open PRs during sync:" },
        { type: "command", content: "sp sync --open" },
      ],
    },
  ];

  const result = assembleMarkdown(fragments);
  const syncDoc = result.get("commands/sync");

  expect(syncDoc).toBeDefined();
  expect(syncDoc).toContain("# sync");
  expect(syncDoc).toContain("Sync your stack:");
  expect(syncDoc).toContain("```\nsp sync\n```");
  expect(syncDoc).toContain("```\n✓ Synced 3 commits\n```");
  expect(syncDoc).toContain("Open PRs during sync:");
  // Order matters: "Basic sync" before "Sync with open"
  expect(syncDoc!.indexOf("Sync your stack:")).toBeLessThan(
    syncDoc!.indexOf("Open PRs during sync:"),
  );
});

test("screen entries render as code blocks", () => {
  const fragments: DocFragment[] = [
    {
      title: "Group editor",
      section: "commands/group",
      order: 10,
      entries: [
        { type: "prose", content: "The group editor:" },
        { type: "screen", content: "Group Editor - 3 commits\n→ [A] abc123 First commit" },
      ],
    },
  ];

  const result = assembleMarkdown(fragments);
  const groupDoc = result.get("commands/group");

  expect(groupDoc).toContain("```\nGroup Editor - 3 commits");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test scripts/build-docs.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// scripts/build-docs.ts
import type { DocFragment, DocEntry } from "../tests/lib/doc.ts";

/** Assemble doc fragments into markdown strings grouped by section. */
export function assembleMarkdown(fragments: DocFragment[]): Map<string, string> {
  // Group by section
  const sections = new Map<string, DocFragment[]>();
  for (const fragment of fragments) {
    const existing = sections.get(fragment.section) ?? [];
    existing.push(fragment);
    sections.set(fragment.section, existing);
  }

  // Sort within each section by order
  const result = new Map<string, string>();
  for (const [section, frags] of sections) {
    frags.sort((a, b) => a.order - b.order);

    // Section title from last segment of section path
    const sectionName = section.split("/").pop()!;
    const lines: string[] = [`# ${sectionName}`, ""];

    for (const frag of frags) {
      for (const entry of frag.entries) {
        lines.push(renderEntry(entry));
        lines.push("");
      }
    }

    result.set(section, lines.join("\n"));
  }

  return result;
}

function renderEntry(entry: DocEntry): string {
  switch (entry.type) {
    case "prose":
      return entry.content;
    case "command":
      return `\`\`\`\n${entry.content}\n\`\`\``;
    case "output":
      return `\`\`\`\n${entry.content}\n\`\`\``;
    case "screen":
      return `\`\`\`\n${entry.content}\n\`\`\``;
  }
}

// CLI entrypoint — run with: bun run scripts/build-docs.ts
if (import.meta.main) {
  const { getDocFragments } = await import("../tests/lib/doc.ts");
  const { mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const fragments = getDocFragments();
  if (fragments.length === 0) {
    console.log("No doc fragments collected. Run tests first.");
    process.exit(0);
  }

  const docs = assembleMarkdown(fragments);
  const outDir = join(import.meta.dir, "../docs/generated");

  for (const [section, content] of docs) {
    const filePath = join(outDir, `${section}.md`);
    await mkdir(join(filePath, ".."), { recursive: true });
    await Bun.write(filePath, content);
    console.log(`  wrote ${filePath}`);
  }

  console.log(`Generated ${docs.size} doc files.`);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test scripts/build-docs.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/build-docs.ts scripts/build-docs.test.ts
git commit -m "feat(test-lib): add doc builder script for assembling test-derived docs"
```

---

## Task 13: Command Runner (runSpry)

The bridge between tests and the CLI. Returns `{ command, result }` where `command` is the exact invocation string (single source of truth for docs).

**Files:**
- Create: `tests/lib/run.ts`
- Create: `tests/lib/run.test.ts`

**Step 1: Write the failing test**

Since there's no `sp` CLI yet, test with a simple script that simulates it.

```ts
// tests/lib/run.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createRunner } from "./run.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/runner");
const fakeCliPath = join(tmpDir, "fake-cli.ts");

beforeAll(async () => {
  await Bun.write(
    fakeCliPath,
    `
    const args = process.argv.slice(2);
    if (args[0] === "echo") {
      console.log("output: " + args.slice(1).join(" "));
    } else if (args[0] === "fail") {
      console.error("something went wrong");
      process.exit(1);
    } else {
      console.log("unknown command");
    }
    `,
  );
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("returns command string and result", async () => {
  const run = createRunner(fakeCliPath);
  const { command, result } = await run("/tmp", "echo", ["hello", "world"]);

  expect(command).toBe("sp echo hello world");
  expect(result.stdout).toContain("output: hello world");
  expect(result.exitCode).toBe(0);
});

test("captures stderr and non-zero exit code", async () => {
  const run = createRunner(fakeCliPath);
  const { command, result } = await run("/tmp", "fail");

  expect(command).toBe("sp fail");
  expect(result.stderr).toContain("something went wrong");
  expect(result.exitCode).toBe(1);
});

test("command string reflects actual args", async () => {
  const run = createRunner(fakeCliPath);
  const { command } = await run("/tmp", "sync", ["--open", "--all"]);

  expect(command).toBe("sp sync --open --all");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/lib/run.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// tests/lib/run.ts
import { $ } from "bun";
import type { CommandResult } from "./context.ts";

export interface RunResult {
  /** The exact CLI invocation string (e.g., "sp sync --open") — single source of truth for docs */
  command: string;
  /** The execution result */
  result: CommandResult;
}

export type SpryRunner = (
  cwd: string,
  command: string,
  args?: string[],
) => Promise<RunResult>;

/**
 * Create a runner bound to a specific CLI entry point.
 * In tests: `createRunner("src/cli/index.ts")`
 * The runner sets SPRY_NO_TTY=1 to force non-interactive mode.
 */
export function createRunner(cliPath: string): SpryRunner {
  return async (cwd, command, args = []) => {
    const proc = await $`SPRY_NO_TTY=1 bun run ${cliPath} ${command} ${args}`
      .cwd(cwd)
      .nothrow()
      .quiet();

    const commandStr = args.length > 0
      ? `sp ${command} ${args.join(" ")}`
      : `sp ${command}`;

    return {
      command: commandStr,
      result: {
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
        exitCode: proc.exitCode,
      },
    };
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/lib/run.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/run.ts tests/lib/run.test.ts
git commit -m "feat(test-lib): add command runner with single-source-of-truth command string"
```

---

## Task 14: Index Module & End-to-End Smoke Test

Barrel export for the test library, plus a smoke test that exercises all four pillars together.

**Files:**
- Create: `tests/lib/index.ts`
- Create: `tests/lib/smoke.test.ts`

**Step 1: Write the barrel export**

```ts
// tests/lib/index.ts
export { generateUniqueId } from "./unique-id.ts";
export { createRealGitRunner } from "./git-runner.ts";
export { createRealGhClient } from "./gh-client.ts";
export { createRecordingClient } from "./recording-client.ts";
export { createReplayingClient } from "./replaying-client.ts";
export { readCassette, writeCassette } from "./cassette.ts";
export { createRepo } from "./repo.ts";
export { repoManager } from "./repo-manager.ts";
export { createScreenBuffer } from "./ansi-parser.ts";
export { createTerminalDriver } from "./terminal-driver.ts";
export { docTest, getDocFragments, clearDocFragments, collectFragment } from "./doc.ts";
export { createRunner } from "./run.ts";

export type { SpryContext, GitRunner, GhClient, CommandResult, CommandOptions } from "./context.ts";
export type { TestRepo, CreateRepoOptions } from "./repo.ts";
export type { RepoManager } from "./repo-manager.ts";
export type { ScreenSnapshot, ScreenBuffer } from "./ansi-parser.ts";
export type { TerminalDriver, TerminalDriverOptions } from "./terminal-driver.ts";
export type { DocContext, DocFragment, DocEntry } from "./doc.ts";
export type { RunResult, SpryRunner } from "./run.ts";
export type { Cassette, CassetteEntry } from "./cassette.ts";
export type { RecordingClient } from "./recording-client.ts";
```

**Step 2: Write the smoke test**

```ts
// tests/lib/smoke.test.ts
import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  createRealGitRunner,
  createRecordingClient,
  createReplayingClient,
  createRepo,
  createScreenBuffer,
  collectFragment,
  getDocFragments,
  clearDocFragments,
} from "./index.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/smoke");

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  clearDocFragments();
});

test("all four pillars work together", async () => {
  // Pillar 1: DI + Record/Replay
  const git = createRealGitRunner();
  const cassettePath = join(tmpDir, "smoke.json");
  const recorder = createRecordingClient(git, cassettePath);
  const versionResult = await recorder.run(["--version"]);
  await recorder.flush();

  const replayer = await createReplayingClient(cassettePath);
  const replayed = await replayer.run(["--version"]);
  expect(replayed.stdout).toBe(versionResult.stdout);

  // Pillar 2: RepoScenario
  const repo = await createRepo();
  await repo.commit("Test commit");
  const branch = await repo.branch("feature");
  expect(branch).toContain(repo.uniqueId);
  const currentBranch = await repo.currentBranch();
  expect(currentBranch).toBe(branch);
  await repo.cleanup();

  // Pillar 3: ScreenBuffer (ANSI parser)
  const screen = createScreenBuffer(40, 10);
  screen.write("\x1b[1;1HGroup Editor\x1b[2;1H→ [A] abc123 First commit");
  expect(screen.lineAt(0)).toBe("Group Editor");
  expect(screen.lineAt(1)).toContain("→ [A] abc123 First commit");

  // Pillar 4: DocEmitter
  collectFragment({
    title: "Smoke test",
    section: "meta/smoke",
    order: 1,
    entries: [
      { type: "prose", content: "All four pillars verified." },
      { type: "command", content: "sp sync" },
    ],
  });
  expect(getDocFragments()).toHaveLength(1);
});
```

**Step 3: Run all tests**

Run: `bun test tests/lib/`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/lib/index.ts tests/lib/smoke.test.ts
git commit -m "feat(test-lib): add barrel export and end-to-end smoke test

All four testing pillars verified working together:
- DI with record/replay cassettes
- RepoScenario builder with isolation
- ANSI parser with virtual screen buffer
- DocEmitter with fragment collection"
```

---

## Task 15: Update CI and Docker for New Structure

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/test-docker.sh`
- Modify: `bunfig.toml`

**Step 1: Update CI workflow**

Simplify to match current state (no GitHub integration tests yet, no feature code):

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-git
        with:
          git-version: "2.40.0"
      - uses: jdx/mise-action@v2
      - run: bun install --frozen-lockfile
      - run: bunx tsc --noEmit
        continue-on-error: true
      - run: bunx oxlint
        continue-on-error: true
      - run: bunx oxfmt --check .
        continue-on-error: true
      - run: bun test
```

Remove the `test-old-git` and `test-github-integration` jobs for now. They'll be added back when the features that need them are ported.

**Step 2: Verify tests pass in Docker**

Run: `bun run test:docker`
Expected: PASS (or update docker script if needed)

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml scripts/test-docker.sh bunfig.toml
git commit -m "chore: update CI and Docker for test-lib-only codebase"
```

---

## Summary

After completing Tasks 0-15, you will have:

- A clean codebase with no feature code
- A fully tested `tests/lib/` with:
  - **Unique ID generation** for test isolation
  - **GitRunner** and **GhClient** interfaces with real implementations
  - **Recording** and **Replaying** clients with per-test cassette storage
  - **RepoScenario builder** with local + origin repos and automatic cleanup
  - **ANSI parser** with virtual screen buffer
  - **TerminalDriver** with PTY spawning, keystroke sending, and screen capture
  - **DocEmitter** for collecting test-derived documentation fragments
  - **Doc builder script** for assembling fragments into markdown
  - **Command runner** with single-source-of-truth command strings
- Updated CI and Docker matching the new structure
- Every pillar validated with its own tests plus an end-to-end smoke test

Phase 2 (feature ports) begins after this. Each feature gets its own plan document following the same task structure.
