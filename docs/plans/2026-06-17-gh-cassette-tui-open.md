# Migrate `sp sync --open` TUI fragment to a real gh cassette — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Back the `sp sync --open` TUI doc fragment (`commands/sync` order 25) with a real recorded `gh` cassette instead of an inline in-process stub.

**Architecture:** Extract the CLI's three-way gh cassette seam (record/replay/real) into a shared `createSeamedGhClient` helper. The CLI entrypoint and the TUI harness both call it, so the harness honors `SPRY_GH_CASSETTE*` env. The doc fragment then mirrors the proven order-50 fragment: record real `gh pr create` + `gh api graphql` traffic against `spry-check`, replay it offline.

**Tech Stack:** Bun, TypeScript, `bun test`, commander, PTY terminal driver, git, gh CLI. Tests run via the docker alias (`bun run test:docker`) because local git < 2.40.

Design: `docs/plans/2026-06-17-gh-cassette-tui-open-design.md`.

---

## Conventions

- **Run tests via docker:** `bun run test:docker <files...>` (local git is too old). Single file example: `bun run test:docker tests/lib/gh-seam.test.ts`.
- TDD: write the failing test, watch it fail, implement, watch it pass, commit.
- Update `CHANGELOG.md` before committing any runtime-affecting change. (The seam refactor is internal; the cassette migration is test-only. Add a brief changelog note for the shared-helper refactor since it touches the CLI entrypoint.)

---

## Task 1: Extract `createSeamedGhClient` (TDD)

**Files:**

- Create: `src/lib/gh-seam.ts`
- Create: `tests/lib/gh-seam.ts` (re-export shim, mirrors `tests/lib/recording-client.ts`)
- Create: `tests/lib/gh-seam.test.ts`
- Modify: `tests/lib/index.ts` (add export)

**Step 1: Write the failing test**

`tests/lib/gh-seam.test.ts` — mirror the import style of `tests/lib/recording-client.test.ts` (import the re-export `./gh-seam.ts`). Cover the three selection paths and flush wiring by passing an explicit `env` object (do NOT mutate `process.env`):

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createSeamedGhClient } from "./gh-seam.ts";
import { readCassette, writeCassette } from "./cassette.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/gh-seam");

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("replay mode: serves recorded responses, flush is a no-op", async () => {
  const cassettePath = join(tmpDir, "replay.json");
  await writeCassette(cassettePath, {
    entries: [
      { args: ["pr", "view"], result: { stdout: "recorded", stderr: "", exitCode: 0 } },
    ],
  });
  const { gh, flush } = await createSeamedGhClient({ SPRY_GH_CASSETTE: cassettePath });
  const result = await gh.run(["pr", "view"]);
  expect(result.stdout).toBe("recorded");
  await flush(); // must not throw
});

test("record mode: wraps an inner client and flush persists the cassette", async () => {
  const cassettePath = join(tmpDir, "record.json");
  let calls = 0;
  const inner = {
    async run() {
      calls++;
      return { stdout: "live", stderr: "", exitCode: 0 };
    },
  };
  const { gh, flush } = await createSeamedGhClient(
    { SPRY_GH_CASSETTE_RECORD: cassettePath },
    inner,
  );
  await gh.run(["pr", "create"]);
  await flush();
  expect(calls).toBe(1);
  const cassette = await readCassette(cassettePath);
  expect(cassette.entries).toHaveLength(1);
  expect(cassette.entries[0]?.args).toEqual(["pr", "create"]);
});

