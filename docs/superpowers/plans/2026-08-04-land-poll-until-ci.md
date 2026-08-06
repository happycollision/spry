# `sp land --poll` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sp land --poll [--interval <sec>]` so land watches CI, then auto-lands when the scope goes green or fails fast on a hard blocker — surviving working-tree drift — and teach bare `sp land` to surface the `--poll` option when CI is the sole thing blocking.

**Architecture:** At invocation (the only read of `HEAD`) land freezes a plan — the tip SHA to push, trunk, and the in-scope branch names — then a wait loop re-polls PR state _by branch name_ via the existing `findPRsForBranches`, re-runs the existing readiness logic, and pushes the frozen tip SHA. A pure `classifyScope` helper turns `landBlockers` output into a three-way verdict (`ready` / `ci-pending` / `hard`) shared by the up-front decision, the bare-land nudge, and each poll iteration. All new I/O (sleep, clock, TTY check, PR polling) is behind injectable seams on `LandOptions` so the loop is unit-testable offline with no real timers or `gh`.

**Tech Stack:** TypeScript, Bun (`bun test`), commander (CLI), the existing `gh`-seam GraphQL PR lookup, kleur for dim output.

**Spec:** `docs/superpowers/specs/2026-07-28-land-poll-until-ci-design.md`

---

## File structure

- **Create** `src/commands/land-poll.ts` — the pure `classifyScope` classifier (`ScopeVerdict` type + the "is CI the sole blocker?" rule) and the `renderReinvokeHint` helper that builds the non-interactive copy/paste command. Pure, no I/O, so it is trivially unit-testable and shared by all three call sites.
- **Modify** `src/commands/land.ts` — add the new `LandOptions` seams; freeze the `LandPlan`; branch on the phase-2 verdict (bare nudge vs `--poll`); run the wait loop; keep phases 1 and 4 otherwise intact.
- **Modify** `src/cli/index.ts:57-60` — add `--poll` and `--interval <sec>` options and thread them into `landCommand`.
- **Test** `tests/commands/land-poll.test.ts` — unit tests for the pure classifier + hint helper.
- **Test** `tests/commands/land.test.ts` — integration tests for the wait loop and the bare-land nudge, using the existing repo/gh-stub harness with a mutable stub for poll transitions.
- **Test** `tests/commands/land.doc.test.ts` — doc-producing tests for the nudge output and a `--poll` banner+land sequence (offline; no new cassettes).

**Key existing symbols this plan reuses (do not redefine):**

- `landBlockers(scope, prByUnit): { blocked, perUnit }` where `perUnit: { unit, branch, reasons: string[] }[]` — `src/commands/stack-analysis.ts:117`.
- The exact reason strings (single source of truth): `"CI checks are still running"`, `"CI checks are failing"`, `"Changes have been requested"`, `"Review is required"`, `"no open PR"` — `src/commands/land-readiness.ts:31-34`, `src/commands/stack-analysis.ts:141`.
- `findPRsForBranches(ctx, branches, { cwd, owner, repo }): Promise<Map<string, PRInfo|null>>` — `src/gh/pr.ts:344`.
- `analyzeStack`, `UnitAnalysis`, `UnitBlockers` — `src/commands/stack-analysis.ts`.
- `branchForUnit(unit, config)` — `src/git/branch.ts`.
- `PRInfo` — `src/gh/pr.ts:10`.

---

## Task 1: `classifyScope` — the pure three-way verdict

**Files:**

- Create: `src/commands/land-poll.ts`
- Test: `tests/commands/land-poll.test.ts`

The classifier consumes `landBlockers`' output plus the fresh PR map (for the `ci-pending` PR numbers) and returns one of three verdicts. "CI is the sole blocker" ⇔ every blocked unit's `reasons` array is exactly `["CI checks are still running"]` and nothing else. Any other reason on any unit ⇒ `hard`. No blocked units ⇒ `ready`.

- [ ] **Step 1: Write the failing test**

