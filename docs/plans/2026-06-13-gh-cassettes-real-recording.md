# Real `gh` Cassettes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make cassettes record real `gh` traffic from the `spry-check` repo and replay it offline, so doc tests get both real-CLI coverage and realistic gh output.

**Architecture:** Wrap only `gh` behind an env-guarded seam in `src/cli/index.ts`. `git` always runs live; pinned commit dates/identity + a seeded unique-id generator make SHAs and branch names byte-identical run-to-run, so a real recording replays against a synthetic local bare repo with zero scrubbing. Record mode pushes to the real `spry-check` repo and captures raw `gh` responses; replay mode serves them from committed JSON with no network.

**Tech Stack:** Bun, TypeScript, commander, `gh` CLI, git. Tests via `bun test` (docker aliases — git on this machine is too old to run directly).

**Design doc:** `docs/plans/2026-06-13-gh-cassettes-real-recording-design.md`

**Resolves:** Solo todo #18. Mark it done at the end of Phase 6.

---

## Conventions for the executor

- **Never use `git -C`** for files in this repo — `cd` is not needed, just run git from the repo root (per `CLAUDE.md`).
- **Run tests via docker:** `bun run test:docker` (unit), `bun run test:github` (record/integration). Git here is too old for bare `bun test`.
- **Doc tests are the source of truth for `docs/generated/`** — every user-facing change keeps its `.doc.test.ts`.
- **Commit after every green step.** End commit messages with the `Co-Authored-By` trailer.
- **Hard rule from todo #18 comment #3:** never hand-author a gh response. Every cassette byte comes from a real `gh` call in record mode. Tasks that "create a cassette" do so by _recording_, never by writing JSON literals.

---

## Phase 0: Move cassette code into `src/lib/` (production-importable)

The CLI seam (production code) cannot import from `tests/`. Move the canonical implementations to `src/lib/`, leave thin re-exports in `tests/lib/` so existing tests are untouched.

### Task 0.1: Relocate cassette/recording/replaying clients to `src/lib/`

**Files:**

- Create: `src/lib/cassette.ts` (move body from `tests/lib/cassette.ts`)
- Create: `src/lib/recording-client.ts` (move body from `tests/lib/recording-client.ts`)
- Create: `src/lib/replaying-client.ts` (move body from `tests/lib/replaying-client.ts`)
- Modify: `tests/lib/cassette.ts`, `tests/lib/recording-client.ts`, `tests/lib/replaying-client.ts` → re-export from `src/lib/*`
- Modify: imports of `./context.ts` inside the moved files become `./context.ts` (already in `src/lib`, so the relative import to `src/lib/context.ts` is just `./context.ts`)

**Step 1:** Move the three files' contents to `src/lib/`. In each moved file, fix the relative import: `tests/lib/cassette.ts` imported `./context.ts` (which was `tests/lib/context.ts` re-exporting `src/lib/context.ts`); the new `src/lib/cassette.ts` imports its types directly from `./context.ts` (the real one).

**Step 2:** Replace each `tests/lib/*.ts` with a one-line re-export, e.g. `tests/lib/cassette.ts`:

```ts
export * from "../../src/lib/cassette.ts";
export type { Cassette, CassetteEntry } from "../../src/lib/cassette.ts";
```

Keep `tests/lib/index.ts` exports working unchanged.

**Step 3: Run unit tests.**
Run: `bun run test:docker`
Expected: all existing cassette/recording/replaying lib tests still PASS (they import via `tests/lib`).

**Step 4: Commit.**

```bash
git add src/lib/cassette.ts src/lib/recording-client.ts src/lib/replaying-client.ts tests/lib/cassette.ts tests/lib/recording-client.ts tests/lib/replaying-client.ts
git commit -m "refactor(cassette): move record/replay clients to src/lib for production import"
```

---

## Phase 1: Determinism layer

Make a given scenario produce byte-identical SHAs and branch names every run. This is the bridge.

### Task 1.1: Seedable `generateUniqueId`

**Files:**

- Modify: `tests/lib/unique-id.ts`
- Test: `tests/lib/unique-id.test.ts`

**Step 1: Write the failing test** (append to `unique-id.test.ts`):