test("real mode: no cassette env returns a usable client and no-op flush", async () => {
  const inner = {
    async run() {
      return { stdout: "real", stderr: "", exitCode: 0 };
    },
  };
  const { gh, flush } = await createSeamedGhClient({}, inner);
  expect((await gh.run(["--version"])).stdout).toBe("real");
  await flush(); // must not throw
});
```

Note: the helper takes an optional second arg — the "real" client to use — so tests inject a fake instead of shelling out to `gh`. Default is `createRealGhClient()`.

**Step 2: Run the test, verify it fails**

Run: `bun run test:docker tests/lib/gh-seam.test.ts`
Expected: FAIL — `createSeamedGhClient` not found / module missing.

**Step 3: Implement `src/lib/gh-seam.ts`**

```ts
import { createRealGhClient } from "./context.ts";
import type { GhClient } from "./context.ts";
import { createReplayingClient } from "./replaying-client.ts";
import { createRecordingClient } from "./recording-client.ts";

export interface SeamedGhClient {
  gh: GhClient;
  flush(): Promise<void>;
}

/**
 * Build a gh client wired to the cassette seam, selected by env:
 *   SPRY_GH_CASSETTE_RECORD -> record real traffic (flush persists the cassette)
 *   SPRY_GH_CASSETTE        -> replay a committed cassette (flush is a no-op)
 *   neither                 -> real gh (flush is a no-op)
 *
 * `realClient` is injectable for tests; defaults to the live gh client.
 */
export async function createSeamedGhClient(
  env: Record<string, string | undefined> = process.env,
  realClient: GhClient = createRealGhClient(),
): Promise<SeamedGhClient> {
  if (env.SPRY_GH_CASSETTE_RECORD) {
    const recorder = createRecordingClient(realClient, env.SPRY_GH_CASSETTE_RECORD);
    return { gh: recorder, flush: () => recorder.flush() };
  }
  if (env.SPRY_GH_CASSETTE) {
    const gh = await createReplayingClient(env.SPRY_GH_CASSETTE, { match: "args" });
    return { gh, flush: async () => {} };
  }
  return { gh: realClient, flush: async () => {} };
}
```

Create `tests/lib/gh-seam.ts`:

```ts
export * from "../../src/lib/gh-seam.ts";
export type { SeamedGhClient } from "../../src/lib/gh-seam.ts";
```

Add to `tests/lib/index.ts` (near the other client exports):

```ts
export { createSeamedGhClient } from "./gh-seam.ts";
export type { SeamedGhClient } from "./gh-seam.ts";
```

**Step 4: Run the test, verify it passes**

Run: `bun run test:docker tests/lib/gh-seam.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add src/lib/gh-seam.ts tests/lib/gh-seam.ts tests/lib/gh-seam.test.ts tests/lib/index.ts
git commit -m "feat(lib): extract createSeamedGhClient gh cassette seam helper"
```

---

## Task 2: Refactor the CLI entrypoint to use the helper

**Files:**

- Modify: `src/cli/index.ts:8-30,64-68`
- Modify: `CHANGELOG.md`

**Step 1: Replace the inline seam block**

Remove the `createReplayingClient`/`createRecordingClient`/`RecordingClient` imports and the inline `recorder`/`gh` block (lines 10-25). Replace with:

```ts
import { createRealGitRunner } from "../lib/context.ts";
import type { SpryContext } from "../lib/context.ts";
import { createSeamedGhClient } from "../lib/gh-seam.ts";

const program = new Command();

program.name("sp").description("Spry: Stacked PRs. Develop with alacrity.");

const { gh, flush } = await createSeamedGhClient();

const ctx: SpryContext = {
  git: createRealGitRunner(),
  gh,
};
```

Update the `finally` (lines 64-68):

```ts
try {
  await program.parseAsync();
} finally {
  await flush();
}
```

**Step 2: Verify the existing sync cassettes still replay (proves behavior-preserving)**

Run: `bun run test:docker tests/commands/sync.doc.test.ts`
Expected: PASS — all fragments, including the 020/050/060 cassette replays, still green.

**Step 3: Changelog**

Add an entry under the unreleased section of `CHANGELOG.md`, e.g.:

```
- Internal: extracted the gh cassette seam into a shared `createSeamedGhClient` helper so the CLI and test harnesses select record/replay/real consistently.
```

**Step 4: Commit**

```bash
git add src/cli/index.ts CHANGELOG.md
git commit -m "refactor(cli): build gh client via shared createSeamedGhClient seam"
```

---

## Task 3: Rewrite the TUI harness to use the seam

**Files:**

- Modify: `tests/fixtures/sync-tui-harness.ts`

**Step 1: Replace the inline gh stub with the seam**

```ts
#!/usr/bin/env bun
import { syncCommand } from "../../src/commands/sync.ts";
import { createRealGitRunner, createSeamedGhClient } from "../lib/index.ts";
import type { SpryContext } from "../lib/index.ts";