Create `tests/commands/land-poll.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { classifyScope, renderReinvokeHint } from "../../src/commands/land-poll.ts";
import type { UnitBlockers } from "../../src/commands/stack-analysis.ts";

const CI_PENDING = "CI checks are still running";

function blocked(branch: string, reasons: string[]): UnitBlockers {
  // `unit` is unused by classifyScope; a minimal stand-in keeps the test focused.
  return { unit: { id: branch } as never, branch, reasons };
}

describe("classifyScope", () => {
  test("no blockers → ready", () => {
    const v = classifyScope({ blocked: false, perUnit: [] }, prNumbers({}));
    expect(v.kind).toBe("ready");
  });

  test("sole reason CI-pending on every blocked unit → ci-pending with PR numbers", () => {
    const v = classifyScope(
      { blocked: true, perUnit: [blocked("spry/a", [CI_PENDING]), blocked("spry/b", [CI_PENDING])] },
      prNumbers({ "spry/a": 1, "spry/b": 2 }),
    );
    expect(v.kind).toBe("ci-pending");
    if (v.kind === "ci-pending") expect(v.prNumbers).toEqual([1, 2]);
  });

  test("CI failing → hard", () => {
    const v = classifyScope(
      { blocked: true, perUnit: [blocked("spry/a", ["CI checks are failing"])] },
      prNumbers({ "spry/a": 1 }),
    );
    expect(v.kind).toBe("hard");
  });

  test("CI pending AND changes requested on one unit → hard (mixed is not pollable)", () => {
    const v = classifyScope(
      { blocked: true, perUnit: [blocked("spry/a", [CI_PENDING, "Changes have been requested"])] },
      prNumbers({ "spry/a": 1 }),
    );
    expect(v.kind).toBe("hard");
  });

  test("one unit CI-pending, another changes-requested → hard", () => {
    const v = classifyScope(
      {
        blocked: true,
        perUnit: [blocked("spry/a", [CI_PENDING]), blocked("spry/b", ["Changes have been requested"])],
      },
      prNumbers({ "spry/a": 1, "spry/b": 2 }),
    );
    expect(v.kind).toBe("hard");
  });
});

// Minimal PRInfo-shaped map: classifyScope only reads `.number` off each entry.
function prNumbers(m: Record<string, number>): Map<string, { number: number } | null> {
  return new Map(Object.entries(m).map(([b, n]) => [b, { number: n }]));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/commands/land-poll.test.ts`
Expected: FAIL — `classifyScope` / `renderReinvokeHint` are not exported (module not found).

- [ ] **Step 3: Write the minimal implementation**

Create `src/commands/land-poll.ts`:

```ts
import type { LandBlockersResult, UnitBlockers } from "./stack-analysis.ts";

/** The one reason string that polling can clear. Must match land-readiness.ts. */
export const CI_PENDING_REASON = "CI checks are still running";

export type ScopeVerdict =
  | { kind: "ready" }
  | { kind: "ci-pending"; prNumbers: number[] }
  | { kind: "hard"; perUnit: UnitBlockers[] };

/** True iff this unit's ONLY blocking reason is that CI is still running. */
function ciPendingIsSoleReason(u: UnitBlockers): boolean {
  return u.reasons.length === 1 && u.reasons[0] === CI_PENDING_REASON;
}

/**
 * Fold `landBlockers` output into a three-way verdict. `ci-pending` is returned
 * ONLY when every blocked unit's sole reason is CI-still-running — a mixed state
 * (CI pending alongside any other reason, or a different reason on a sibling
 * unit) is `hard`, because polling cannot clear it. `prByBranch` supplies the PR
 * numbers surfaced for the ci-pending banner/nudge.
 */
export function classifyScope(
  blockers: LandBlockersResult,
  prByBranch: Map<string, { number: number } | null>,
): ScopeVerdict {
  if (!blockers.blocked) return { kind: "ready" };
  if (blockers.perUnit.every(ciPendingIsSoleReason)) {
    const prNumbers = blockers.perUnit
      .map((u) => prByBranch.get(u.branch)?.number)
      .filter((n): n is number => typeof n === "number");
    return { kind: "ci-pending", prNumbers };
  }
  return { kind: "hard", perUnit: blockers.perUnit };
}

/**
 * The copy/paste command a non-interactive bare-land prints so the user can
 * re-invoke with polling. `throughId` is the resolved scope's top unit id
 * (or the explicit --through the user passed), so the printed command
 * reproduces exactly this land.
 */
export function renderReinvokeHint(throughId: string): string {
  return `Run \`sp land --through ${throughId} --poll\` to wait for CI and land automatically.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/commands/land-poll.test.ts`
Expected: PASS (5 classifyScope cases).

- [ ] **Step 5: Add the `renderReinvokeHint` test**

Append to `tests/commands/land-poll.test.ts`:

```ts
describe("renderReinvokeHint", () => {
  test("embeds the through id and --poll", () => {
    expect(renderReinvokeHint("bbb22222")).toBe(
      "Run `sp land --through bbb22222 --poll` to wait for CI and land automatically.",
    );
  });
});
```

