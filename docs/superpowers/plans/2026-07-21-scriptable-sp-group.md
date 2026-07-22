# Scriptable `sp group` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-interactive, offline `sp group --apply <json>` (with a machine-readable `sp view --json` read side) so agents and tests can create/edit/dissolve groups, reorder, and reissue ids declaratively — after first fixing a latent content-loss bug in the commit-reorder engine.

**Architecture:** Three phases. **Phase 1** (standalone, safety-critical, TDD) fixes `sp group`'s reorder to diff-replay through `rebasePlumbing` instead of the lossy `rewriteCommitChain`. **Phase 2** adds a nested JSON tree type and `sp view --json`. **Phase 3** adds `parseApplyDoc` + `reconcile` (pure, fully unit-tested) and wires `sp group --apply` to produce the same result the TUI produces and rejoin the existing reorder→save→push tail. All new surfaces are offline (no `gh`), tested by seeding the local PR cache directly — no cassettes, no doc tests.

**Tech Stack:** Bun + TypeScript. Tests via `bun test`. Git plumbing via the project's `GitRunner`. CLI via `commander`. Full design: `docs/superpowers/specs/2026-07-21-scriptable-sp-group-design.md`.

**Spec authority:** The design spec is the source of truth for semantics. When this plan and the spec disagree, the spec wins — stop and reconcile.

---

## Verified codebase facts (do not re-derive)

- **PR cache** `src/gh/pr-cache.ts`: `loadPRCache(git, opts?)`, `savePRCache(git, cache, opts?)`. `PRCache = Record<unitId, PRCacheEntry>`; `PRCacheEntry extends PRInfo { branch: string; cachedAt: string }`. `PRInfo` (`src/gh/pr.ts:9`): `{ number, url, state, title, baseRefName, checksStatus, reviewDecision, reviewThreads }`. `PRState = "OPEN"|"CLOSED"|"MERGED"`. **Ref `refs/spry/prs`, pure git plumbing — `savePRCache` seeds with no gh.** Keyed by **unit id**, not branch.
- **Cache→PR read** `src/gh/enrich.ts`: `enrichFromCache(units, cache) → EnrichedUnit[]`, where `EnrichedUnit = { unit; pr: PRInfo | null; error? }`. `sp view` already uses `loadPRCache`+`enrichFromCache` offline (`src/commands/view.ts:28`). **The `--apply` path must read PR state this way (by unit id), NOT via `findPRsForBranches` (which hits `gh`).**
- **Group records** `src/parse/types.ts:29`: `GroupRecord { title: string; members: string[] }`, `GroupRecords = Record<groupId, GroupRecord>`. Persisted by `saveAllGroupRecords(git, records, opts?)` to ref `refs/spry/groups` (`src/git/group-titles.ts:103`). Loaded by `loadGroupRecords`. Helpers `buildCommitGroupMap`, `extractGroupTitles`.
- **Id minting** `src/parse/id.ts:3`: `generateCommitId(): string` → `randomBytes(4).toString("hex")` (8 hex chars, **random / non-deterministic**). Reuse for reissue + new-group ids. Tests assert on structure/length, never literal ids.
- **Reorder tail** (`src/commands/group.ts:116-129` today): `getMergeBase(git, ref, {cwd})` → rewrite → `finalizeRewrite(git, branch, oldTip, newTip, {cwd})` → `saveAllGroupRecords` → `pushGroupRecords`.
- **Reorder engines** `src/git/plumbing.ts`: `rewriteCommitChain(git, commits, rewrites, {cwd, base})` (reuses snapshot trees — LOSSY on reorder) vs. `rebasePlumbing(git, onto, commits, opts) → {ok:true;newTip;mapping}|{ok:false;conflictCommit;conflictInfo}` (diff-replays via merge-tree — correct). `finalizeRewrite(git, branch, oldTip, newTip, opts)`.
- **Parse** `src/parse/`: `parseCommitTrailers(commits, git, opts?) → CommitWithTrailers[]`; `parseStack(commits, titles?, commitGroups?) → {ok:true;units}|{ok:false;error:"split-group";...}`.
- **CLI** `src/cli/index.ts`: `commander`; `ctx = { git: createRealGitRunner(), gh }`. Pattern: `.command("x").option("--flag <v>", ...).action((opts) => xCommand(ctx, { ... }))`. Mirror `landCommand(ctx, opts)` (`src/commands/land.ts:25`).
- **No stdin helper** exists for reading a piped body. Inject stdin as an opt for testability (mirror `LandOptions.confirm`).
- **Test harness (offline, pattern A)** — see `tests/commands/clean.test.ts`: build `createRepo()` (from `tests/lib`), config `spry.trunk/remote/branchPrefix`, make a `SpryContext` whose `git` runs against `repo.path` and whose `gh.run` is a **stub returning empty** (proves no gh dependency), invoke the command function inside `captureLogs()`/`trapExit` (`tests/lib/capture.ts`). Register repos in a `repos[]` array cleaned in `afterAll` (never `afterEach` — breaks `--concurrent`).

---

## File structure

**Phase 1 (reorder engine fix):**

- Modify: `src/commands/group.ts` — reorder block routes through `rebasePlumbing`.
- Create: `tests/git/reorder-content.test.ts` — red test proving content loss, then green.
- (Possibly) Modify: `tests/commands/group.test.ts` if the TUI reorder assertion changes.

**Phase 2 (`view --json`):**

- Modify: `src/parse/types.ts` — add `StackTreeNode` / `StackTree` output+input element types + `PrState`/`PrDirective`.
- Create: `src/parse/stack-tree.ts` — `buildStackTree(enrichedUnits) → StackTree` (units → nested tree for output).
- Modify: `src/commands/view.ts` — `ViewOptions { cwd?; json? }`; `--json` branch prints `JSON.stringify(buildStackTree(...))`.
- Modify: `src/cli/index.ts` — `--json` on `view`.
- Create: `tests/commands/view.json.test.ts` — offline, seeded cache.

**Phase 3 (`group --apply`):**

- Create: `src/parse/apply-doc.ts` — `parseApplyDoc(json) → ParsedDoc | SchemaError`; `reconcile(doc, liveCommits, cache, records, config) → ReconcileResult | ReconcileError`. Pure, no git.
- Create: `src/lib/read-stdin.ts` — `readStdin(): Promise<string>`.
- Modify: `src/commands/group.ts` — `GroupOptions { cwd?; apply?; readStdin? }`; when `apply` set, skip TUI, run parse+reconcile, rejoin tail.
- Modify: `src/cli/index.ts` — `--apply <json>` on `group`.
- Create: `tests/parse/apply-doc.test.ts` — every schema + reconcile error, pure.
- Create: `tests/commands/group.apply.test.ts` — CLI integration, offline, seeded cache.
- Modify: `docs/rebuild-roadmap.md` — amend the "`sp group` helper capabilities — dropped" section.

---

## Phase 1 — Fix the reorder engine (standalone, full TDD)

**Why first:** `rewriteCommitChain` reuses each commit's original snapshot tree while re-parenting, so a reorder that changes the end-of-stack ordering silently drops commits' content. `--apply` exposes reorder to automation, so this must be correct before Phase 3. The fix repairs the interactive path too. `rebasePlumbing` already diff-replays correctly; we route reorder through it.

### Task 1: Red test — reorder must preserve all commits' content

**Files:**

- Create: `tests/git/reorder-content.test.ts`

- [ ] **Step 1: Write the failing test**

This test builds a 3-commit stack where each commit adds a _different_ file, reorders them, and asserts the final tree still contains **all three** files. Against the current `rewriteCommitChain`-based reorder this fails (content dropped); after the fix it passes. It drives the same helper the command uses, so it tests the real engine choice.

```ts
// tests/git/reorder-content.test.ts
import { test, expect, afterAll } from "bun:test";
import { createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/repo.ts";
import { getMergeBase, rebasePlumbing, finalizeRewrite } from "../../src/git/index.ts";

const repos: TestRepo[] = [];
afterAll(async () => {
  while (repos.length) await repos.pop()!.cleanup();
});

test("reorder preserves every commit's file content (no snapshot-tree loss)", async () => {
  const repo = await createRepo();
  repos.push(repo);
  await repo.git.run(["config", "spry.trunk", repo.defaultBranch], { cwd: repo.path });

  // trunk baseline
  await repo.commitFiles({ "base.txt": "base" }, "base");
  const trunkTip = await repo.currentBranch();

  // three commits, each adds its OWN file
  await repo.commitFiles({ "a.txt": "A" }, "add a");
  await repo.commitFiles({ "b.txt": "B" }, "add b");
  await repo.commitFiles({ "c.txt": "C" }, "add c");

  // hashes bottom→top
  const log = await repo.git.run(
    ["log", "--format=%H", `${repo.defaultBranch}~3..${repo.defaultBranch}`],
    { cwd: repo.path },
  );
  const hashesTopFirst = log.stdout.trim().split("\n"); // git log is newest-first
  const bottomToTop = [...hashesTopFirst].reverse(); // [a, b, c]
  const oldTip = hashesTopFirst[0]!; // c

  // reorder so a DIFFERENT commit ends up on top: [a, c, b]
  const newOrder = [bottomToTop[0]!, bottomToTop[2]!, bottomToTop[1]!];

  const mergeBase = await getMergeBase(repo.git, repo.defaultBranch, { cwd: repo.path });
  const result = await rebasePlumbing(repo.git, mergeBase, newOrder, { cwd: repo.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected clean reorder");
  await finalizeRewrite(repo.git, repo.defaultBranch, oldTip, result.newTip, { cwd: repo.path });

  // the working tree / tip must contain ALL THREE files
  const files = await repo.git.run(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo.path });
  const names = files.stdout.trim().split("\n");
  expect(names).toContain("a.txt");
  expect(names).toContain("b.txt");
  expect(names).toContain("c.txt");
  expect(names).toContain("base.txt");

  void trunkTip;
});
```