const cwd = process.argv[2];
if (!cwd) {
  console.error("Usage: sync-tui-harness.ts <repo-cwd>");
  process.exit(1);
}

const { gh, flush } = await createSeamedGhClient();

const runner = createRealGitRunner();
const ctx: SpryContext = {
  git: {
    run: (args: string[], opts?: { cwd?: string }) =>
      runner.run(args, { ...opts, cwd: opts?.cwd ?? cwd }),
  },
  gh,
};

try {
  await syncCommand(ctx, { cwd, open: null });
} finally {
  await flush();
}
```

**Step 2: Sanity check — harness still loads (no cassette env = real gh path)**

This is verified end-to-end by Task 5's replay run. No standalone test here; the harness is exercised only through the doc fragment.

**Step 3: Commit**

```bash
git add tests/fixtures/sync-tui-harness.ts
git commit -m "refactor(test): build harness gh client via createSeamedGhClient seam"
```

---

## Task 4: Rewrite the order-25 doc fragment

**Files:**

- Modify: `tests/commands/sync.doc.test.ts:220-286`

**Step 1: Rewrite the fragment body to mirror order 50**

Model on the order-50 fragment (lines 149-218). Key changes vs. the current order-25:

- Use `createRepo({ origin: isRecording() ? "github" : "local" })` and `repo.git` (drop the separate `createRealGitRunner`).
- Add `createGitHubFixture` + `fixture.reset()` before the run (record mode only) and again after (sync _creates_ the PR here, so the trailing reset removes it).
- Set `spry.repo` to the deterministic slug, like order 50.
- Keep the branch **unpublished** (do not pre-push) so it is an open candidate.
- Thread `cassetteEnv({ section: "commands/sync", order: 25 })` into `createTerminalDriver`'s `env`.
- Scrub the PR URL + number; replace `toContain("pull/42")` with a canonicalized check.

```ts
  docTest(
    "Selecting which branches to open as PRs",
    { section: "commands/sync", order: 25, timeout: 40000 },
    async (doc) => {
      const recording = isRecording();
      const fixture = recording ? await createGitHubFixture() : undefined;
      if (fixture) await fixture.reset();

      const repo = await createRepo({ origin: recording ? "github" : "local" });
      repos.push(repo);
      doc.scrub(repo);
      doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");

      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
      const repoSlug = `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`;
      await repo.git.run(["config", "spry.repo", repoSlug]);

      await repo.git.run(["checkout", "-b", "feature/x"]);
      await repo.git.run(["commit", "--allow-empty", "-m", "Add login\n\nSpry-Commit-Id: aaa11111"]);

      doc.prose(
        "Run `sp sync --open` (no arguments) to choose which unpublished branches to open as PRs. Spry shows an interactive menu — use Space to toggle, Enter to confirm:",
      );
      doc.command("sp sync --open");

      // Canonicalize the GitHub-minted PR number in the created-PR line for stable docs.
      doc.scrub(/pull\/\d+/g, "pull/42");
      doc.scrub(/Created PR #\d+/g, "Created PR #42");

      // Spawn the harness in a real PTY. The gh seam (cassetteEnv) records/replays
      // gh pr create + the PR-status graphql query; the TUI runs for real.
      const driver = await createTerminalDriver("bun", [harnessPath, repo.path], {
        cols: 80,
        rows: 24,
        env: cassetteEnv({ section: "commands/sync", order: 25 }),
      });
      repos.push({ cleanup: () => driver.close() });

      await driver.waitForText("Add login", { timeout: 15000 });
      doc.screen(driver.capture());

      driver.press("Space");
      driver.press("Enter");

      await driver.waitForText("Sync complete", { timeout: 15000 });

      const snap = driver.capture();
      const syncLines = snap.lines
        .map((l) => l.trimEnd())
        .filter(
          (l) =>
            l.includes("pushed") ||
            l.includes("Created") ||
            l.includes("Sync complete") ||
            l.includes("https://") ||
            l.includes("↑") ||
            l.includes("✓"),
        );
      doc.output(syncLines.join("\n") + "\n");

      if (fixture) await fixture.reset();

      const { expect } = await import("bun:test");
      expect(snap.text).toContain("Sync complete");
      expect(syncLines.join("\n")).toContain("pull/42");
    },
  );
```

Confirm `createGitHubFixture` is imported at the top of the file (order 50 uses it — it is imported from `../lib/github-fixture.ts`). `isRecording`, `cassetteEnv`, `createRepo`, `createTerminalDriver` are already imported.

**Step 2: Commit (test scaffolding before the cassette exists)**

```bash
git add tests/commands/sync.doc.test.ts
git commit -m "test(sync): switch order-25 --open fragment to the cassette seam"
```

(The replay run will fail until the cassette is recorded in Task 5 — that is expected and is the next step.)

---

## Task 5: Record the cassette and verify offline replay

**Files:**

- Create: `tests/fixtures/cassettes/commands__sync--025.json` (recorded, never hand-authored)

**Step 1: Prepare the HTTPS git config** (per `tests/fixtures/cassettes/README.md`)

Ensure `/tmp/rec-gitconfig` exists:

```
[credential "https://github.com"]
	helper = !gh auth git-credential
```

**Step 2: Record against spry-check**

Recording needs real `gh` auth + the live `spry-check` repo, so it runs **outside docker** (local git is fine for recording; the docker requirement is only for the offline test suite). Run:

```bash
GIT_CONFIG_GLOBAL=/tmp/rec-gitconfig SPRY_RECORD=1 \
  bun test tests/commands/sync.doc.test.ts -t "Selecting which branches to open as PRs"
```

Expected: a new `tests/fixtures/cassettes/commands__sync--025.json` containing real GitHub fields (real PR number, node IDs, URLs). The fragment's `fixture.reset()` cleans up the PR/branch it created on spry-check.

**Step 3: Inspect the cassette**

Confirm it contains genuine `gh pr create` output (a real `https://github.com/<owner>/spry-check/pull/<N>` URL) and a real graphql response — nothing hand-typed.

**Step 4: Verify offline replay (docker)**

```bash
bun run test:docker tests/commands/sync.doc.test.ts
```

Expected: PASS offline (no network/auth), including order 25.

**Step 5: Rebuild docs and review the generated fragment**

```bash
bun run docs:build
```

Expected: `docs/generated/` updates for the sync fragment; the rendered output shows the TUI menu screenshot + sync output with the canonicalized `pull/42` / `PR #42`. Review the diff for sanity.

**Step 6: Commit**

```bash
git add tests/fixtures/cassettes/commands__sync--025.json docs/generated/
git commit -m "test(sync): record real gh cassette for the --open TUI fragment"
```

---

## Task 6: Final verification

**Step 1: Full doc-test run offline**

Run: `bun run test:docker tests/commands/sync.doc.test.ts`
Expected: all sync fragments green, fully offline.

**Step 2: Confirm no stray stub remains**

Grep `tests/fixtures/sync-tui-harness.ts` for `pull/42` / inline gh stub — should be gone.

**Step 3: Mark solo todo #19 done** (reopen/complete as appropriate) and note the cassette is recorded.