- [ ] **Step 6: Run + commit**

Run: `bun test tests/commands/land-poll.test.ts`
Expected: PASS (6 tests).

```bash
git add src/commands/land-poll.ts tests/commands/land-poll.test.ts
git commit -m "feat(land): pure classifyScope verdict for --poll readiness"
```

---

## Task 2: `LandOptions` seams + freeze the plan

Add the new injectable seams and the `LandPlan`, and refactor phase 1 so scope resolution, the up-front blocker analysis, and the unresolved-threads confirm all produce a frozen plan + a `prByBranch` map, WITHOUT changing any current behavior yet. This task is a pure refactor: bare `sp land` with no new flags must behave identically (all existing land tests stay green).

**Files:**

- Modify: `src/commands/land.ts:17-136`

- [ ] **Step 1: Extend `LandOptions` and add `LandPlan`**

In `src/commands/land.ts`, replace the `LandOptions` interface (lines 17-23) with:

```ts
import type { PRInfo } from "../gh/pr.ts";
import { findPRsForBranches } from "../gh/pr.ts";

export interface LandOptions {
  through?: string;
  poll?: boolean;
  /** Poll cadence in seconds; default 30. Only meaningful with --poll / an accepted nudge. */
  interval?: number;
  cwd?: string;
  /** Injected for testability; default to a real TUI. */
  confirm?: (message: string) => Promise<boolean>;
  pickThrough?: (units: PRUnit[]) => Promise<string | null>;
  /** True when stdin is a terminal (nudge is interactive). Default: real TTY check. */
  isInteractive?: () => boolean;
  /** Sleep `seconds` between polls. Default: real setTimeout. */
  sleep?: (seconds: number) => Promise<void>;
  /** Poll PR state by branch name. Default: findPRsForBranches against gh. */
  pollPRs?: (branches: string[]) => Promise<Map<string, PRInfo | null>>;
}

/** Everything the wait loop + push need — all working-tree-independent. */
interface LandPlan {
  tip: string;
  trunk: string;
  scopeUnits: PRUnit[];
  scopeBranches: string[];
  throughId: string;
}

const DEFAULT_INTERVAL_SECONDS = 30;
```

- [ ] **Step 2: Freeze the plan in `landCommand`**

In `landCommand`, after the block that computes `target`/`tip` (currently `src/commands/land.ts:55-61`), and after the existing `analyzeStack`/`landBlockers` block (lines 64-82), build the plan and a fresh `prByBranch` map from the already-fetched cache. Insert immediately BEFORE the existing unresolved-threads block (line 84):

```ts
  const plan: LandPlan = {
    tip,
    trunk: config.trunk,
    scopeUnits,
    scopeBranches: scopeUnits.map((u) => branchForUnit(u, config)),
    throughId: throughId,
  };
```

(`throughId` is already resolved above — it is the explicit `--through` or the picker result. Keep the existing `analyzeStack`/`landBlockers` hard-blocker gate exactly as-is for now; Task 3 replaces its verdict handling.)

- [ ] **Step 3: Run the full land suite to verify no behavior changed**

Run: `bun test tests/commands/land.test.ts`
Expected: PASS — identical to before (pure refactor; the plan is built but not yet consumed).

- [ ] **Step 4: Commit**

```bash
git add src/commands/land.ts
git commit -m "refactor(land): add poll seams and freeze a working-tree-independent LandPlan"
```

---

## Task 3: Replace the hard-blocker gate with the three-way verdict + bare-land nudge

Swap the existing `landBlockers`→`process.exit` gate for `classifyScope`. `ready` falls through to land; `hard` prints per-unit blockers and exits (same as today); `ci-pending` triggers the nudge (interactive prompt or non-interactive hint). This task wires the bare-land nudge; the actual wait loop is Task 4 (here, an accepted nudge / `--poll` just calls a `runPollLoop` stub that we flesh out next).

**Files:**

- Modify: `src/commands/land.ts` (the phase-2 region, currently lines 64-97)

- [ ] **Step 1: Write the failing integration test — non-interactive nudge**

Add to `tests/commands/land.test.ts` a new describe block (place after the unresolved-threads describe). It reuses `makeConfiguredRepo`, `publishedStack`, `ghPrStub`, `makeCtx`, `runLand`, `captureLogs`, `trapExit` from the file:

```ts
describe("sp land --poll nudge (bare land, CI pending)", () => {
  // A PR whose checks are still running (a single IN_PROGRESS check run).
  const ciPending: PRStub = {
    number: 1,
    rollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }],
  };

  test("non-interactive shell → prints the --poll re-invoke command, does not land", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    const { gh } = stubGh(ghPrStub({ "spry/test/aaa11111": ciPending }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, {
        cwd: repo.path,
        through: "aaa11111",
        isInteractive: () => false,
      });
    } finally {
      trap.restore();
      logs.restore();
    }

    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(before); // nothing landed
    expect(logs.out.join("\n")).toContain("sp land --through aaa11111 --poll");
    expect(trap.exitCode).toBe(1);
  });

  test("interactive shell, user declines → does not land", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    const { gh } = stubGh(ghPrStub({ "spry/test/aaa11111": ciPending }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, {
        cwd: repo.path,
        through: "aaa11111",
        isInteractive: () => true,
        confirm: async () => false, // "no" to the poll prompt
      });
    } finally {
      trap.restore();
      logs.restore();
    }

    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(before);
    expect(trap.exitCode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/commands/land.test.ts -t "poll nudge"`
Expected: FAIL — today a CI-pending PR hits the old `landBlockers` gate and prints "Cannot land … CI checks are still running" + exits 1, so neither the re-invoke string nor the decline-without-exit behavior is present.

- [ ] **Step 3: Implement the verdict branch**

In `src/commands/land.ts`, add imports at the top:

```ts
import { classifyScope, renderReinvokeHint } from "./land-poll.ts";
```

Replace the existing hard-blocker gate + unresolved-threads block (currently lines 73-97) with the verdict-driven flow. Build `prByBranch` from the fresh `checked.prMap` when present, else from the cache, keyed by branch:

```ts
  // Fresh PR state keyed by branch, for classifyScope + the loop's first read.
  const prByBranch = new Map<string, PRInfo | null>();
  for (const a of scopeAnalysis) {
    prByBranch.set(a.branch, checked.prMap?.get(a.branch) ?? null);
  }

  const verdict = classifyScope(blockers, prByBranch);

  if (verdict.kind === "hard") {
    console.error("✗ Cannot land: the following units are not ready:");
    for (const b of verdict.perUnit) {
      console.error(`  ${b.branch}:`);
      for (const r of b.reasons) console.error(`    - ${r}`);
    }
    console.error("  Run `sp sync` and try again.");
    process.exit(1);
  }

  // Decide whether we are entering the wait loop.
  let willPoll = opts.poll === true;

  if (verdict.kind === "ci-pending" && !willPoll) {
    // Bare land with CI as the sole blocker: surface --poll.
    const isInteractive = opts.isInteractive ?? (() => process.stdin.isTTY === true);
    if (isInteractive()) {
      const confirmFn = opts.confirm ?? defaultConfirm;
      const yes = await confirmFn("Would you like to poll until CI passes, then auto-land?");
      if (!yes) {
        console.log("Not landed; CI still running.");
        return;
      }
      willPoll = true;
    } else {
      console.error(renderReinvokeHint(plan.throughId));
      process.exit(1);
    }
  }

  // Unresolved review threads are advisory: prompt once, up front, while the
  // user is present (never inside the wait loop).
  const scopePRs = scopeUnits
    .map((u) => checked.prCache[u.id])
    .filter((pr): pr is NonNullable<typeof pr> => !!pr);
  const unresolved = scopePRs.filter((pr) => pr.reviewThreads.total > pr.reviewThreads.resolved);
  if (unresolved.length > 0) {
    const confirmFn = opts.confirm ?? defaultConfirm;
    const prs = unresolved.map((pr) => `#${pr.number}`).join(", ");
    const ok = await confirmFn(`PR(s) ${prs} have unresolved review threads. Land anyway?`);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  if (willPoll) {
    const ok = await runPollLoop(ctx, config, plan, opts);
    if (!ok) return; // loop already reported the failure + set exit code
  }