```ts
import { generateUniqueId, seedUniqueId, resetUniqueIdSeed } from "./unique-id.ts";

test("seeded generator is deterministic across runs", () => {
  seedUniqueId("my-test-title");
  const a = [generateUniqueId(), generateUniqueId(), generateUniqueId()];
  seedUniqueId("my-test-title");
  const b = [generateUniqueId(), generateUniqueId(), generateUniqueId()];
  expect(a).toEqual(b);
  resetUniqueIdSeed();
});

test("different seeds produce different sequences", () => {
  seedUniqueId("title-a");
  const a = generateUniqueId();
  seedUniqueId("title-b");
  const b = generateUniqueId();
  expect(a).not.toBe(b);
  resetUniqueIdSeed();
});
```

**Step 2: Run, verify it fails.**
Run: `bun run test:docker` (or note: `seedUniqueId is not a function`).
Expected: FAIL.

**Step 3: Implement.** Add a module-level RNG to `unique-id.ts`. Default = `Math.random` (unseeded, preserves today's behavior). `seedUniqueId(s)` hashes the string (e.g. FNV-1a) into a 32-bit seed and installs a `mulberry32` PRNG; `resetUniqueIdSeed()` restores `Math.random`. Route the adjective/noun/suffix picks through the current RNG:

```ts
let rng: () => number = Math.random;

export function seedUniqueId(seed: string): void {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  rng = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resetUniqueIdSeed(): void {
  rng = Math.random;
}
```

Replace the three `Math.random()` calls in `generateUniqueId` with `rng()`.

**Step 4: Run tests, verify pass.**
Run: `bun run test:docker`
Expected: PASS.

**Step 5: Commit.**

```bash
git add tests/lib/unique-id.ts tests/lib/unique-id.test.ts
git commit -m "feat(test): seedable generateUniqueId for deterministic branch names"
```

### Task 1.2: Pinned commit identity + dates in the repo helper

**Files:**

- Modify: `tests/lib/repo.ts`
- Test: `tests/lib/repo.test.ts`

**Step 1: Write the failing test** — two repos built with the same seed + same scenario produce the same HEAD SHA:

```ts
import { seedUniqueId, resetUniqueIdSeed } from "./unique-id.ts";

test("deterministic commits produce identical SHAs across repos", async () => {
  seedUniqueId("sha-stability");
  const r1 = await createRepo();
  const s1 = await r1.commit("Add login");
  seedUniqueId("sha-stability");
  const r2 = await createRepo();
  const s2 = await r2.commit("Add login");
  expect(s1).toBe(s2);
  await r1.cleanup();
  await r2.cleanup();
  resetUniqueIdSeed();
});
```

**Step 2: Run, verify it fails** (SHAs differ today: timestamps drift, `counter`/filenames vary).
Run: `bun run test:docker`
Expected: FAIL.

**Step 3: Implement.** In `repo.ts`:

- Export `export const DETERMINISTIC_GIT_ENV = { GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" } as const;`
- Pass `{ env: { ...process.env, ...DETERMINISTIC_GIT_ENV } }` (via `.env(...)` on the `$` calls) to every commit-creating `$\`git ...\``in`repo.ts`.
- Make filenames deterministic: replace the module-level mutable `counter` and `file-${uniqueId}-${counter}.txt` with a per-repo counter and a name that derives only from seeded state (e.g. `file-${repoCounter}.txt`), so the tree is reproducible. (The `uniqueId` is already deterministic once seeded.)

**Step 4: Run tests, verify pass.**
Run: `bun run test:docker`
Expected: PASS (and the rest of `repo.test.ts` still green).

**Step 5: Commit.**

```bash
git add tests/lib/repo.ts tests/lib/repo.test.ts
git commit -m "feat(test): pin commit dates/identity for byte-stable SHAs"
```

### Task 1.3: Deterministic git runner exposed from the repo

So doc tests' own `git.run([...])` commit calls are also pinned (not just `repo.commit`).

**Files:**

- Modify: `tests/lib/repo.ts` (add `repo.git: GitRunner` bound to `repo.path` + `DETERMINISTIC_GIT_ENV`)
- Modify: `tests/lib/repo.test.ts`

**Step 1: Test** — `repo.git.run(["commit", "--allow-empty", "-m", "x"])` yields the same SHA across two seeded repos. Write it, run it (FAIL), implement `repo.git` as a `GitRunner` that merges `DETERMINISTIC_GIT_ENV` and defaults `cwd` to `repo.path`, run (PASS).

**Step 2: Commit.**

```bash
git add tests/lib/repo.ts tests/lib/repo.test.ts
git commit -m "feat(test): expose deterministic git runner from test repo"
```

---

## Phase 2: The gh cassette seam

### Task 2.1: `match: "args"` + stdin in the replaying client

**Files:**

- Modify: `src/lib/replaying-client.ts`
- Test: `tests/lib/replaying-client.test.ts`

**Step 1: Write failing tests:**

```ts
test("match:args consumes the entry whose args+stdin match, order-independent", async () => {
  const cassettePath = join(tmpDir, "args.json");
  await writeCassette(cassettePath, {
    entries: [
      { args: ["pr", "list"], result: { stdout: "L", stderr: "", exitCode: 0 } },
      { args: ["pr", "create"], options: { stdin: "body-A" }, result: { stdout: "A", stderr: "", exitCode: 0 } },
      { args: ["pr", "create"], options: { stdin: "body-B" }, result: { stdout: "B", stderr: "", exitCode: 0 } },
    ],
  });
  const client = await createReplayingClient(cassettePath, { match: "args" });
  expect((await client.run(["pr", "create"], { stdin: "body-B" })).stdout).toBe("B");
  expect((await client.run(["pr", "create"], { stdin: "body-A" })).stdout).toBe("A");
  expect((await client.run(["pr", "list"])).stdout).toBe("L");
});

test("match:args throws when no unconsumed entry matches", async () => {
  const cassettePath = join(tmpDir, "nomatch.json");
  await writeCassette(cassettePath, { entries: [{ args: ["pr", "list"], result: { stdout: "", stderr: "", exitCode: 0 } }] });
  const client = await createReplayingClient(cassettePath, { match: "args" });
  expect(client.run(["pr", "view"])).rejects.toThrow(/no matching/i);
});
```

**Step 2: Run, verify FAIL** (`createReplayingClient` takes no options today).

**Step 3: Implement.** Add a second param `options?: { match?: "ordinal" | "args" }` (default `"ordinal"` to preserve existing tests). For `"args"`: keep a `consumed: boolean[]`; on each call find the first unconsumed entry where `JSON.stringify(entry.args) === JSON.stringify(args)` **and** `(entry.options?.stdin ?? undefined) === (callOptions?.stdin ?? undefined)`; mark consumed and return its result; throw `no matching recorded entry for args [...] stdin [...]` if none.

**Step 4: Run, verify PASS** (and the existing ordinal tests still pass).

**Step 5: Commit.**

```bash
git add src/lib/replaying-client.ts tests/lib/replaying-client.test.ts
git commit -m "feat(cassette): args+stdin matching mode for replay"
```

### Task 2.2: The env-guarded seam in the CLI

**Files:**

- Modify: `src/cli/index.ts`
- Test: `tests/commands/cli-seam.test.ts` (new)

**Step 1: Write the failing test.** Use `createRunner` + a tiny committed-in-test cassette written by `writeCassette` ONLY to prove the _plumbing_ (this test asserts the seam wires a replay client; it is not a doc fragment, so a constructed cassette is acceptable here as a unit check of the mechanism — it does not feed docs). Assert that with `SPRY_GH_CASSETTE` set, a command that calls `gh` returns the cassette's stdout and makes no network call (e.g. a command whose gh path is exercised — `view` against a repo with a PR cache, or a minimal harness command). If no command cleanly isolates a single gh call, defer the behavioral assertion to Phase 4's recorded fragment and here only assert the process starts and `--help` is unaffected:

```ts
test("unset cassette env: --help works unchanged", async () => {
  const { result } = await runSp(process.cwd(), "--help");
  expect(result.exitCode).toBe(0);
});
```

**Step 2: Run, verify current state.**

**Step 3: Implement the seam.** In `src/cli/index.ts`:

```ts
import { createReplayingClient } from "../lib/replaying-client.ts";
import { createRecordingClient } from "../lib/recording-client.ts";

const realGh = createRealGhClient();
let recorder: { flush(): Promise<void> } | undefined;

let gh = realGh;
if (process.env.SPRY_GH_CASSETTE_RECORD) {
  const rec = createRecordingClient(realGh, process.env.SPRY_GH_CASSETTE_RECORD);
  recorder = rec;
  gh = rec;
} else if (process.env.SPRY_GH_CASSETTE) {
  gh = await createReplayingClient(process.env.SPRY_GH_CASSETTE, { match: "args" });
}

const ctx: SpryContext = { git: createRealGitRunner(), gh };
```

Replace `program.parse();` with:

```ts
try {
  await program.parseAsync();
} finally {
  if (recorder) await recorder.flush();
}
```

(Top-level `await` is fine in Bun ESM.)

**Step 4: Run.**
Run: `bun run test:docker`
Expected: PASS; `--help` and all existing command tests unaffected (no env set → identical to today).

**Step 5: Commit.**

```bash
git add src/cli/index.ts tests/commands/cli-seam.test.ts
git commit -m "feat(cli): env-guarded gh cassette record/replay seam"
```

---

## Phase 3: Record-mode harness + fixture

### Task 3.1: Port `github-fixture.ts` (record mode only)

**Files:**

- Create: `tests/lib/github-fixture.ts`
- Test: `tests/lib/github-fixture.test.ts` (gated; skips unless `GITHUB_INTEGRATION_TESTS`)

Port from `main`'s `tests/helpers/github-fixture.ts`, restyled to this branch: `createGitHubFixture()` resolving `SPRY_TEST_REPO_OWNER`/`SPRY_TEST_REPO_NAME` (default `spry-check`), `verifyTestRepo()` (README must contain `<!-- spry-test-repo:v1 -->` — reuse the marker from `scripts/setup-spry-check.ts`), `reset()` (closeAllPRs + deleteAllBranches), and `mergePR()`. Use `$` from bun (matches `setup-spry-check.ts` style). **Every destructive method calls `verifyTestRepo()` first and hard-fails if the marker is absent.**

Gate the test: `const SKIP = !process.env.GITHUB_INTEGRATION_TESTS; test.skipIf(SKIP)(...)`. Assert `verifyTestRepo` passes against the real `spry-check` and that `reset()` leaves zero open PRs / only `main`.

**Commit:**

```bash
git add tests/lib/github-fixture.ts tests/lib/github-fixture.test.ts
git commit -m "feat(test): port github-fixture for record-mode against spry-check"
```

### Task 3.2: Mode-aware origin + `cassetteEnv` harness

**Files:**

- Modify: `tests/lib/repo.ts` (`createRepo({ origin?: "local" | "github" })`)
- Create: `tests/lib/cassette-harness.ts` (`cassetteEnv`, `cassettePath`)
- Modify: `tests/lib/index.ts` (export the new helpers)
- Modify: `tests/lib/run.ts` — confirm `createRunner` threads `{ env }` to the subprocess (add the param if absent; see Task 2.x usage). The runner must merge `env` over `process.env` and keep `SPRY_NO_TTY=1 FORCE_COLOR=1`.

**`cassettePath`** mirrors `fragmentPath`: `tests/fixtures/cassettes/<section>/<order>-<slug>.json`.

**`cassetteEnv({ section, order })`** returns the env block for the subprocess:

- Replay (default): `{ SPRY_GH_CASSETTE: cassettePath(...) }`.
- Record (`process.env.SPRY_RECORD === "1"`): `{ SPRY_GH_CASSETTE_RECORD: cassettePath(...) }`.

**`createRepo`**: when `origin: "github"` (record), clone the verified `spry-check` repo as origin instead of `git init --bare`; otherwise local bare as today. The harness picks origin from `SPRY_RECORD`.

Add a unit test for `cassettePath`/`cassetteEnv` (pure functions): correct path, correct env var per mode. Commit:

```bash
git add tests/lib/repo.ts tests/lib/cassette-harness.ts tests/lib/index.ts tests/lib/run.ts tests/lib/cassette-harness.test.ts
git commit -m "feat(test): mode-aware origin + cassetteEnv/cassettePath harness"
```

---

## Phase 4: Migrate one fragment end-to-end (the proof)

### Task 4.1: Convert `sp sync --open` "Opening a new PR" to cassette-backed `runSp`

**Files:**

- Modify: `tests/commands/sync.doc.test.ts` (the order-20 fragment that currently calls `syncCommand` in-process with a hand-stubbed gh)
- Create (by RECORDING): `tests/fixtures/cassettes/commands__sync/020-opening-a-new-pr.json`

**Step 1:** Rewrite the fragment to: seed (`seedUniqueId(title)`), build the deterministic repo via `createRepo()` and `repo.git`, then `runSp(repo.path, "sync", ["--open", ...], { env: cassetteEnv({ section: "commands/sync", order: 20 }) })`. Remove the in-process `stubGh`/`syncCommand` call. Keep the same `doc.prose/command/output` and `expect` assertions.

**Step 2: Record the tape against the real repo.**
Run: `SPRY_RECORD=1 bun run test:github` (filtered to this test if possible).
This pushes deterministic branches to `spry-check`, creates a real PR, captures real `gh` JSON into the cassette, and cleans up after. Commit the resulting JSON.
Expected: `tests/fixtures/cassettes/commands__sync/020-opening-a-new-pr.json` created from REAL gh output. **Inspect it** — confirm it contains genuine GitHub fields (real `nodeId`, real `url`), not anything you typed.

**Step 3: Replay offline.**
Run: `bun run test:docker`
Expected: the fragment PASSES with no network, output byte-identical to the previous generated docs. Regenerate docs: `bun run docs:build`; confirm `docs/generated/commands/sync.{md,html}` unchanged (or correctly updated).

**Step 4: Commit.**

```bash
git add tests/commands/sync.doc.test.ts tests/fixtures/cassettes/commands__sync/020-opening-a-new-pr.json docs/generated/commands/sync.md docs/generated/commands/sync.html
git commit -m "test(sync): record real gh cassette for 'Opening a new PR' fragment"
```

> **Checkpoint:** This task proves the whole system. Do not proceed until offline replay is green and the cassette visibly contains real GitHub data.

---

## Phase 5: Migrate the remaining fragments

For each remaining gh-dependent doc fragment, repeat the Task 4.1 loop (rewrite → record with `SPRY_RECORD=1` → replay offline → commit cassette + regenerated docs). One commit per fragment.

### Task 5.1: `sp sync --all` happy path (the original todo-#18 motivator)

Currently shows `PR retargeting unavailable: <hint>`; after recording it shows pushes + `↻ retargeted PR #…` + `✓ Updated PR cache` + `✓ Sync complete`.

### Task 5.2: "Retargeting stacked PRs" sync fragment

Two PR lookups + a `pr edit` retarget — record all three real calls.

### Task 5.3: Any remaining `view` fragments that read live PR state

(If `view` reads only the `refs/spry/prs` cache offline, it may need no cassette — verify before adding one.)

### Task 5.4: `sp land` — LAST, with the merge-SHA wrinkle

`land` runs sync + readiness re-fetch + retarget + merge; the merge commit SHA is GitHub-minted and the post-merge local state on the bare origin won't auto-mirror GitHub. Record the full real sequence; in replay, set up the bare origin's post-merge ref to match the recorded merge (the fixture's `mergePR` result tells you the SHA to write). If this proves brittle, keep `land.doc.test.ts`'s dynamic in-process stub for the order-10 fragment and document why in the test — but attempt the cassette first.

Commit each:

```bash
git commit -m "test(<cmd>): record real gh cassette for <fragment>"
```

---

## Phase 6: Close out

### Task 6.1: Changelog + docs

**Files:**

- Modify: `CHANGELOG.md` (note: doc tests now replay real recorded gh traffic; `SPRY_RECORD=1` to refresh tapes)
- Create: `tests/fixtures/cassettes/README.md` — how to record (`SPRY_RECORD=1 bun run test:github`), the hard rule (never hand-author), and the safety-marker requirement.

**Commit:**

```bash
git add CHANGELOG.md tests/fixtures/cassettes/README.md
git commit -m "docs(cassettes): record/refresh workflow + never-hand-author rule"
```

### Task 6.2: Full suite + merge back

**Step 1:** `bun run check` (types + lint + format), then `bun run test:docker` (offline suite green with no network).
**Step 2:** Optionally `SPRY_RECORD=1 bun run test:ci` once to confirm record mode end-to-end.
**Step 3:** Merge `feat/gh-cassettes-real-recording` back into `rebuild-spry` (per `CLAUDE.md`).

### Task 6.3: Mark Solo todo #18 done

Only after offline replay of real recordings is green on `rebuild-spry`. Post a closing comment summarizing: real record mode shipped (`SPRY_GH_CASSETTE_RECORD`), replay seam (`SPRY_GH_CASSETTE`, `match: "args"` + stdin), determinism bridge (pinned dates/identity + seeded ids), fragments migrated, and that **no responses were hand-authored** this time. Then set the todo to completed.

---

## Risks / watch-items (carry from design)

- **Determinism completeness:** any unpinned entropy (stray timestamp in a commit body, unseeded id) breaks SHA stability — Task 1.2's cross-repo SHA test is the guard. If a later fragment flakes on SHA mismatch, suspect an unseeded `generateUniqueId` call or an un-pinned git env.
- **PR-number churn:** raw capture means re-recording can change PR numbers in snapshots — accepted; revisit with normalize-on-record only if it hurts.
- **gh JSON shape drift:** surfaces as a visible cassette diff on re-record — the correct failure mode (vs the reverted synthetic approach, which hid drift).
- **`land` merge SHA:** the one genuinely hard per-command case; isolated to Task 5.4 and migrated last.