- [ ] **Step 2: Run the test to confirm it PASSES against `rebasePlumbing`**

Run: `bun test tests/git/reorder-content.test.ts`
Expected: PASS. (This test validates that `rebasePlumbing` is the correct engine. It is written against `rebasePlumbing` directly to lock in the correct behavior before we change the command to use it.)

> Note: this task proves the _engine_. Task 2 proves the _command_ uses it. If this test FAILS, stop — `rebasePlumbing` itself is broken and the whole plan's premise is wrong.

- [ ] **Step 3: Commit**

```bash
git add tests/git/reorder-content.test.ts
git commit -m "test(reorder): lock in rebasePlumbing content-preservation for reorder"
```

### Task 2: Route `sp group` reorder through `rebasePlumbing`

**Files:**

- Modify: `src/commands/group.ts` (the reorder block, currently ~lines 115-126)

- [ ] **Step 1: Read the current reorder block**

Run: `sed -n '114,140p' src/commands/group.ts`
Confirm it calls `rewriteCommitChain(ctx.git, result.newOrder, new Map(), { cwd, base: mergeBase })` then `finalizeRewrite(...)`.

- [ ] **Step 2: Replace the reorder block to diff-replay and bail on conflict**

Replace the existing reorder `if (result.newOrder) { ... }` block with:

```ts
  // Reorder commits if the stack order changed (diff-replay; bail on conflict)
  if (result.newOrder) {
    const oldTip = withTrailers.at(-1)?.hash;
    if (!oldTip) throw new Error("groupCommand: unexpected empty commit list");
    const mergeBase = await getMergeBase(ctx.git, ref, { cwd });
    const rebaseResult = await rebasePlumbing(ctx.git, mergeBase, result.newOrder, { cwd });
    if (!rebaseResult.ok) {
      console.error(
        `✗ Cannot reorder: commit ${rebaseResult.conflictCommit.slice(0, 8)} conflicts.\n${rebaseResult.conflictInfo}`,
      );
      process.exit(1);
    }
    await finalizeRewrite(ctx.git, branch, oldTip, rebaseResult.newTip, { cwd });
    console.log(`✓ Reordered ${result.newOrder.length} commits`);
  }
```

- [ ] **Step 3: Update the imports in `src/commands/group.ts`**

In the import block from `"../git/index.ts"`, remove `rewriteCommitChain` (if no longer used elsewhere in the file — grep to confirm) and add `rebasePlumbing`. Keep `finalizeRewrite`, `getMergeBase`.

Run to confirm `rewriteCommitChain` is not used elsewhere in the file:
`grep -n "rewriteCommitChain" src/commands/group.ts`
Expected after edit: no matches. If it still appears, leave the import.

Edit the import list so it includes `rebasePlumbing` and drops the now-unused `rewriteCommitChain`.

- [ ] **Step 4: Verify the engine test still passes and the file typechecks**