```

Then add a temporary stub near the bottom of the file (Task 4 replaces its body):

```ts
async function runPollLoop(
  _ctx: SpryContext,
  _config: SpryConfig,
  _plan: LandPlan,
  _opts: LandOptions,
): Promise<boolean> {
  return true; // placeholder — Task 4 implements the real loop
}
```

Note: the `ready` verdict simply falls through (no block runs), reaching the existing push at what is currently line 99. Confirm the push block and cleanup tail below are unchanged.

- [ ] **Step 4: Run the nudge tests**

Run: `bun test tests/commands/land.test.ts -t "poll nudge"`
Expected: PASS (both cases).

- [ ] **Step 5: Run the whole land suite (no regressions)**

Run: `bun test tests/commands/land.test.ts`
Expected: PASS — existing `--through`, unresolved-threads, and picker tests still green (`ready`/`hard` paths preserved).

- [ ] **Step 6: Commit**

```bash
git add src/commands/land.ts
git commit -m "feat(land): surface --poll when CI is the sole blocker (bare-land nudge)"
```

---

## Task 4: The wait loop

Replace the `runPollLoop` stub with the real loop: print the banner once, then poll `plan.scopeBranches` on the injected cadence, re-classify each round, land on `ready`, fail fast on `hard`, keep polling on `ci-pending`. Structural blockers are frozen (not re-derived); only PR-derived readiness is re-evaluated via `landBlockers` over the freshly-polled PRs. Landing is the same push+cleanup the `ready` fall-through uses, so extract that into a shared `performLand` first to avoid duplicating it.

**Files:**

- Modify: `src/commands/land.ts`

- [ ] **Step 1: Extract `performLand` from the existing push+cleanup tail**

Cut the current push block + cleanup tail (currently `src/commands/land.ts:99-135`) into a helper, and call it from the `ready` fall-through:

```ts
/** The push + cleanup tail. Consumes ONLY the frozen plan (no HEAD read). */
async function performLand(
  ctx: SpryContext,
  config: SpryConfig,
  plan: LandPlan,
  groupRecords: GroupRecords,
  totalUnits: number,
  cwd: string | undefined,
): Promise<void> {
  const result = await pushBranch(ctx.git, {
    cwd,
    remote: config.remote,
    sha: plan.tip,
    branch: plan.trunk,
    forceWithLease: false,
  });
  if (!result.ok) {
    if (result.reason === "stale-ref") {
      console.error(`✗ ${plan.trunk} is ahead of your stack. Run \`sp rebase\` and try again.`);
    } else {
      console.error(`✗ Could not land: ${result.stderr.trim()}`);
    }
    process.exit(1);
  }

  const n = plan.scopeUnits.length;
  console.log(`✓ Landed ${n} PR${n === 1 ? "" : "s"} to ${plan.trunk}`);

  const landedIds = new Set(plan.scopeUnits.map((u) => u.id));
  await dropLandedFromPRCache(ctx, config, landedIds, cwd);
  await scrubLandedGroupRecords(ctx, config, groupRecords, landedIds, cwd);
  if (config.autoDeleteOnLand) {
    await deleteSpentBranches(ctx, config, plan.scopeUnits, cwd);
  }

  if (totalUnits > plan.scopeUnits.length) {
    console.log(kleur.dim("  Run `sp sync` to retarget the remaining PRs."));
  }
  if (!config.autoDeleteOnLand) {
    console.log(kleur.dim("  Run `sp clean` to delete the landed branches from the remote."));
  }
}
```

At the `ready` fall-through site (end of `landCommand`), replace the old inline push/cleanup with:

```ts
  await performLand(ctx, config, plan, groupRecords, units.length, cwd);
```

(For the `willPoll` path, `runPollLoop` calls `performLand` itself on success — see Step 3 — so after `runPollLoop` returns `true`, `landCommand` should `return` rather than fall through to a second `performLand`. Structure it as: if `willPoll`, `await runPollLoop(...)` then `return`; else `await performLand(...)`.)

Concretely, the tail of `landCommand` becomes:

```ts
  if (willPoll) {
    await runPollLoop(ctx, config, plan, groupRecords, units.length, opts);
    return;
  }
  await performLand(ctx, config, plan, groupRecords, units.length, cwd);
```

- [ ] **Step 2: Write the failing loop tests**

Add to `tests/commands/land.test.ts` a describe block. The key trick: `ghPrStub` closes over a mutable `prByBranch` record, so flipping its `rollup` between polls simulates CI finishing. A synchronous `sleep` stub (counts calls, never waits) keeps the test instant.

```ts
describe("sp land --poll loop", () => {
  test("pending → passing → lands", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const tip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();

    // Mutable stub state: starts pending, flips to passing after the first sleep.
    const state: Record<string, PRStub> = {
      "spry/test/aaa11111": {
        number: 1,
        rollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }],
      },
    };
    const { gh } = stubGh(ghPrStub(state));
    const ctx = makeCtx(repo, gh);

    let sleeps = 0;
    const sleep = async () => {
      sleeps++;
      // After the first poll's sleep, CI finishes.
      state["spry/test/aaa11111"] = {
        number: 1,
        rollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      };
    };

    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "aaa11111", poll: true, sleep });
    } finally {
      trap.restore();
      logs.restore();
    }

    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(tip); // landed the frozen tip
    expect(sleeps).toBe(1); // slept once, then next poll was green
    expect(logs.out.join("\n")).toContain("Landed");
  });

  test("pending → failing → fails fast, does not land", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    const state: Record<string, PRStub> = {
      "spry/test/aaa11111": {
        number: 1,
        rollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }],
      },
    };
    const { gh } = stubGh(ghPrStub(state));
    const ctx = makeCtx(repo, gh);

    const sleep = async () => {
      state["spry/test/aaa11111"] = {
        number: 1,
        rollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
      };
    };

    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "aaa11111", poll: true, sleep });
    } finally {
      trap.restore();
      logs.restore();
    }

    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(before); // nothing landed
    expect(trap.exitCode).toBe(1);
    expect(logs.err.join("\n")).toContain("CI checks are failing");
  });

  test("stays pending across several polls (counts sleeps)", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const tip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();

    const state: Record<string, PRStub> = {
      "spry/test/aaa11111": {
        number: 1,
        rollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }],
      },
    };
    const { gh } = stubGh(ghPrStub(state));
    const ctx = makeCtx(repo, gh);

    let sleeps = 0;
    const sleep = async () => {
      sleeps++;
      if (sleeps === 3) {
        state["spry/test/aaa11111"] = {
          number: 1,
          rollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        };
      }
    };

    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "aaa11111", poll: true, sleep });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(sleeps).toBe(3);
    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(tip);
  });
});
```

- [ ] **Step 3: Implement `runPollLoop`**

Replace the stub. It re-polls, rebuilds `landBlockers` over fresh PRs (reusing the frozen `scopeAnalysis` for structural flags is unnecessary here because a landable-but-for-CI scope already passed the structural gate in phase 2 — so the loop only needs PR-derived readiness via `evaluateReadiness`, surfaced through the same `landBlockers` shape). To keep one code path, rebuild a minimal `UnitAnalysis[]` whose structural flags are all false (frozen-clean) and let `landBlockers` fold in the fresh PR readiness:

```ts
import { evaluateReadiness } from "./land-readiness.ts";
```

```ts
async function runPollLoop(
  ctx: SpryContext,
  config: SpryConfig,
  plan: LandPlan,
  groupRecords: GroupRecords,
  totalUnits: number,
  opts: LandOptions,
): Promise<void> {
  const intervalSeconds = opts.interval ?? DEFAULT_INTERVAL_SECONDS;
  const sleep = opts.sleep ?? ((s: number) => new Promise<void>((r) => setTimeout(r, s * 1000)));
  const pollPRs =
    opts.pollPRs ??
    ((branches: string[]) =>
      findPRsForBranches(ctx, branches, { cwd: opts.cwd, owner: config.owner, repo: config.repo }));

  // Structural flags are frozen-clean: this scope already cleared the phase-2
  // structural gate, and nothing the loop does (or the user does to the working
  // tree) can change them. Only PR-derived readiness is re-evaluated per poll.
  const frozenAnalysis: UnitAnalysis[] = plan.scopeUnits.map((unit) => ({
    unit,
    branch: branchForUnit(unit, config),
    missingId: false,
    unpushed: false,
    misTargeted: false,
    currentBase: undefined,
    expectedBase: config.trunk,
  }));

  // Banner (once). Derive PR numbers from the first classify below.
  let bannerPrinted = false;

  for (;;) {
    const prMap = await pollPRs(plan.scopeBranches);
    const prByUnit: Record<string, PRInfo | null> = {};
    for (const a of frozenAnalysis) prByUnit[a.unit.id] = prMap.get(a.branch) ?? null;

    const blockers = landBlockers(frozenAnalysis, prByUnit);
    const verdict = classifyScope(blockers, prMap);

    if (verdict.kind === "ready") {
      await performLand(ctx, config, plan, groupRecords, totalUnits, opts.cwd);
      return;
    }
    if (verdict.kind === "hard") {
      console.error("✗ Cannot land: a check turned blocking while waiting:");
      for (const b of blockers.perUnit) {
        console.error(`  ${b.branch}:`);
        for (const r of b.reasons) console.error(`    - ${r}`);
      }
      process.exit(1);
    }

    // ci-pending: banner once, then dim progress + sleep.
    if (!bannerPrinted) {
      const prs = verdict.prNumbers.map((n) => `#${n}`).join(", ");
      console.log(
        kleur.dim(`⧗ CI pending on ${prs}; polling every ${intervalSeconds}s (Ctrl-C to stop)…`),
      );
      bannerPrinted = true;
    } else {
      console.log(kleur.dim(`  …still pending`));
    }
    await sleep(intervalSeconds);
  }
}
```

Update the `landCommand` call site to pass `groupRecords` and `units.length`:

```ts
  if (willPoll) {
    await runPollLoop(ctx, config, plan, groupRecords, units.length, opts);
    return;
  }