Run: `bun test tests/git/reorder-content.test.ts && bunx tsc --noEmit`
Expected: test PASS; no type errors. (If `bunx tsc` is not the project's typecheck command, run `bun run` with no args to list scripts and use the typecheck script; otherwise skip tsc and rely on `bun test`.)

- [ ] **Step 5: Run the existing group tests to catch regressions**

Run: `bun test tests/commands/group.test.ts tests/git/plumbing.test.ts`
Expected: PASS. If a TUI reorder test asserted a now-corrected (previously-lossy) behavior, update it to assert the correct content-preserving result and note the behavioral fix in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/commands/group.ts tests/
git commit -m "fix(group): reorder via rebasePlumbing diff-replay (was lossy snapshot reuse)

rewriteCommitChain reused each commit's original snapshot tree while
re-parenting, silently dropping content when a reorder changed the
top-of-stack commit. Route reorder through rebasePlumbing (per-commit
merge-tree diff-replay) and bail on conflict before any ref write."
```

### Task 3: Update the CHANGELOG for the reorder fix

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a changelog entry**

Open `CHANGELOG.md`, find the unreleased/top section, and add under a "Fixed" heading (matching the file's existing style):

```
- `sp group` reorder no longer silently drops commit content. Reordering now
  diff-replays each commit (via the same engine as `sp rebase`) and aborts with
  a conflict message instead of producing a corrupted stack.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note sp group reorder content-loss fix"
```

---

## Phase 2 — Shared JSON tree + `sp view --json`

Adds the nested tree type (shared by output and Phase 3 input) and a machine-only `--json` mode on `view`. Fully offline; PR state from the seeded cache. No doc test (machine-only output; see spec "Tests — no doc tests, no cassettes").

### Task 4: Define the nested stack-tree types

**Files:**

- Modify: `src/parse/types.ts` (append new types)

- [ ] **Step 1: Add the tree + PR types**

Append to `src/parse/types.ts`:

```ts
// --- Nested stack tree (sp view --json output; sp group --apply input) ---

// Output-only PR state object emitted by `view --json`.
export interface PrStateInfo {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
}

// A commit node. On output all fields are present; on input only `id`
// (real Spry-Commit-Id) is required, `reissueId`/`pr` are optional directives.
export interface StackTreeCommit {
  type: "commit";
  id: string;
  sha?: string; // output only
  subject?: string; // output only
  pr?: PrStateInfo | null | "CLOSE" | "ADOPT"; // output: state object|null; input: directive
  reissueId?: boolean; // input only
}

// A group node nesting an ordered array of commit nodes.
export interface StackTreeGroup {
  type: "group";
  id: string | null; // output: real id; input: real id (keep/adopt) or null (mint new group)
  title?: string | null; // output: current title|null; input: tri-state (see spec)
  pr?: PrStateInfo | null | "CLOSE" | "ADOPT";
  reissueId?: boolean; // input only
  commits: StackTreeCommit[];
}

export type StackTreeNode = StackTreeCommit | StackTreeGroup;

export interface StackTree {
  stack: StackTreeNode[];
}
```

- [ ] **Step 2: Typecheck**

Run: `bun test tests/parse/ 2>&1 | tail -5` (ensures nothing in parse broke) and confirm no import errors.
Expected: existing parse tests still PASS.

- [ ] **Step 3: Commit**

```bash
git add src/parse/types.ts
git commit -m "feat(parse): add nested StackTree types for view --json / group --apply"
```

### Task 5: Build the output tree from enriched units

**Files:**

- Create: `src/parse/stack-tree.ts`
- Create: `tests/parse/stack-tree.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/parse/stack-tree.test.ts
import { test, expect } from "bun:test";
import { buildStackTree } from "../../src/parse/stack-tree.ts";
import type { EnrichedUnit } from "../../src/gh/enrich.ts";
import type { PRUnit } from "../../src/parse/types.ts";

function single(id: string, subject: string, hash: string): PRUnit {
  return { type: "single", id, title: undefined, commitIds: [id], commits: [hash], subjects: [subject] };
}
function group(id: string, title: string, ids: string[], hashes: string[], subjects: string[]): PRUnit {
  return { type: "group", id, title, commitIds: ids, commits: hashes, subjects };
}

test("buildStackTree emits commit and group nodes with PR state", () => {
  const units: PRUnit[] = [
    single("aaaaaaaa", "feat: a", "hash_a"),
    group("bbbbbbbb", "My group", ["bbbbbbbb", "cccccccc"], ["hash_b", "hash_c"], ["feat: b", "feat: c"]),
  ];
  const enriched: EnrichedUnit[] = [
    { unit: units[0]!, pr: { number: 12, url: "", state: "OPEN", title: "", baseRefName: "", checksStatus: "NONE", reviewDecision: "NONE", reviewThreads: { resolved: 0, total: 0 } } },
    { unit: units[1]!, pr: null },
  ];

  const tree = buildStackTree(enriched);

  expect(tree.stack).toHaveLength(2);
  const c0 = tree.stack[0];
  expect(c0).toMatchObject({ type: "commit", id: "aaaaaaaa", sha: "hash_a", subject: "feat: a" });
  expect(c0.pr).toEqual({ number: 12, state: "OPEN" });

  const g = tree.stack[1];
  expect(g.type).toBe("group");
  if (g.type !== "group") throw new Error("expected group");
  expect(g).toMatchObject({ id: "bbbbbbbb", title: "My group" });
  expect(g.pr).toBeNull();
  expect(g.commits).toHaveLength(2);
  expect(g.commits[0]).toMatchObject({ type: "commit", id: "bbbbbbbb", sha: "hash_b", subject: "feat: b" });
  expect(g.commits[1]).toMatchObject({ type: "commit", id: "cccccccc", sha: "hash_c", subject: "feat: c" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/parse/stack-tree.test.ts`
Expected: FAIL — `buildStackTree` not defined.

- [ ] **Step 3: Implement `buildStackTree`**

```ts
// src/parse/stack-tree.ts
import type { EnrichedUnit } from "../gh/enrich.ts";
import type { PRInfo } from "../gh/pr.ts";
import type { StackTree, StackTreeNode, StackTreeCommit, PrStateInfo } from "./types.ts";

function prState(pr: PRInfo | null): PrStateInfo | null {
  if (!pr) return null;
  return { number: pr.number, state: pr.state };
}

function memberCommits(
  ids: string[],
  hashes: string[],
  subjects: string[],
): StackTreeCommit[] {
  return ids.map((id, i) => ({
    type: "commit",
    id,
    sha: hashes[i] ?? "",
    subject: subjects[i] ?? "",
  }));
}

export function buildStackTree(enriched: EnrichedUnit[]): StackTree {
  const stack: StackTreeNode[] = enriched.map(({ unit, pr }) => {
    if (unit.type === "group") {
      return {
        type: "group",
        id: unit.id,
        title: unit.title ?? null,
        pr: prState(pr ?? null),
        commits: memberCommits(unit.commitIds, unit.commits, unit.subjects),
      };
    }
    return {
      type: "commit",
      id: unit.id,
      sha: unit.commits[0] ?? "",
      subject: unit.subjects[0] ?? "",
      pr: prState(pr ?? null),
    };
  });
  return { stack };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/parse/stack-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parse/stack-tree.ts tests/parse/stack-tree.test.ts
git commit -m "feat(parse): buildStackTree — enriched units to nested output tree"
```

### Task 6: Add `--json` to `sp view`

**Files:**

- Modify: `src/commands/view.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/commands/view.json.test.ts`

- [ ] **Step 1: Write the failing CLI test (offline, seeded cache)**

```ts
// tests/commands/view.json.test.ts
import { test, expect, afterAll } from "bun:test";
import { viewCommand } from "../../src/commands/view.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { SpryContext, TestRepo } from "../lib/index.ts";
import { captureLogs } from "../lib/capture.ts";
import { savePRCache } from "../../src/gh/pr-cache.ts";
import type { PRCache } from "../../src/gh/pr-cache.ts";

const repos: TestRepo[] = [];
afterAll(async () => {
  while (repos.length) await repos.pop()!.cleanup();
});

function makeCtx(repo: TestRepo): SpryContext {
  const git = createRealGitRunner();
  return {
    git: { run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }) },
    gh: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }, // stub: proves no gh
  };
}

async function configuredRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const g = createRealGitRunner();
  await g.run(["config", "spry.trunk", repo.defaultBranch], { cwd: repo.path });
  await g.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await g.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
  return repo;
}

test("sp view --json emits a nested tree with seeded PR state, no gh", async () => {
  const repo = await configuredRepo();
  // one commit with a Spry-Commit-Id trailer so it forms a unit
  await repo.commitFiles(
    { "a.txt": "A" },
    "feat: a\n\nSpry-Commit-Id: aaaaaaaa",
  );

  // seed the PR cache directly (as if sync had fetched it)
  const cache: PRCache = {
    aaaaaaaa: {
      branch: "spry/test/aaaaaaaa",
      cachedAt: "2026-01-01T00:00:00.000Z",
      number: 42,
      url: "",
      state: "OPEN",
      title: "feat: a",
      baseRefName: repo.defaultBranch,
      checksStatus: "NONE",
      reviewDecision: "NONE",
      reviewThreads: { resolved: 0, total: 0 },
    },
  };
  await savePRCache(repo.git, cache, { cwd: repo.path });

  const ctx = makeCtx(repo);
  const logs = await captureLogs("view-json");
  try {
    await viewCommand(ctx, { cwd: repo.path, json: true });
  } finally {
    logs.restore();
  }

  const parsed = JSON.parse(logs.out.join("\n"));
  expect(parsed.stack).toHaveLength(1);
  expect(parsed.stack[0]).toMatchObject({ type: "commit", id: "aaaaaaaa", subject: "feat: a" });
  expect(parsed.stack[0].pr).toEqual({ number: 42, state: "OPEN" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/view.json.test.ts`
Expected: FAIL — `viewCommand` does not accept a second arg / no `--json` handling.

- [ ] **Step 3: Add `ViewOptions` and the `--json` branch to `viewCommand`**

Replace the signature and body of `viewCommand` in `src/commands/view.ts`. Add the import for `buildStackTree`, thread `cwd`, and branch on `json`:

```ts
import { buildStackTree } from "../parse/stack-tree.ts";

export interface ViewOptions {
  cwd?: string;
  json?: boolean;
}

export async function viewCommand(ctx: SpryContext, opts: ViewOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });
  const branch = await getCurrentBranch(ctx.git, { cwd });
  const ref = trunkRef(config);
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });

  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);
  const result = parseStack(withTrailers, groupTitles, commitGroups);

  if (!result.ok) {
    console.error(formatValidationError(result));
    process.exit(1);
  }

  const prCache = await loadPRCache(ctx.git, { cwd });
  const enriched: EnrichedUnit[] = enrichFromCache(result.units, prCache);

  if (opts.json) {
    console.log(JSON.stringify(buildStackTree(enriched), null, 2));
    return;
  }

  console.log(formatStackView(enriched, branch, commits.length, ref));
}
```

> Note: all existing `loadConfig(ctx.git)` etc. calls now pass `{ cwd }`. Confirm each helper accepts `{ cwd }` (they do — see queries/config signatures). The default `cwd: undefined` preserves current CLI behavior.

- [ ] **Step 4: Wire `--json` in the CLI**

In `src/cli/index.ts`, change the `view` registration from:

```ts
  .command("view")
  .description("View the current stack of commits with PR status")
  .action(() => viewCommand(ctx));
```

to:

```ts
  .command("view")
  .description("View the current stack of commits with PR status")
  .option("--json", "Emit the stack as machine-readable JSON")
  .action((opts: { json?: boolean }) => viewCommand(ctx, { json: opts.json }));
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/commands/view.json.test.ts tests/commands/view.doc.test.ts`
Expected: both PASS (the doc test proves the human path is unchanged; the json test proves the new path).

- [ ] **Step 6: Commit**

```bash
git add src/commands/view.ts src/cli/index.ts tests/commands/view.json.test.ts
git commit -m "feat(view): add machine-only --json stack output (offline, cache-backed)"
```

---

## Phase 3 — `sp group --apply`

The write side. A **pure** module (`parseApplyDoc` + `reconcile`) does all validation and produces a plan; the command wires it to git (reissue trailer rewrites + reorder + save + push), fully offline.

### Reconcile output contract (used by Tasks 7–11)

`reconcile` returns a discriminated result. On success it yields everything the command needs to mutate local state:

```ts
export interface ReconcilePlan {
  // Full desired group records (saveAllGroupRecords is a full replace).
  records: GroupRecords;
  // Spry-Commit-Ids to reissue (mint a fresh id, rewriting the trailer).
  reissueIds: string[];
  // Commit hash order for the whole stack, top-of-stack last (for rebasePlumbing).
  // null when order is unchanged from live.
  newOrder: string[] | null;
  // PR directives recorded for a later `sp sync` to execute. (Persisted as intent.)
  prCloses: string[]; // unit ids whose PR should be closed
  prAdopts: string[]; // group ids that adopt a member's PR
}

export type ReconcileResult =
  | { ok: true; plan: ReconcilePlan }
  | { ok: false; error: string };

export type ParseResult =
  | { ok: true; doc: ParsedDoc }
  | { ok: false; error: string };
```

`ParsedDoc` is the schema-validated shape (presence-tracked — see spec "omission ≠ null"):

```ts
export interface ParsedCommit {
  kind: "commit";
  id: string;             // required real id (schema error if absent/null)
  reissueId: boolean;     // default false
  pr?: "CLOSE" | "ADOPT"; // directive; undefined = none
}
export interface ParsedGroup {
  kind: "group";
  id: string | null;      // real id (keep/adopt) or null (mint new group)
  reissueId: boolean;
  pr?: "CLOSE" | "ADOPT";
  titleField: { set: false } | { set: true; value: string | null }; // tri-state presence
  members: ParsedCommit[]; // non-empty
}
export type ParsedNode = ParsedCommit | ParsedGroup;
export interface ParsedDoc { stack: ParsedNode[]; }
```

### Task 7: `parseApplyDoc` — schema validation (pure)

**Files:**

- Create: `src/parse/apply-doc.ts`
- Create: `tests/parse/apply-doc.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
// tests/parse/apply-doc.test.ts
import { test, expect } from "bun:test";
import { parseApplyDoc } from "../../src/parse/apply-doc.ts";

function ok(json: string) {
  const r = parseApplyDoc(json);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.doc;
}
function err(json: string): string {
  const r = parseApplyDoc(json);
  if (r.ok) throw new Error("expected error");
  return r.error;
}

test("malformed JSON errors", () => {
  expect(err("{not json")).toMatch(/json/i);
});

test("missing type errors", () => {
  expect(err(JSON.stringify({ stack: [{ id: "aaaaaaaa" }] }))).toMatch(/type/i);
});

test("commit with missing id errors (omission != null)", () => {
  expect(err(JSON.stringify({ stack: [{ type: "commit" }] }))).toMatch(/id/i);
});

test("commit with id:null errors (only new groups may be null)", () => {
  expect(err(JSON.stringify({ stack: [{ type: "commit", id: null }] }))).toMatch(/null/i);
});

test("sha present as input field errors", () => {
  expect(err(JSON.stringify({ stack: [{ type: "commit", id: "aaaaaaaa", sha: "deadbeef" }] }))).toMatch(/sha/i);
});

test("empty group errors", () => {
  expect(err(JSON.stringify({ stack: [{ type: "group", id: null, commits: [] }] }))).toMatch(/empty|member/i);
});

test("group with no commits key errors", () => {
  expect(err(JSON.stringify({ stack: [{ type: "group", id: null }] }))).toMatch(/commits/i);
});

test("reissueId:true with id:null errors (contradiction)", () => {
  expect(
    err(JSON.stringify({ stack: [{ type: "group", id: null, reissueId: true, commits: [{ type: "commit", id: "aaaaaaaa" }] }] })),
  ).toMatch(/reissue|contradiction|null/i);
});

test("pr value other than CLOSE/ADOPT errors", () => {
  expect(err(JSON.stringify({ stack: [{ type: "commit", id: "aaaaaaaa", pr: "MERGE" }] }))).toMatch(/pr/i);
});

test("duplicate commit id across positions errors", () => {
  expect(
    err(JSON.stringify({ stack: [{ type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "aaaaaaaa" }] })),
  ).toMatch(/duplicate/i);
});

test("title tri-state: omitted -> {set:false}, null -> {set:true,null}, string -> {set:true,value}", () => {
  const omitted = ok(JSON.stringify({ stack: [{ type: "group", id: null, commits: [{ type: "commit", id: "aaaaaaaa" }] }] }));
  const g0 = omitted.stack[0];
  if (g0.kind !== "group") throw new Error("group");
  expect(g0.titleField).toEqual({ set: false });

  const wiped = ok(JSON.stringify({ stack: [{ type: "group", id: null, title: null, commits: [{ type: "commit", id: "aaaaaaaa" }] }] }));
  const g1 = wiped.stack[0];
  if (g1.kind !== "group") throw new Error("group");
  expect(g1.titleField).toEqual({ set: true, value: null });

  const setStr = ok(JSON.stringify({ stack: [{ type: "group", id: "aaaaaaaa", title: "T", commits: [{ type: "commit", id: "aaaaaaaa" }] }] }));
  const g2 = setStr.stack[0];
  if (g2.kind !== "group") throw new Error("group");
  expect(g2.titleField).toEqual({ set: true, value: "T" });
});

test("empty title string is treated as wipe (set:true,null)", () => {
  const doc = ok(JSON.stringify({ stack: [{ type: "group", id: null, title: "", commits: [{ type: "commit", id: "aaaaaaaa" }] }] }));
  const g = doc.stack[0];
  if (g.kind !== "group") throw new Error("group");
  expect(g.titleField).toEqual({ set: true, value: null });
});

test("valid minimal doc parses", () => {
  const doc = ok(JSON.stringify({ stack: [{ type: "commit", id: "aaaaaaaa" }] }));
  expect(doc.stack).toHaveLength(1);
  expect(doc.stack[0]).toMatchObject({ kind: "commit", id: "aaaaaaaa", reissueId: false });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `bun test tests/parse/apply-doc.test.ts`
Expected: FAIL — `parseApplyDoc` not defined.

- [ ] **Step 3: Implement `parseApplyDoc`**

Key discipline: use `Object.prototype.hasOwnProperty` (via `in`) to distinguish **key absent** from **key present with null** (the spec's PUT/PATCH rule). Do NOT read `raw.title` and check for undefined — that conflates the two.

```ts
// src/parse/apply-doc.ts
import type { GroupRecords } from "./types.ts";

export interface ParsedCommit {
  kind: "commit";
  id: string;
  reissueId: boolean;
  pr?: "CLOSE" | "ADOPT";
}
export interface ParsedGroup {
  kind: "group";
  id: string | null;
  reissueId: boolean;
  pr?: "CLOSE" | "ADOPT";
  titleField: { set: false } | { set: true; value: string | null };
  members: ParsedCommit[];
}
export type ParsedNode = ParsedCommit | ParsedGroup;
export interface ParsedDoc {
  stack: ParsedNode[];
}
export type ParseResult = { ok: true; doc: ParsedDoc } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsePr(raw: Record<string, unknown>, where: string): "CLOSE" | "ADOPT" | undefined | string {
  if (!("pr" in raw)) return undefined;
  const pr = raw.pr;
  if (pr === "CLOSE" || pr === "ADOPT") return pr;
  return `Invalid pr directive on ${where}: expected "CLOSE" or "ADOPT"`;
}

function parseCommit(raw: unknown, where: string): ParsedCommit | string {
  if (!isObj(raw)) return `${where}: expected an object`;
  if (raw.type !== "commit") return `${where}: expected type "commit"`;
  if ("sha" in raw) return `${where}: "sha" is not an input field`;
  if (!("id" in raw)) return `${where}: missing required "id" (omission is not null)`;
  if (raw.id === null) return `${where}: commit id may not be null (only a new group may use id:null)`;
  if (typeof raw.id !== "string") return `${where}: "id" must be a string`;
  const reissueId = "reissueId" in raw ? raw.reissueId === true : false;
  if ("reissueId" in raw && typeof raw.reissueId !== "boolean")
    return `${where}: "reissueId" must be a boolean`;
  const pr = parsePr(raw, where);
  if (typeof pr === "string" && pr !== "CLOSE" && pr !== "ADOPT") return pr;
  return { kind: "commit", id: raw.id, reissueId, ...(pr ? { pr: pr as "CLOSE" | "ADOPT" } : {}) };
}

function parseGroup(raw: Record<string, unknown>, where: string): ParsedGroup | string {
  if ("sha" in raw) return `${where}: "sha" is not an input field`;
  if (!("id" in raw)) return `${where}: missing required "id" (use null to mint a new group)`;
  const id = raw.id;
  if (id !== null && typeof id !== "string") return `${where}: group "id" must be a string or null`;
  const reissueId = "reissueId" in raw ? raw.reissueId === true : false;
  if ("reissueId" in raw && typeof raw.reissueId !== "boolean")
    return `${where}: "reissueId" must be a boolean`;
  if (reissueId && id === null)
    return `${where}: reissueId:true cannot combine with id:null (contradiction)`;

  // title tri-state via key presence
  let titleField: ParsedGroup["titleField"];
  if (!("title" in raw)) {
    titleField = { set: false };
  } else if (raw.title === null || raw.title === "") {
    titleField = { set: true, value: null };
  } else if (typeof raw.title === "string") {
    titleField = { set: true, value: raw.title };
  } else {
    return `${where}: "title" must be a string, null, or omitted`;
  }

  if (!("commits" in raw)) return `${where}: group missing required "commits"`;
  if (!Array.isArray(raw.commits)) return `${where}: "commits" must be an array`;
  if (raw.commits.length === 0) return `${where}: group has no members (empty group)`;
  const members: ParsedCommit[] = [];
  for (let i = 0; i < raw.commits.length; i++) {
    const m = parseCommit(raw.commits[i], `${where}.commits[${i}]`);
    if (typeof m === "string") return m;
    members.push(m);
  }
  const pr = parsePr(raw, where);
  if (typeof pr === "string" && pr !== "CLOSE" && pr !== "ADOPT") return pr;
  return { kind: "group", id, reissueId, titleField, members, ...(pr ? { pr: pr as "CLOSE" | "ADOPT" } : {}) };
}

export function parseApplyDoc(json: string): ParseResult {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (!isObj(root) || !Array.isArray(root.stack))
    return { ok: false, error: `Document must be an object with a "stack" array` };

  const stack: ParsedNode[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < root.stack.length; i++) {
    const raw = root.stack[i];
    if (!isObj(raw)) return { ok: false, error: `stack[${i}]: expected an object` };
    let node: ParsedNode | string;
    if (raw.type === "commit") node = parseCommit(raw, `stack[${i}]`);
    else if (raw.type === "group") node = parseGroup(raw, `stack[${i}]`);
    else return { ok: false, error: `stack[${i}]: unknown type ${JSON.stringify(raw.type)}` };
    if (typeof node === "string") return { ok: false, error: node };

    // duplicate-id detection across all commit ids (top-level + members)
    const ids = node.kind === "commit" ? [node.id] : node.members.map((m) => m.id);
    for (const id of ids) {
      if (seenIds.has(id)) return { ok: false, error: `Duplicate commit id: ${id}` };
      seenIds.add(id);
    }
    // duplicate group ids
    if (node.kind === "group" && node.id !== null) {
      // a group id equal to one of its own members is legal; only flag if it
      // duplicates a NON-member already-seen id handled above via members set.
    }
    stack.push(node);
  }
  return { ok: true, doc: { stack } };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/parse/apply-doc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parse/apply-doc.ts tests/parse/apply-doc.test.ts
git commit -m "feat(parse): parseApplyDoc — schema validation for group --apply docs"
```

### Task 8: `reconcile` — validate against live stack + PR state (pure)

**Files:**

- Modify: `src/parse/apply-doc.ts` (add `reconcile` + result types)
- Modify: `tests/parse/apply-doc.test.ts` (add reconcile tests)

`reconcile` takes the parsed doc plus a snapshot of live state and produces a `ReconcilePlan` or a typed error. It is pure: live state is passed in as plain data (no git calls), so it is fully unit-testable.

Inputs:

- `liveIds: string[]` — Spry-Commit-Ids of the live stack, top-of-stack order (the caller derives this from `getStackCommits`+trailers).
- `liveHashById: Record<string, string>` — id → commit hash (for building `newOrder`).
- `liveGroups: GroupRecords` — current group records (for title-retain + adoption steady-state checks).
- `openPrIds: Set<string>` — unit ids that currently have an OPEN PR (derived from the cache via `enrichFromCache`, filtered to `state==="OPEN"`).

- [ ] **Step 1: Write failing reconcile tests**

```ts
// append to tests/parse/apply-doc.test.ts
import { parseApplyDoc, reconcile } from "../../src/parse/apply-doc.ts";
import type { GroupRecords } from "../../src/parse/types.ts";

function recOk(json: string, live: {
  liveIds: string[]; liveHashById: Record<string, string>; liveGroups?: GroupRecords; openPrIds?: string[];
}) {
  const p = parseApplyDoc(json);
  if (!p.ok) throw new Error(`parse failed: ${p.error}`);
  const r = reconcile(p.doc, {
    liveIds: live.liveIds,
    liveHashById: live.liveHashById,
    liveGroups: live.liveGroups ?? {},
    openPrIds: new Set(live.openPrIds ?? []),
  });
  if (!r.ok) throw new Error(`reconcile failed: ${r.error}`);
  return r.plan;
}
function recErr(json: string, live: {
  liveIds: string[]; liveHashById: Record<string, string>; liveGroups?: GroupRecords; openPrIds?: string[];
}): string {
  const p = parseApplyDoc(json);
  if (!p.ok) return p.error;
  const r = reconcile(p.doc, {
    liveIds: live.liveIds,
    liveHashById: live.liveHashById,
    liveGroups: live.liveGroups ?? {},
    openPrIds: new Set(live.openPrIds ?? []),
  });
  return r.ok ? "" : r.error;
}

const LIVE2 = { liveIds: ["aaaaaaaa", "bbbbbbbb"], liveHashById: { aaaaaaaa: "h_a", bbbbbbbb: "h_b" } };

test("reconcile: doc omits a live commit -> missing-id error", () => {
  expect(
    recErr(JSON.stringify({ stack: [{ type: "commit", id: "aaaaaaaa" }] }), LIVE2),
  ).toMatch(/missing|account/i);
});

test("reconcile: doc names a non-live id -> unknown-id error", () => {
  expect(
    recErr(JSON.stringify({ stack: [
      { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" }, { type: "commit", id: "cccccccc" },
    ] }), LIVE2),
  ).toMatch(/unknown|not.*live|not present/i);
});

test("reconcile: complete ungrouped doc -> empty records, order matches -> newOrder null", () => {
  const plan = recOk(JSON.stringify({ stack: [
    { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
  ] }), LIVE2);
  expect(plan.records).toEqual({});
  expect(plan.newOrder).toBeNull();
});

test("reconcile: reversed order -> newOrder is hashes in doc order", () => {
  const plan = recOk(JSON.stringify({ stack: [
    { type: "commit", id: "bbbbbbbb" }, { type: "commit", id: "aaaaaaaa" },
  ] }), LIVE2);
  expect(plan.newOrder).toEqual(["h_b", "h_a"]);
});

test("reconcile: new group (id:null) -> minted 8-hex id, members recorded", () => {
  const plan = recOk(JSON.stringify({ stack: [
    { type: "group", id: null, title: "G", commits: [
      { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
    ] },
  ] }), LIVE2);
  const ids = Object.keys(plan.records);
  expect(ids).toHaveLength(1);
  expect(ids[0]).toMatch(/^[0-9a-f]{8}$/);
  expect(plan.records[ids[0]!]).toEqual({ title: "G", members: ["aaaaaaaa", "bbbbbbbb"] });
});

test("reconcile: title omitted on existing group -> retains stored title", () => {
  // Existing group (id in liveGroups) = steady-state edit; no pr:ADOPT (would error).
  const liveGroups: GroupRecords = { aaaaaaaa: { title: "Old", members: ["aaaaaaaa", "bbbbbbbb"] } };
  const plan = recOk(JSON.stringify({ stack: [
    { type: "group", id: "aaaaaaaa", commits: [
      { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
    ] },
  ] }), { ...LIVE2, liveGroups, openPrIds: ["aaaaaaaa"] });
  expect(plan.records["aaaaaaaa"]!.title).toBe("Old");
});

test("reconcile: title null on group -> wiped to empty", () => {
  const liveGroups: GroupRecords = { aaaaaaaa: { title: "Old", members: ["aaaaaaaa", "bbbbbbbb"] } };
  const plan = recOk(JSON.stringify({ stack: [
    { type: "group", id: "aaaaaaaa", title: null, commits: [
      { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
    ] },
  ] }), { ...LIVE2, liveGroups, openPrIds: ["aaaaaaaa"] });
  expect(plan.records["aaaaaaaa"]!.title).toBe("");
});

test("reconcile: reissue a commit with open PR without pr:CLOSE -> error", () => {
  expect(
    recErr(JSON.stringify({ stack: [
      { type: "commit", id: "aaaaaaaa", reissueId: true }, { type: "commit", id: "bbbbbbbb" },
    ] }), { ...LIVE2, openPrIds: ["aaaaaaaa"] }),
  ).toMatch(/close|acknowledge/i);
});

test("reconcile: reissue with pr:CLOSE -> reissueIds + prCloses set", () => {
  const plan = recOk(JSON.stringify({ stack: [
    { type: "commit", id: "aaaaaaaa", reissueId: true, pr: "CLOSE" }, { type: "commit", id: "bbbbbbbb" },
  ] }), { ...LIVE2, openPrIds: ["aaaaaaaa"] });
  expect(plan.reissueIds).toContain("aaaaaaaa");
  expect(plan.prCloses).toContain("aaaaaaaa");
});

test("reconcile: pr:CLOSE where nothing would close -> error", () => {
  expect(
    recErr(JSON.stringify({ stack: [
      { type: "commit", id: "aaaaaaaa", pr: "CLOSE" }, { type: "commit", id: "bbbbbbbb" },
    ] }), LIVE2),
  ).toMatch(/nothing.*close|no.*pr/i);
});

test("reconcile: group adopts member PR (id=member) requires pr:ADOPT", () => {
  expect(
    recErr(JSON.stringify({ stack: [
      { type: "group", id: "aaaaaaaa", commits: [
        { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
      ] },
    ] }), { ...LIVE2, openPrIds: ["aaaaaaaa"] }),
  ).toMatch(/adopt/i);
});

test("reconcile: pr:ADOPT where declared id has no open PR -> error", () => {
  expect(
    recErr(JSON.stringify({ stack: [
      { type: "group", id: "aaaaaaaa", pr: "ADOPT", commits: [
        { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
      ] },
    ] }), LIVE2),
  ).toMatch(/adopt|no.*pr/i);
});

test("reconcile: group id equal to a NON-member live id -> foreign identity error", () => {
  const live3 = { liveIds: ["aaaaaaaa", "bbbbbbbb", "cccccccc"], liveHashById: { aaaaaaaa: "h_a", bbbbbbbb: "h_b", cccccccc: "h_c" } };
  expect(
    recErr(JSON.stringify({ stack: [
      { type: "group", id: "cccccccc", pr: "ADOPT", commits: [
        { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
      ] },
      { type: "commit", id: "cccccccc" },
    ] }), { ...live3, openPrIds: ["cccccccc"] }),
  ).toMatch(/foreign|not a member|member/i);
});

test("reconcile: existing group with a MINTED (non-member) id is editable, no ADOPT needed", () => {
  // A group created earlier with id:null got a minted id "99999999" that is NOT
  // any member's id. A round-tripped doc references it by that id; editing it
  // (e.g. renaming) must succeed WITHOUT pr:ADOPT and WITHOUT a foreign-identity error.
  const liveGroups: GroupRecords = { "99999999": { title: "Old", members: ["aaaaaaaa", "bbbbbbbb"] } };
  const plan = recOk(JSON.stringify({ stack: [
    { type: "group", id: "99999999", title: "Renamed", commits: [
      { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
    ] },
  ] }), { ...LIVE2, liveGroups });
  expect(plan.records["99999999"]).toEqual({ title: "Renamed", members: ["aaaaaaaa", "bbbbbbbb"] });
  expect(plan.prAdopts).not.toContain("99999999");
});

test("reconcile: pr:ADOPT on an already-existing (already-held) group -> error", () => {
  const liveGroups: GroupRecords = { aaaaaaaa: { title: "G", members: ["aaaaaaaa", "bbbbbbbb"] } };
  expect(
    recErr(JSON.stringify({ stack: [
      { type: "group", id: "aaaaaaaa", pr: "ADOPT", commits: [
        { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
      ] },
    ] }), { ...LIVE2, liveGroups, openPrIds: ["aaaaaaaa"] }),
  ).toMatch(/already holds|remove pr:ADOPT|adopt/i);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `bun test tests/parse/apply-doc.test.ts`
Expected: FAIL — `reconcile` not defined.

- [ ] **Step 3: Implement `reconcile`**

Add to `src/parse/apply-doc.ts`:

```ts
import { generateCommitId } from "./id.ts";

export interface ReconcilePlan {
  records: GroupRecords;
  reissueIds: string[];
  newOrder: string[] | null;
  prCloses: string[];
  prAdopts: string[];
}
export type ReconcileResult = { ok: true; plan: ReconcilePlan } | { ok: false; error: string };

export interface LiveState {
  liveIds: string[];
  liveHashById: Record<string, string>;
  liveGroups: GroupRecords;
  openPrIds: Set<string>;
}

export function reconcile(doc: ParsedDoc, live: LiveState): ReconcileResult {
  const liveSet = new Set(live.liveIds);

  // Flatten doc into ordered member ids + collect nodes.
  const docOrder: string[] = [];
  const docIds = new Set<string>();
  for (const node of doc.stack) {
    const ids = node.kind === "commit" ? [node.id] : node.members.map((m) => m.id);
    for (const id of ids) {
      docOrder.push(id);
      docIds.add(id);
    }
  }

  // Unknown id: any doc id not live.
  for (const id of docOrder) {
    if (!liveSet.has(id)) return { ok: false, error: `Unknown id (not in live stack): ${id}` };
  }
  // Missing id: any live id the doc omits (strict completeness).
  const missing = live.liveIds.filter((id) => !docIds.has(id));
  if (missing.length > 0)
    return { ok: false, error: `Doc does not account for live commit(s): ${missing.join(", ")}` };

  const records: GroupRecords = {};
  const reissueIds: string[] = [];
  const prCloses: string[] = [];
  const prAdopts: string[] = [];

  // Per-node validation + record building.
  for (const node of doc.stack) {
    if (node.kind === "commit") {
      handleReissueAndClose(node, live, reissueIds, prCloses);
      const err = checkPr(node, live);
      if (err) return { ok: false, error: err };
      continue;
    }

    // group
    const memberIds = node.members.map((m) => m.id);

    // member-level reissue/close directives (directives attach to identity, incl. nested)
    for (const m of node.members) {
      handleReissueAndClose(m, live, reissueIds, prCloses);
      const err = checkPr(m, live);
      if (err) return { ok: false, error: err };
    }

    // resolve group id + adoption
    //
    // A group id can be legitimate in three ways:
    //   1. id:null            -> a brand-new group; mint a fresh id.
    //   2. id in liveGroups   -> an EXISTING group (its id may be a minted
    //                            non-member id from a prior `id:null` create,
    //                            OR a member id it adopted earlier). Editing an
    //                            existing group is always allowed regardless of
    //                            membership — this is the steady-state edit path.
    //   3. id is a live commit id that is one of this group's own members
    //                          -> a NEW adoption of that member's identity/PR.
    // Anything else (a real id that is neither an existing group nor a member)
    // is a foreign-identity error.
    let groupId: string;
    if (node.id === null) {
      // new group, fresh mint. pr must not be ADOPT (nothing to adopt).
      if (node.pr === "ADOPT")
        return { ok: false, error: `New group (id:null) cannot pr:ADOPT — it inherits no PR` };
      groupId = generateCommitId();
    } else if (node.id in live.liveGroups) {
      // (2) existing group — steady-state edit. Identity already held; no
      // adoption transition occurs, so pr:ADOPT is forbidden here.
      groupId = node.id;
      if (node.pr === "ADOPT")
        return { ok: false, error: `Group ${node.id} already holds its PR; remove pr:ADOPT` };
    } else if (memberIds.includes(node.id)) {
      // (3) new adoption of a member's identity. Requires an actual open PR to
      // adopt AND explicit pr:ADOPT acknowledgment (adoption transition).
      groupId = node.id;
      if (!live.openPrIds.has(node.id))
        return { ok: false, error: `Group id ${node.id} has no open PR to adopt` };
      if (node.pr !== "ADOPT")
        return {
          ok: false,
          error: `Group adopts PR of ${node.id}; add "pr":"ADOPT" to acknowledge`,
        };
      prAdopts.push(groupId);
    } else {
      // real id that is neither an existing group nor one of its own members.
      return {
        ok: false,
        error: `Group id ${node.id} is not a member of its own group (foreign identity)`,
      };
    }

    // group reissue
    if (node.reissueId) {
      // reissuing the group's identity closes its PR (if held) — needs pr:CLOSE.
      if (live.openPrIds.has(groupId) && node.pr !== "CLOSE")
        return { ok: false, error: `Reissuing group ${groupId} closes its PR; add "pr":"CLOSE"` };
      reissueIds.push(groupId);
      if (live.openPrIds.has(groupId)) prCloses.push(groupId);
    }

    // title tri-state
    let title: string;
    if (node.titleField.set) {
      title = node.titleField.value ?? "";
    } else {
      title = live.liveGroups[node.id ?? ""]?.title ?? "";
    }

    records[groupId] = { title, members: memberIds };
  }

  // Build newOrder if the flattened order differs from live.
  const sameOrder =
    docOrder.length === live.liveIds.length && docOrder.every((id, i) => id === live.liveIds[i]);
  const newOrder = sameOrder ? null : docOrder.map((id) => live.liveHashById[id]!);

  return { ok: true, plan: { records, reissueIds, newOrder, prCloses, prAdopts } };
}

function handleReissueAndClose(
  node: ParsedCommit,
  live: LiveState,
  reissueIds: string[],
  prCloses: string[],
): void {
  if (node.reissueId) {
    reissueIds.push(node.id);
    if (live.openPrIds.has(node.id) && node.pr === "CLOSE") prCloses.push(node.id);
  }
}

// Validate a unit's pr directive against whether a transition actually occurs.
function checkPr(node: ParsedCommit, live: LiveState): string | null {
  const hasOpen = live.openPrIds.has(node.id);
  if (node.pr === "CLOSE") {
    // CLOSE is only valid if this apply would close an open PR: i.e. reissue of a unit with an open PR.
    const wouldClose = node.reissueId && hasOpen;
    if (!wouldClose) return `pr:"CLOSE" on ${node.id} but nothing would close`;
  }
  if (node.reissueId && hasOpen && node.pr !== "CLOSE") {
    return `Reissuing ${node.id} closes its open PR; add "pr":"CLOSE"`;
  }
  // ADOPT is not valid on a commit unit.
  if (node.pr === "ADOPT") return `pr:"ADOPT" is only valid on a group that adopts a member's PR`;
  return null;
}
```

> Note: `checkPr` is called for commit units (top-level and members). Group-level ADOPT/CLOSE is handled inline in the group branch. Keep the two paths distinct — a commit can never ADOPT.

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/parse/apply-doc.test.ts`
Expected: PASS (all schema + reconcile tests).

- [ ] **Step 5: Commit**

```bash
git add src/parse/apply-doc.ts tests/parse/apply-doc.test.ts
git commit -m "feat(parse): reconcile apply-doc against live stack + PR state (pure)"
```

### Task 9: `readStdin` helper + reissue trailer-replace helper

**Files:**

- Create: `src/lib/read-stdin.ts`
- Modify: `src/parse/trailers.ts` (add `replaceCommitId`)
- Create: `tests/parse/replace-commit-id.test.ts`

- [ ] **Step 1: Implement `readStdin`**

```ts
// src/lib/read-stdin.ts
// Reads all of process stdin as UTF-8 text. Used for `sp group --apply -`.
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **Step 2: Write failing test for `replaceCommitId`**

The existing `addTrailers` uses `interpret-trailers --trailer` which _appends_; reissue must _replace_ the existing `Spry-Commit-Id`. This helper uses `--if-exists replace --if-missing add`.

```ts
// tests/parse/replace-commit-id.test.ts
import { test, expect } from "bun:test";
import { replaceCommitId } from "../../src/parse/trailers.ts";
import { createRealGitRunner } from "../../src/lib/context.ts";

test("replaceCommitId replaces an existing Spry-Commit-Id (no duplicate)", async () => {
  const git = createRealGitRunner();
  const msg = "feat: x\n\nSpry-Commit-Id: aaaaaaaa\n";
  const out = await replaceCommitId(msg, "bbbbbbbbb", git);
  const matches = out.match(/Spry-Commit-Id:/g) ?? [];
  expect(matches).toHaveLength(1);
  expect(out).toContain("Spry-Commit-Id: bbbbbbbb");
  expect(out).not.toContain("aaaaaaaa");
});

test("replaceCommitId adds when missing", async () => {
  const git = createRealGitRunner();
  const out = await replaceCommitId("feat: y\n", "cccccccc", git);
  expect(out).toContain("Spry-Commit-Id: cccccccc");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/parse/replace-commit-id.test.ts`
Expected: FAIL — `replaceCommitId` not defined.

- [ ] **Step 4: Implement `replaceCommitId`**

Add to `src/parse/trailers.ts`:

```ts
export async function replaceCommitId(
  message: string,
  newId: string,
  git: GitRunner,
): Promise<string> {
  const normalized = message.endsWith("\n") ? message : message + "\n";
  const result = await git.run(
    [
      "interpret-trailers",
      "--if-exists",
      "replace",
      "--if-missing",
      "add",
      "--trailer",
      `Spry-Commit-Id: ${newId}`,
    ],
    { stdin: normalized },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git interpret-trailers (replace) failed: ${result.stderr}`);
  }
  return result.stdout.trimEnd();
}
```

Confirm `GitRunner` is already imported in `src/parse/trailers.ts` (it is used by `addTrailers`). If not, add `import type { GitRunner } from "../lib/context.ts";`.

- [ ] **Step 5: Run to verify pass**

Run: `bun test tests/parse/replace-commit-id.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/read-stdin.ts src/parse/trailers.ts tests/parse/replace-commit-id.test.ts
git commit -m "feat: readStdin + replaceCommitId helpers for group --apply reissue"
```

### Task 10: Wire `--apply` into `groupCommand`

**Files:**

- Modify: `src/commands/group.ts`
- Modify: `src/cli/index.ts`

The `--apply` path: read JSON → `parseApplyDoc` → derive live state → `reconcile` → apply reissues (trailer rewrites) → apply reorder (via the Phase 1 `rebasePlumbing` path) → `saveAllGroupRecords` → persist PR intents → `pushGroupRecords`. It must NOT call `findPRsForBranches` (offline). PR intents (`prCloses`/`prAdopts`) are recorded via the PR cache for a later `sync` to execute — see sub-step for how.

- [ ] **Step 1: Extend `GroupOptions` and branch at the top of `groupCommand`**

Change `GroupOptions`:

```ts
export interface GroupOptions {
  cwd?: string;
  apply?: string; // JSON string, or "-" to read stdin
  readStdin?: () => Promise<string>; // test seam; defaults to the real readStdin
}
```

At the very start of `groupCommand` (after `const cwd = opts.cwd;`), branch to the non-interactive path:

```ts
  if (opts.apply !== undefined) {
    return applyGroupDoc(ctx, opts, cwd);
  }
```

Leave the entire existing interactive body unchanged below that.

- [ ] **Step 2: Implement `applyGroupDoc`**

Add this function to `src/commands/group.ts`. It reuses the verified helpers. Imports to add: `parseApplyDoc`, `reconcile` from `../parse/apply-doc.ts`; `loadPRCache`, `savePRCache` from `../gh/pr-cache.ts`; `replaceCommitId` from `../parse/trailers.ts`; `getCommitMessage`, `rewriteCommitChain` from `../git/index.ts`; `generateCommitId` from `../parse/id.ts`; `readStdin` from `../lib/read-stdin.ts`. Also confirm `getStackCommits`, `injectMissingIds`, `getMergeBase`, `rebasePlumbing`, `finalizeRewrite`, `registerBranch`, `loadGroupRecords`, `saveAllGroupRecords`, `pushGroupRecords`, `parseCommitTrailers`, `loadConfig`, `getCurrentBranch`, `trunkRef`, and `kleur` are already imported in the file (most are, from the interactive path) and add any that are missing. (`enrichFromCache` is NOT needed — open-PR ids are read directly from the cache by state.) Confirm exact export names via grep before writing imports.

```ts
async function applyGroupDoc(ctx: SpryContext, opts: GroupOptions, cwd: string | undefined): Promise<void> {
  const config = await loadConfig(ctx.git, { cwd });
  const branch = await getCurrentBranch(ctx.git, { cwd });
  const ref = trunkRef(config);

  // Read the JSON (string arg, or "-" for stdin).
  const readStdinFn = opts.readStdin ?? readStdin;
  const json = opts.apply === "-" ? await readStdinFn() : (opts.apply ?? "");

  const parsed = parseApplyDoc(json);
  if (!parsed.ok) {
    console.error(`✗ ${parsed.error}`);
    process.exit(1);
  }

  // Ensure every live commit has an id (so ids are stable handles).
  const inject = await injectMissingIds(ctx.git, ref, { cwd });
  if (!inject.ok) {
    console.error("✗ Cannot run from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }
  await registerBranch(ctx.git, branch, { cwd });

  // Snapshot live state.
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });
  const liveIds: string[] = [];
  const liveHashById: Record<string, string> = {};
  for (const c of withTrailers) {
    const id = c.trailers["Spry-Commit-Id"];
    if (!id) {
      console.error(`✗ Commit ${c.hash.slice(0, 8)} has no Spry-Commit-Id after inject; aborting.`);
      process.exit(1);
    }
    liveIds.push(id);
    liveHashById[id] = c.hash;
  }

  const liveGroups = await loadGroupRecords(ctx.git, { cwd });

  // Open-PR ids strictly from the local cache (offline; no gh).
  const prCache = await loadPRCache(ctx.git, { cwd });
  const openPrIds = new Set<string>();
  for (const [unitId, entry] of Object.entries(prCache)) {
    if (entry.state === "OPEN") openPrIds.add(unitId);
  }

  const rec = reconcile(parsed.doc, { liveIds, liveHashById, liveGroups, openPrIds });
  if (!rec.ok) {
    console.error(`✗ ${rec.error}`);
    process.exit(1);
  }
  const plan = rec.plan;

  // 1) Reissue ids (rewrite Spry-Commit-Id trailers) if any.
  if (plan.reissueIds.length > 0) {
    const oldTip = withTrailers.at(-1)?.hash;
    if (!oldTip) throw new Error("applyGroupDoc: empty stack");
    const mergeBase = await getMergeBase(ctx.git, ref, { cwd });
    const reissueSet = new Set(plan.reissueIds);
    const messageRewrites = new Map<string, string>();
    for (const c of withTrailers) {
      const id = c.trailers["Spry-Commit-Id"]!;
      if (!reissueSet.has(id)) continue;
      const fullMsg = await getCommitMessage(ctx.git, c.hash, { cwd });
      const newId = generateCommitId();
      messageRewrites.set(c.hash, await replaceCommitId(fullMsg, newId, ctx.git));
      // NOTE: a reissued id changes the unit's identity. plan.records/newOrder
      // were computed against OLD ids; see Step 3 for how the order/records map.
    }
    const rewritten = await rewriteCommitChain(ctx.git, withTrailers.map((c) => c.hash), messageRewrites, { cwd, base: mergeBase });
    await finalizeRewrite(ctx.git, branch, oldTip, rewritten.newTip, { cwd });
  }

  // 2) Reorder (if requested) — re-derive live hashes after any reissue rewrite.
  if (plan.newOrder) {
    const freshCommits = await getStackCommits(ctx.git, ref, { cwd });
    const freshTrailers = await parseCommitTrailers(freshCommits, ctx.git, { cwd });
    // map OLD id -> fresh hash is not possible after reissue; so reorder BEFORE reissue is disallowed here.
    // For v1: reorder is expressed by doc order of ids; recompute hashes by id from freshTrailers.
    const hashById: Record<string, string> = {};
    for (const c of freshTrailers) hashById[c.trailers["Spry-Commit-Id"]!] = c.hash;
    // plan.newOrder holds OLD hashes; translate via original liveHashById inverse is unsafe post-reissue.
    // Guard: v1 forbids combining reissue + reorder in one apply (see Step 4 validation).
    const oldTip = freshTrailers.at(-1)?.hash;
    if (!oldTip) throw new Error("applyGroupDoc: empty stack after reissue");
    const mergeBase = await getMergeBase(ctx.git, ref, { cwd });
    const rebaseResult = await rebasePlumbing(ctx.git, mergeBase, plan.newOrder, { cwd });
    if (!rebaseResult.ok) {
      console.error(`✗ Cannot reorder: commit ${rebaseResult.conflictCommit.slice(0, 8)} conflicts.\n${rebaseResult.conflictInfo}`);
      process.exit(1);
    }
    await finalizeRewrite(ctx.git, branch, oldTip, rebaseResult.newTip, { cwd });
    void hashById;
  }

  // 3) Save group records (full replace).
  await saveAllGroupRecords(ctx.git, plan.records, { cwd });

  // 4) Persist PR intents into the cache for `sp sync` to execute.
  if (plan.prCloses.length > 0) {
    const cache = await loadPRCache(ctx.git, { cwd });
    for (const id of plan.prCloses) {
      const entry = cache[id];
      if (entry) entry.state = "CLOSED"; // mark intent; sync reconciles with remote
    }
    await savePRCache(ctx.git, cache, { cwd });
  }

  // 5) Push group records best-effort.
  const pushResult = await pushGroupRecords(ctx.git, config.remote, { cwd });
  if (!pushResult.ok) {
    console.log(kleur.dim("⚠ Could not push group records to remote (local changes saved)"));
  }

  const groupCount = Object.keys(plan.records).length;
  console.log(`✓ Applied (${groupCount} group${groupCount === 1 ? "" : "s"})`);
}
```

> **IMPORTANT scope guard (implement in Task 8 reconcile or here):** combining **reissue + reorder in a single apply** makes `plan.newOrder` (old hashes) stale after the trailer rewrite. For v1, `reconcile` must return an error if `reissueIds.length > 0 && newOrder !== null`. Add this check to `reconcile` and a test: `recErr(...)` with both a reissue and a reversed order → `/reorder.*reissue|one at a time/`. This keeps the command logic above sound (only one of the two rewrites runs per apply).

- [ ] **Step 3: Add the reissue+reorder mutual-exclusion to `reconcile`**

In `reconcile`, just before the final `return { ok: true, plan: ... }`, add:

```ts
  if (reissueIds.length > 0 && newOrder !== null) {
    return {
      ok: false,
      error: `An apply cannot both reissue ids and reorder commits in one pass; do them in separate applies`,
    };
  }
```

Add the matching test to `tests/parse/apply-doc.test.ts`:

```ts
test("reconcile: reissue + reorder in one doc -> error", () => {
  expect(
    recErr(JSON.stringify({ stack: [
      { type: "commit", id: "bbbbbbbb" },
      { type: "commit", id: "aaaaaaaa", reissueId: true, pr: "CLOSE" },
    ] }), { ...LIVE2, openPrIds: ["aaaaaaaa"] }),
  ).toMatch(/reorder.*reissue|separate/i);
});
```

- [ ] **Step 4: Wire `--apply` in the CLI**

In `src/cli/index.ts`, change the `group` registration from:

```ts
  .command("group")
  .description("Interactively group and reorder commits")
  .action(() => groupCommand(ctx));
```

to:

```ts
  .command("group")
  .description("Interactively group and reorder commits")
  .option("--apply <json>", 'Apply a grouping doc non-interactively ("-" reads stdin)')
  .action((opts: { apply?: string }) => groupCommand(ctx, { apply: opts.apply }));
```

- [ ] **Step 5: Typecheck + run pure tests**

Run: `bun test tests/parse/apply-doc.test.ts`
Expected: PASS (including the new mutual-exclusion test).

- [ ] **Step 6: Commit**

```bash
git add src/commands/group.ts src/cli/index.ts src/parse/apply-doc.ts tests/parse/apply-doc.test.ts
git commit -m "feat(group): non-interactive --apply path (offline, cache-backed)"
```

### Task 11: CLI integration tests for `--apply` (offline, seeded)

**Files:**

- Create: `tests/commands/group.apply.test.ts`

These drive the real `groupCommand` function (pattern A — no binary spawn, no TTY), against a scratch repo, with the PR cache seeded directly and `gh` stubbed to prove no gh dependency. Ids are random, so assertions check structure and group-record shape, not literal ids.

- [ ] **Step 1: Write the integration test file**

```ts
// tests/commands/group.apply.test.ts
import { test, expect, afterAll } from "bun:test";
import { groupCommand } from "../../src/commands/group.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { SpryContext, TestRepo } from "../lib/index.ts";
import { captureLogs, trapExit } from "../lib/capture.ts";
import { loadGroupRecords } from "../../src/git/group-titles.ts";
import { savePRCache } from "../../src/gh/pr-cache.ts";
import type { PRCache } from "../../src/gh/pr-cache.ts";

const repos: TestRepo[] = [];
afterAll(async () => {
  while (repos.length) await repos.pop()!.cleanup();
});

function makeCtx(repo: TestRepo): SpryContext {
  const git = createRealGitRunner();
  return {
    git: { run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }) },
    gh: { run: async () => { throw new Error("gh must not be called by --apply"); } },
  };
}

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const g = createRealGitRunner();
  await g.run(["config", "spry.trunk", repo.defaultBranch], { cwd: repo.path });
  await g.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await g.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
  return repo;
}

// Returns the live Spry-Commit-Ids bottom->top.
async function liveIds(repo: TestRepo): Promise<string[]> {
  const log = await repo.git.run(
    ["log", "--format=%H", `${repo.defaultBranch}..HEAD`],
    { cwd: repo.path },
  );
  const hashesTopFirst = log.stdout.trim() ? log.stdout.trim().split("\n") : [];
  const ids: string[] = [];
  for (const h of hashesTopFirst.reverse()) {
    const body = await repo.git.run(["log", "-1", "--format=%B", h], { cwd: repo.path });
    const m = body.stdout.match(/Spry-Commit-Id:\s*([0-9a-f]+)/);
    if (m) ids.push(m[1]!);
  }
  return ids;
}

async function applyDoc(repo: TestRepo, docObj: unknown): Promise<{ out: string[]; err: string[]; code: number | undefined }> {
  const ctx = makeCtx(repo);
  const logs = await captureLogs("group-apply");
  const trap = trapExit();
  try {
    await groupCommand(ctx, { cwd: repo.path, apply: JSON.stringify(docObj) });
  } catch {
    // process.exit is trapped; swallow the thrown sentinel if trapExit throws
  } finally {
    trap.restore();
    logs.restore();
  }
  return { out: logs.out, err: logs.err, code: trap.exitCode };
}

test("--apply creates a group from two commits (offline, no gh)", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base");
  // two commits WITHOUT ids; --apply injects them, so read them back after a no-op first? Instead seed ids:
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const res = await applyDoc(repo, {
    stack: [
      { type: "group", id: null, title: "My group", commits: [
        { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
      ] },
    ],
  });

  expect(res.code).toBeUndefined(); // no exit(1)
  const records = await loadGroupRecords(repo.git, { cwd: repo.path });
  const ids = Object.keys(records);
  expect(ids).toHaveLength(1);
  expect(ids[0]).toMatch(/^[0-9a-f]{8}$/);
  expect(records[ids[0]!]).toEqual({ title: "My group", members: ["aaaaaaaa", "bbbbbbbb"] });
});

test("--apply dissolves a group by listing members ungrouped", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");
  // first create a group
  await applyDoc(repo, { stack: [
    { type: "group", id: null, title: "G", commits: [
      { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
    ] },
  ] });

  // now dissolve: list members ungrouped
  const res = await applyDoc(repo, { stack: [
    { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
  ] });
  expect(res.code).toBeUndefined();
  const records = await loadGroupRecords(repo.git, { cwd: repo.path });
  expect(Object.keys(records)).toHaveLength(0);
});

test("--apply errors (exit 1) when doc omits a live commit", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const res = await applyDoc(repo, { stack: [{ type: "commit", id: "aaaaaaaa" }] });
  expect(res.code).toBe(1);
  expect(res.err.join("\n")).toMatch(/account|missing/i);
});

test("--apply reissues a commit id when reissueId:true (id changes)", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const res = await applyDoc(repo, { stack: [
    { type: "commit", id: "aaaaaaaa", reissueId: true }, // no open PR -> no pr:CLOSE needed
    { type: "commit", id: "bbbbbbbb" },
  ] });
  expect(res.code).toBeUndefined();
  const ids = await liveIds(repo);
  expect(ids).toContain("bbbbbbbb");
  expect(ids).not.toContain("aaaaaaaa"); // reissued to a fresh id
  expect(ids.some((id) => /^[0-9a-f]{8}$/.test(id) && id !== "bbbbbbbb")).toBe(true);
});

test("--apply group adopts a member's open PR with pr:ADOPT (seeded cache)", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");
  const cache: PRCache = {
    aaaaaaaa: { branch: "spry/test/aaaaaaaa", cachedAt: "2026-01-01T00:00:00.000Z", number: 7, url: "", state: "OPEN", title: "feat: a", baseRefName: repo.defaultBranch, checksStatus: "NONE", reviewDecision: "NONE", reviewThreads: { resolved: 0, total: 0 } },
  };
  await savePRCache(repo.git, cache, { cwd: repo.path });

  const res = await applyDoc(repo, { stack: [
    { type: "group", id: "aaaaaaaa", title: "G", pr: "ADOPT", commits: [
      { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
    ] },
  ] });
  expect(res.code).toBeUndefined();
  const records = await loadGroupRecords(repo.git, { cwd: repo.path });
  expect(records["aaaaaaaa"]).toEqual({ title: "G", members: ["aaaaaaaa", "bbbbbbbb"] });
});

test("--apply errors when a group would adopt without pr:ADOPT", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");
  const cache: PRCache = {
    aaaaaaaa: { branch: "spry/test/aaaaaaaa", cachedAt: "2026-01-01T00:00:00.000Z", number: 7, url: "", state: "OPEN", title: "feat: a", baseRefName: repo.defaultBranch, checksStatus: "NONE", reviewDecision: "NONE", reviewThreads: { resolved: 0, total: 0 } },
  };
  await savePRCache(repo.git, cache, { cwd: repo.path });

  const res = await applyDoc(repo, { stack: [
    { type: "group", id: "aaaaaaaa", title: "G", commits: [
      { type: "commit", id: "aaaaaaaa" }, { type: "commit", id: "bbbbbbbb" },
    ] },
  ] });
  expect(res.code).toBe(1);
  expect(res.err.join("\n")).toMatch(/adopt/i);
});
```

- [ ] **Step 2: Run the integration tests**

Run: `bun test tests/commands/group.apply.test.ts`
Expected: PASS. If the `gh must not be called` stub throws during a test, that means the `--apply` path reached `gh` — fix the command to read only the cache (this is the offline invariant; do not "fix" it by loosening the stub).

- [ ] **Step 3: Commit**

```bash
git add tests/commands/group.apply.test.ts
git commit -m "test(group): offline CLI integration tests for --apply (seeded cache, gh forbidden)"
```

### Task 12: Update roadmap + changelog

**Files:**

- Modify: `docs/rebuild-roadmap.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Amend the roadmap**

In `docs/rebuild-roadmap.md`, find the "### `sp group` helper capabilities — dropped" section. Append a paragraph noting `--apply` is now redesigned rebuild-native:

```
**Update (2026-07-21): `--apply` resurfaced, redesigned rebuild-native.** `sp group
--apply <json>` now exists as a declarative, nested final-state document
reconciled against `refs/spry/groups` and the live stack — identity-based PR
handling (retained ids; `id:null`/`reissueId` mint; `pr:"CLOSE"`/`"ADOPT"`
acknowledge transitions), offline (no `gh`), executed-by-`sync` PR intent. A
machine-only `sp view --json` provides the read side. `--fix` and explicit
`dissolve` remain dropped (dissolution is expressed by ungrouping). See
`docs/superpowers/specs/2026-07-21-scriptable-sp-group-design.md`.
```

- [ ] **Step 2: Add changelog entries**

In `CHANGELOG.md`, under the unreleased "Added" heading (matching existing style):

```
- `sp group --apply <json>` — non-interactive, offline grouping for agents and
  scripts. Accepts a declarative nested stack document (or `-` for stdin),
  reconciles it against the live stack, and applies grouping, reorder, id
  reissue, and PR close/adopt intents. Never calls GitHub; PR changes are
  recorded for the next `sp sync` to execute.
- `sp view --json` — machine-readable stack output (the read side for
  `sp group --apply`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/rebuild-roadmap.md CHANGELOG.md
git commit -m "docs: record scriptable sp group (--apply) in roadmap + changelog"
```

### Task 13: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full offline suite**

Run: `bun run test:concurrent`
Expected: all PASS. Investigate any failure before proceeding — do not merge red.

- [ ] **Step 2: Confirm no cassettes/doc fragments were added for the new surfaces**

Run: `git status --porcelain tests/fixtures/cassettes/ docs/generated/`
Expected: no changes. The new features are offline and machine-only by design; any cassette or generated-doc churn here means something reached `gh` or a `docTest` slipped in — fix it.

- [ ] **Step 3: Pre-merge record + playback gate (per AGENTS.md)**

Because this branch changes command code, run the AGENTS.md pre-merge gate to prove record mode and doc stability are unaffected:

```bash
bun run docs:clean
bun run record          # SPRY_RECORD=1 bun test --concurrent (mutates spry-check)
bun run docs:build
bun test
bun run docs:build
```

Expected: at most CI check-run-state churn inside cassettes (drop it with `git checkout -- tests/fixtures/cassettes/`); NO other cassette diffs and NO `docs/generated/` diffs. Any other diff is a real failure — investigate before merging.

---

## Self-review — spec coverage checklist

Every spec requirement maps to a task:

- Nested `type`-tagged tree; order=position, grouping=nesting → Task 4 (types), Task 5 (`buildStackTree`).
- `sp view --json` with per-unit PR state → Task 6.
- Round-trip `view --json | ... | group --apply -` → Task 6 (out) + Task 9 (stdin) + Task 10 (in).
- Caller never mints/asserts ids; `id:null`=new group only; `reissueId` reissue; no `sha` input → Task 7 (schema), Task 8 (reconcile unknown-id), Task 10 (mint via `generateCommitId`).
- Omission ≠ null (PUT/PATCH), presence-tracking, `title` tri-state → Task 7 (`titleField` presence), Task 8 (title-retain).
- PR directives CLOSE/ADOPT, required-iff-transition, forbidden-in-steady-state, attach to identity incl. nested → Task 8 (`checkPr`, group branch), Task 11 (integration).
- Strict completeness (missing id) + unknown id + foreign-identity + empty group + duplicate id → Task 7 + Task 8 (tests enumerate each).
- Reorder conflict-gated via corrected engine; reissue+reorder mutually exclusive in v1 → Task 2 (engine), Task 10 (command), Task 8 (mutual-exclusion + test).
- PR mutation deferred to `sync` (group offline) → Task 10 (records intent to cache, never calls gh) + Task 11 (`gh` stub throws).
- No doc tests, no cassettes; seed PR cache directly → Task 6, Task 11 (seeded `savePRCache`, `gh` forbidden), Task 13 (verify no churn).
- Phase 1 reorder engine fix, standalone TDD, first → Tasks 1-3.
- Roadmap + changelog → Task 3, Task 12.

**Known follow-ups (out of scope, file as beads issues):**

- Dead `rebaseOntoTrunk` (`src/git/rebase.ts:155`).
- Interactive TUI does not yet expose reissue / PR-close/adopt (spec Non-goals: `--apply` is intentionally more feature-complete than the TUI at first).
- Combined reissue+reorder in one apply is deferred (v1 returns an error); revisit if needed.