```

(Add `UnitAnalysis` to the `stack-analysis.ts` import in `land.ts` if not already imported.)

- [ ] **Step 4: Run the loop tests**

Run: `bun test tests/commands/land.test.ts -t "poll loop"`
Expected: PASS (3 cases).

- [ ] **Step 5: Run the full land + land-poll suites**

Run: `bun test tests/commands/land.test.ts tests/commands/land-poll.test.ts`
Expected: PASS — all cases green, no regression in the pre-existing land tests.

- [ ] **Step 6: Commit**

```bash
git add src/commands/land.ts
git commit -m "feat(land): --poll wait loop — land on green, fail fast on hard blocker"
```

---

## Task 5: CLI wiring

Expose `--poll` and `--interval <sec>` and thread them into `landCommand`.

**Files:**

- Modify: `src/cli/index.ts:57-60`

- [ ] **Step 1: Update the land command registration**

Replace lines 57-60 with:

```ts
program
  .command("land")
  .description("Land the stack into trunk by fast-forwarding through a chosen commit")
  .option("--through <id>", "Land from the bottom through this group/commit id")
  .option("--poll", "Watch CI and auto-land when the scope goes green (fail fast on a hard blocker)")
  .option("--interval <sec>", "Poll cadence in seconds when --poll is set (default 30)")
  .action((opts: { through?: string; poll?: boolean; interval?: string }) =>
    landCommand(ctx, {
      through: opts.through,
      poll: opts.poll,
      interval: opts.interval === undefined ? undefined : Number(opts.interval),
    }),
  );
```

- [ ] **Step 2: Manually verify the CLI parses the flags**

Run: `bun src/cli/index.ts land --help`
Expected: help text lists `--poll` and `--interval <sec>` alongside `--through`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): wire sp land --poll / --interval"
```

---

## Task 6: Doc tests + generated docs

Add offline doc-producing tests so the nudge output and a `--poll` banner+land sequence land in `docs/generated/`. These use the existing offline gh-stub harness in `land.doc.test.ts` (no new cassettes — the GraphQL path is unchanged).

**Files:**

- Modify: `tests/commands/land.doc.test.ts`
- Regenerate: `docs/generated/commands/land.*`

- [ ] **Step 1: Read the existing offline doc-test pattern**

Run: `grep -n "docTest\|isRecording\|ghStub\|--through" tests/commands/land.doc.test.ts | head -40`
Expected: identify an existing OFFLINE (non-record-gated) `docTest` in this file to mirror. If every existing land docTest is record-gated (real `gh`), instead mirror the offline gh-stub pattern from `tests/commands/sync.doc.test.ts` (`grep -n "docTest\|stubGh\|gh:" tests/commands/sync.doc.test.ts | head`). Use whichever offline pattern the repo already has; do not introduce a new harness.

- [ ] **Step 2: Add the non-interactive nudge doc test**

Add a `docTest` that runs bare `sp land --through <id>` against a stub where the single unit's PR is CI-pending and `isInteractive` is false (drive via the CLI harness's non-TTY default, or the injected seam if the harness calls `landCommand` directly). Capture output; assert it contains `sp land --through` … `--poll`. Follow the exact `docTest(...)` signature used by the sibling offline test identified in Step 1 — matching its repo setup, gh-stub wiring, and capture assertions — rather than inventing arguments.

- [ ] **Step 3: Add the `--poll` banner+land doc test**

Add a `docTest` that runs `sp land --through <id> --poll` with a mutable stub (pending on the first poll, passing on the second) and a synchronous injected `sleep`, mirroring the loop integration test. Capture output; assert it contains the `CI pending on #…; polling every 30s` banner and `Landed`.

- [ ] **Step 4: Run the doc tests + rebuild docs**

Run: `bun test tests/commands/land.doc.test.ts`
Then: `bun run docs:build`
Expected: both PASS; `docs/generated/commands/land.md` (and fragments) now show the `--poll`/`--interval` options and the two new captured sequences.

- [ ] **Step 5: Verify docs are deterministic (no drift)**

Run: `bun run docs:verify`
Expected: PASS — the regenerated docs match what Step 4 wrote. If it fails, run `bun run docs:clean && bun test && bun run docs:build` and re-verify.

- [ ] **Step 6: Commit**

```bash
git add tests/commands/land.doc.test.ts docs/generated/
git commit -m "docs(land): doc tests for --poll nudge and wait-loop sequence"
```

---

## Task 7: Changelog + full-suite gate

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the changelog entry**

Under the top "Unreleased" (or equivalent current) section of `CHANGELOG.md`, add:

```markdown
- `sp land --poll` waits for CI and auto-lands when the in-scope PRs go green, failing fast on a hard blocker (CI failure, closed PR, changes requested). The wait survives working-tree drift — you can switch branches or commit while it polls. `--interval <sec>` sets the cadence (default 30). Bare `sp land` now offers `--poll` when CI is the only thing blocking: an interactive prompt to poll now, or a copy/paste command in non-interactive shells.
```

(Match the surrounding bullet style; if the changelog groups by Added/Changed, put it under Added.)

- [ ] **Step 2: Run the full offline suite**

Run: `bun run test:concurrent`
Expected: PASS across the repo (land, land-poll, and everything else). If Git < 2.40, use the `:docker` alias per AGENTS.md.

- [ ] **Step 3: Verify docs once more**

Run: `bun run docs:verify`
Expected: PASS (no drift after a full run).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): sp land --poll"
```

---

## Task 8: Pre-merge record + playback gate

Per AGENTS.md, before merging prove record mode still works end-to-end and docs are stable. This feature adds no new cassettes (the `gh` GraphQL path is unchanged), so the expected churn is only CI check-run state inside existing cassettes, which is dropped.

- [ ] **Step 1: Confirm gh auth**

Run: `gh auth status`
Expected: logged in. (If not, stop and tell the user — recording needs auth.)

- [ ] **Step 2: Record the suite once**

Run:

```bash
bun run docs:clean
bun run record
bun run docs:build
```

Expected: PASS. Mutates `spry-check`; the suite-start reset handles residue.

- [ ] **Step 3: Play back twice**

Run:

```bash
bun test
bun run docs:build
bun test
bun run docs:build
```

Expected: PASS both times.

- [ ] **Step 4: Inspect churn and drop cassette CI-state noise**

Run: `git status --short tests/fixtures/cassettes/ docs/generated/`
Expected: the ONLY cassette diffs are `statusCheckRollup` CI-state noise, and `docs/generated/` is clean. Drop the cassette noise:

```bash
git checkout -- tests/fixtures/cassettes/
```

Any OTHER cassette diff, or any `docs/generated/` diff, is a real failure — investigate before merging; do not commit the churn.

- [ ] **Step 5: Final commit (only if anything legitimate changed)**

If Steps 2-4 left legitimate changes (they normally leave none after dropping CI noise), commit them; otherwise this task ends with a clean tree. Do not commit dropped cassette noise.

---

## Self-review notes (already reconciled)

- **Spec coverage:** frozen plan (Task 2), `classifyScope` three-way rule incl. mixed→hard (Task 1), bare-land interactive/non-interactive nudge (Task 3), continue-in-process on yes (Task 3 sets `willPoll`, Task 4 loop), wait loop land/fail-fast/keep-polling with banner (Task 4), prompts resolved up front (Task 3 keeps the unresolved-threads confirm before the loop), `--interval` default 30 (Tasks 2/4/5), seams for offline testing (Tasks 2/4), CLI (Task 5), docs (Task 6), changelog + record gate (Tasks 7/8).
- **Type consistency:** `LandPlan`, `ScopeVerdict`, `classifyScope`, `renderReinvokeHint`, `runPollLoop(ctx, config, plan, groupRecords, totalUnits, opts)`, `performLand(ctx, config, plan, groupRecords, totalUnits, cwd)` are used with identical signatures across tasks. `CI_PENDING_REASON` string is asserted equal to `land-readiness.ts:32`'s literal.
- **No placeholders:** every code step shows complete code; the only intentional stub (`runPollLoop` in Task 3) is explicitly replaced in Task 4.
- **One spec point deliberately simplified:** the spec's `pollPRs`/`now`/`prNumbersAtPlanTime` seams — `now` (progress timestamps) is dropped as YAGNI (the dim "still pending" line needs no clock; keeps the loop clock-free and tests simpler), and `prNumbersAtPlanTime` is unused because the loop derives PR numbers from each fresh poll. `pollPRs`, `sleep`, `isInteractive` are kept — they are the seams the tests actually drive.

```

```
