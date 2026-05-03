# sp view (enriched) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `sp view` with default-on PR enrichment (state, checks, review, resolved-comment count) on a two-line per-unit layout, with graceful fallback when gh is unavailable.

**Architecture:** Add `spry.branchPrefix` config and a `branchForUnit(unit, config)` helper. Extend the existing `gh` module with review-thread counts and add an `enrichUnits` orchestrator that classifies infra failures into a tagged union. Rewrite `formatStackView` for the two-line layout. View command orchestrates: parse stack → enrich → format.

**Tech Stack:** Bun, TypeScript, Commander, kleur, `gh` GraphQL, Bun's test runner. Existing test infrastructure (`createRepo`, `docTest`, recording client) is reused — no new infra.

**Design reference:** [docs/plans/2026-05-02-sp-view-enriched-design.md](2026-05-02-sp-view-enriched-design.md)

**Important notes:**

- This machine has an old git version. Run all tests via `bun run test:docker`, never `bun test` directly.
- Existing cassettes at `fixtures/tests/gh/` will be invalidated by the GraphQL query change in Task 4. They are re-recorded in Task 5.
- The convention `<prefix>/<unit-id>` makes legacy parity available to users by setting `spry.branchPrefix = "spry/<their-username>"`.
- Commit each task at its end — frequent commits make rollback cheap.

---

## Task 1: Extend `SpryConfig` with `branchPrefix`

**Files:**

- Modify: `src/git/config.ts:3-6` (interface) and `src/git/config.ts:56-84` (readConfig)
- Modify: `tests/git/config.test.ts` (extend)

**Step 1: Add failing tests for `branchPrefix`**

Add these tests to [tests/git/config.test.ts](tests/git/config.test.ts) inside the existing `describe("readConfig")` block:

```ts
test("reads branchPrefix when set", async () => {
  repo = await createRepo();
  const { $ } = await import("bun");
  await $`git config spry.trunk main`.cwd(repo.path).quiet();
  await $`git config spry.remote origin`.cwd(repo.path).quiet();
  await $`git config spry.branchPrefix spry/dondenton`.cwd(repo.path).quiet();

  const config = await readConfig(git, { cwd: repo.path });
  expect(config.branchPrefix).toBe("spry/dondenton");
});

test('throws mentioning "spry.branchPrefix" when not set', async () => {
  repo = await createRepo();
  const { $ } = await import("bun");
  await $`git config spry.trunk main`.cwd(repo.path).quiet();
  await $`git config spry.remote origin`.cwd(repo.path).quiet();

  await expect(readConfig(git, { cwd: repo.path })).rejects.toThrow("spry.branchPrefix");
});

test("error suggests prefix format with username", async () => {
  repo = await createRepo();
  const { $ } = await import("bun");
  await $`git config spry.trunk main`.cwd(repo.path).quiet();
  await $`git config spry.remote origin`.cwd(repo.path).quiet();

  try {
    await readConfig(git, { cwd: repo.path });
    expect(true).toBe(false);
  } catch (e: any) {
    expect(e.message).toContain("spry.branchPrefix");
    expect(e.message).toContain("git config spry.branchPrefix");
  }
});
```

Update the existing `reads trunk and remote when both set` test to also assert `branchPrefix` after setting it:

```ts
test("reads trunk and remote and branchPrefix when set", async () => {
  repo = await createRepo();
  const { $ } = await import("bun");
  await $`git config spry.trunk main`.cwd(repo.path).quiet();
  await $`git config spry.remote origin`.cwd(repo.path).quiet();
  await $`git config spry.branchPrefix spry/test`.cwd(repo.path).quiet();

  const config = await readConfig(git, { cwd: repo.path });
  expect(config.trunk).toBe("main");
  expect(config.remote).toBe("origin");
  expect(config.branchPrefix).toBe("spry/test");
});
```

Update the `loadConfig` test that checks "returns config when both set" to also set `branchPrefix`:

```ts
test("returns config when all three set", async () => {
  repo = await createRepo();
  const { $ } = await import("bun");
  await $`git config spry.trunk main`.cwd(repo.path).quiet();
  await $`git config spry.remote origin`.cwd(repo.path).quiet();
  await $`git config spry.branchPrefix spry/test`.cwd(repo.path).quiet();

  const config = await loadConfig(git, { cwd: repo.path });
  expect(config.trunk).toBe("main");
  expect(config.remote).toBe("origin");
  expect(config.branchPrefix).toBe("spry/test");
});
```

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker tests/git/config.test.ts
```

Expected: failures referencing missing `branchPrefix` field on `SpryConfig` type or "spry.branchPrefix" not thrown.

**Step 3: Implement `branchPrefix` in `readConfig`**

Edit [src/git/config.ts](src/git/config.ts):

```ts
export interface SpryConfig {
  trunk: string;
  remote: string;
  branchPrefix: string;
}
```

Inside `readConfig`, after the existing `trunk` block (around line 81), add:

```ts
  // Read branchPrefix
  const prefixResult = await git.run(["config", "--get", "spry.branchPrefix"], { cwd });
  if (prefixResult.exitCode !== 0 || !prefixResult.stdout.trim()) {
    throw new Error(
      `spry.branchPrefix is not configured.\n` +
        `Set it with: git config spry.branchPrefix spry/<your-username>\n` +
        `(Used to derive branch names for synced PRs: <prefix>/<unit-id>)`,
    );
  }
  const branchPrefix = prefixResult.stdout.trim();
```

Update the return:

```ts
  return { trunk, remote, branchPrefix };
```

**Step 4: Update other tests/code that initialize a config to set `branchPrefix`**

Two existing test files initialize `spry.trunk` + `spry.remote` and will start failing after this change:

In [tests/commands/view.test.ts](tests/commands/view.test.ts), every test that runs `git config spry.trunk` / `spry.remote` (lines 58-59, 72-73, 96-97, 118-119) — add a third config call:

```ts
await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
```

In [tests/commands/view.doc.test.ts](tests/commands/view.doc.test.ts), do the same for both `docTest` blocks (after lines 24 and 58):

```ts
await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
```

Anywhere else in the codebase that constructs a `SpryConfig` object literally also needs `branchPrefix`. Search:

```bash
grep -rn "trunk:.*remote:" src tests
```

**Step 5: Run all relevant test files to verify**

```bash
bun run test:docker tests/git/config.test.ts tests/commands/
```

Expected: all green.

**Step 6: Run full test suite as a regression sweep**

```bash
bun run test:docker
```

Expected: all green. Doc fragment regeneration is OK; you'll commit the fragment changes in Task 9.

**Step 7: Commit**

```bash
git add src/git/config.ts tests/git/config.test.ts tests/commands/
git commit -m "feat(git): add required spry.branchPrefix to SpryConfig"
```

---

## Task 2: Add `branchForUnit` helper

**Files:**

- Create: `src/git/branch.ts`
- Create: `tests/git/branch.test.ts`
- Modify: `src/git/index.ts` (re-export)

**Step 1: Write the failing test**

Create [tests/git/branch.test.ts](tests/git/branch.test.ts):

```ts
import { describe, test, expect } from "bun:test";
import { branchForUnit } from "../../src/git/branch.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import type { SpryConfig } from "../../src/git/config.ts";

const config: SpryConfig = {
  trunk: "main",
  remote: "origin",
  branchPrefix: "spry/test",
};

function singleUnit(id: string): PRUnit {
  return {
    type: "single",
    id,
    title: "T",
    commitIds: [id],
    commits: [id.repeat(5)],
    subjects: ["T"],
  };
}

function groupUnit(id: string): PRUnit {
  return {
    type: "group",
    id,
    title: "G",
    commitIds: [id],
    commits: [id.repeat(5)],
    subjects: ["T"],
  };
}

describe("branchForUnit", () => {
  test("returns <prefix>/<unit-id> for single units", () => {
    expect(branchForUnit(singleUnit("a1b2c3d4"), config)).toBe("spry/test/a1b2c3d4");
  });

  test("returns <prefix>/<unit-id> for group units", () => {
    expect(branchForUnit(groupUnit("grp00001"), config)).toBe("spry/test/grp00001");
  });

  test("works with prefixes containing slashes", () => {
    const prefixed: SpryConfig = { ...config, branchPrefix: "spry/dondenton" };
    expect(branchForUnit(singleUnit("a1"), prefixed)).toBe("spry/dondenton/a1");
  });

  test("throws on prefix that produces invalid branch names", () => {
    const bad: SpryConfig = { ...config, branchPrefix: "with spaces" };
    expect(() => branchForUnit(singleUnit("a1"), bad)).toThrow(/Invalid derived branch name/);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test:docker tests/git/branch.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement `branchForUnit`**

Create [src/git/branch.ts](src/git/branch.ts):

```ts
import type { SpryConfig } from "./config.ts";
import type { PRUnit } from "../parse/types.ts";
import { validateBranchName } from "../parse/validation.ts";

export function branchForUnit(unit: PRUnit, config: SpryConfig): string {
  const name = `${config.branchPrefix}/${unit.id}`;
  const validation = validateBranchName(name);
  if (!validation.ok) {
    throw new Error(`Invalid derived branch name '${name}': ${validation.error}`);
  }
  return name;
}
```

Add to [src/git/index.ts](src/git/index.ts):

```ts
export { branchForUnit } from "./branch.ts";
```

**Step 4: Run test to verify it passes**

```bash
bun run test:docker tests/git/branch.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/git/branch.ts src/git/index.ts tests/git/branch.test.ts
git commit -m "feat(git): add branchForUnit helper for <prefix>/<unit-id> convention"
```

---

## Task 3: Extend `gh/pr.ts` with `reviewThreads` (synthetic tests + impl)

**Files:**

- Modify: `src/gh/pr.ts:9-17` (PRInfo), `:26-42` (PRNode), `:128-142` (parsePRResponse), `:144-173` (PR_QUERY)
- Modify: `tests/gh/pr-parse.test.ts` (extend)
- Modify: `tests/gh/pr.test.ts:45-53` (samplePR fixture)

**Step 1: Add failing tests for `reviewThreads`**

Append to [tests/gh/pr-parse.test.ts](tests/gh/pr-parse.test.ts) inside the `describe("parsePRResponse")` block:

```ts
test("counts reviewThreads as { resolved, total }", () => {
  const json = makeResponse({
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    state: "OPEN",
    title: "T",
    baseRefName: "main",
    reviewDecision: null,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    reviewThreads: {
      totalCount: 3,
      nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: true }],
    },
  });
  expect(parsePRResponse(json)?.reviewThreads).toEqual({ resolved: 2, total: 3 });
});

test("reviewThreads defaults to 0/0 when missing", () => {
  const json = makeResponse({
    number: 2,
    url: "https://github.com/owner/repo/pull/2",
    state: "OPEN",
    title: "T",
    baseRefName: "main",
    reviewDecision: null,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    // reviewThreads field intentionally omitted
  });
  expect(parsePRResponse(json)?.reviewThreads).toEqual({ resolved: 0, total: 0 });
});

test("reviewThreads with totalCount but no nodes counts resolved as 0", () => {
  const json = makeResponse({
    number: 3,
    url: "https://github.com/owner/repo/pull/3",
    state: "OPEN",
    title: "T",
    baseRefName: "main",
    reviewDecision: null,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    reviewThreads: { totalCount: 5, nodes: [] },
  });
  expect(parsePRResponse(json)?.reviewThreads).toEqual({ resolved: 0, total: 5 });
});
```

The existing `parses an open PR with passing checks and approved review` test at [tests/gh/pr-parse.test.ts:81-119](tests/gh/pr-parse.test.ts#L81-L119) needs the expected object updated to include `reviewThreads: { resolved: 0, total: 0 }`. Update it now (test will fail correctly until impl is added).

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker tests/gh/pr-parse.test.ts
```

Expected: FAIL — `reviewThreads` not present on returned object.

**Step 3: Extend `PRInfo`, the GraphQL query, and `parsePRResponse`**

In [src/gh/pr.ts](src/gh/pr.ts):

Extend `PRInfo` (line 9):

```ts
export interface PRInfo {
  number: number;
  url: string;
  state: PRState;
  title: string;
  baseRefName: string;
  checksStatus: ChecksStatus;
  reviewDecision: ReviewDecision;
  reviewThreads: { resolved: number; total: number };
}
```

Extend the `PRNode` interface (line 26) to include the field:

```ts
interface PRNode {
  number: number;
  url: string;
  state: PRState;
  title: string;
  baseRefName: string;
  reviewDecision: string | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          contexts?: { nodes?: CheckContextNode[] };
        } | null;
      };
    }>;
  };
  reviewThreads?: {
    totalCount?: number;
    nodes?: Array<{ isResolved?: boolean }>;
  };
}
```

Update `parsePRResponse` (line 128) to populate the new field:

```ts
export function parsePRResponse(json: string): PRInfo | null {
  const parsed = JSON.parse(json) as GraphQLResponse;
  const node = parsed.data?.repository?.pullRequests?.nodes?.[0];
  if (!node) return null;

  const threads = node.reviewThreads;
  const total = threads?.totalCount ?? 0;
  const resolved = (threads?.nodes ?? []).filter((t) => t.isResolved === true).length;

  return {
    number: node.number,
    url: node.url,
    state: node.state,
    title: node.title,
    baseRefName: node.baseRefName,
    checksStatus: determineChecksStatus(flattenCheckContexts(node)),
    reviewDecision: determineReviewDecision(node.reviewDecision),
    reviewThreads: { resolved, total },
  };
}
```

Update `PR_QUERY` (line 144) to include `reviewThreads`. Insert before the closing `}` of `nodes {`:

```graphql
        reviewThreads(first: 100) {
          totalCount
          nodes {
            isResolved
          }
        }
```

Final query:

```ts
const PR_QUERY = `
query($branch: String!) {
  repository(owner: $REPOSITORY_OWNER, name: $REPOSITORY_NAME) {
    pullRequests(headRefName: $branch, first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        url
        state
        title
        baseRefName
        reviewDecision
        reviewThreads(first: 100) {
          totalCount
          nodes { isResolved }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { status conclusion }
                    ... on StatusContext { state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;
```

**Step 4: Update the `samplePR` fixture in pr.test.ts**

In [tests/gh/pr.test.ts:45-53](tests/gh/pr.test.ts#L45-L53), add `reviewThreads` to `samplePR` so existing tests stay green:

```ts
const samplePR = {
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  state: "OPEN",
  title: "T",
  baseRefName: "main",
  reviewDecision: null,
  reviewThreads: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
};
```

**Step 5: Run tests to verify**

```bash
bun run test:docker tests/gh/pr-parse.test.ts tests/gh/pr.test.ts
```

Expected: pr-parse all green. pr.test.ts: stub-based tests should pass. Cassette-replaying tests (if any) may still fail — those are addressed in Task 4.

Note: review the output of pr.test.ts carefully. If any tests use cassettes (recorded `gh` responses), they will fail on the cassette mismatch. That's expected — fix in Task 4.

**Step 6: Commit**

```bash
git add src/gh/pr.ts tests/gh/pr-parse.test.ts tests/gh/pr.test.ts
git commit -m "feat(gh): include reviewThreads count in PRInfo"
```

---

## Task 4: Re-record gh integration cassettes

**Files:**

- Modify: `fixtures/tests/gh/...` (regenerated)

**Step 1: Identify which cassettes exist and which tests use them**

```bash
ls -la fixtures/tests/gh/ 2>/dev/null
grep -rn "createRecordingClient\|createReplayingClient\|cassette" tests/gh/ 2>/dev/null
```

If `tests/gh/pr.test.ts` is purely stub-based (which it appears to be), no cassettes exist for it yet — proceed to Step 4.

**Step 2: Decide whether re-recording is needed**

If `fixtures/tests/gh/` has files referenced by `pr.test.ts`, re-recording is required. Run the test suite to see exact failures:

```bash
bun run test:docker tests/gh/pr.test.ts
```

If green: skip to Step 5.

**Step 3: Re-record (only if needed)**

Re-recording requires `GH_TOKEN` and the fixture repo from Step 4 of the rebuild. Reference `tests/gh/` recording instructions (likely in a README or the existing test file).

```bash
bun run test:record tests/gh/pr.test.ts
```

Inspect the diff in `fixtures/tests/gh/` — `reviewThreads` should appear in the recorded JSON.

**Step 4: Run tests to verify cassettes replay correctly**

```bash
bun run test:docker tests/gh/
```

Expected: all green.

**Step 5: Commit**

```bash
git add fixtures/tests/gh/ tests/gh/
git commit -m "test(gh): refresh cassettes to include reviewThreads"
```

If no cassette changes were needed, skip this commit.

---

## Task 5: Create `enrichUnits` orchestrator

**Files:**

- Create: `src/gh/enrich.ts`
- Create: `tests/gh/enrich.test.ts`
- Modify: `src/gh/index.ts` (re-export)

**Step 1: Write the failing tests**

Create [tests/gh/enrich.test.ts](tests/gh/enrich.test.ts):

```ts
import { describe, test, expect } from "bun:test";
import { enrichUnits } from "../../src/gh/enrich.ts";
import { GhAuthError, GhNotInstalledError } from "../../src/gh/errors.ts";
import type {
  CommandResult,
  GhClient,
  GitRunner,
  SpryContext,
} from "../../src/lib/context.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import type { SpryConfig } from "../../src/git/config.ts";

const config: SpryConfig = {
  trunk: "main",
  remote: "origin",
  branchPrefix: "spry/test",
};

function unit(id: string): PRUnit {
  return {
    type: "single",
    id,
    title: "T",
    commitIds: [id],
    commits: [id.repeat(5)],
    subjects: ["T"],
  };
}

function ghOk(prJson: object | null): CommandResult {
  const body = JSON.stringify({
    data: {
      repository: { pullRequests: { nodes: prJson === null ? [] : [prJson] } },
    },
  });
  return { stdout: body, stderr: "", exitCode: 0 };
}

const samplePR = {
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  state: "OPEN",
  title: "T",
  baseRefName: "main",
  reviewDecision: null,
  reviewThreads: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
};

function makeCtx(responses: CommandResult[]): SpryContext {
  let i = 0;
  const gh: GhClient = {
    async run() {
      const r = responses[i++];
      if (!r) throw new Error("stub gh: no more responses");
      return r;
    },
  };
  const git: GitRunner = {
    async run() {
      throw new Error("enrichUnits should not call git");
    },
  };
  return { git, gh };
}

describe("enrichUnits", () => {
  test("empty units array returns empty array, no gh call", async () => {
    const ctx = makeCtx([]);
    const result = await enrichUnits(ctx, [], config);
    expect(result).toEqual([]);
  });

  test("populates pr field for each unit on success", async () => {
    const ctx = makeCtx([ghOk(samplePR), ghOk(null)]);
    const result = await enrichUnits(ctx, [unit("aaa11111"), unit("bbb22222")], config);

    expect(result).toHaveLength(2);
    expect(result[0]!.unit.id).toBe("aaa11111");
    expect(result[0]!.pr?.number).toBe(1);
    expect(result[1]!.unit.id).toBe("bbb22222");
    expect(result[1]!.pr).toBeNull();
    expect(result.every((r) => r.error === undefined)).toBe(true);
  });

  test("returns error: 'no-gh' when gh is not installed", async () => {
    const ctx = makeCtx([
      { stdout: "", stderr: "/bin/sh: gh: command not found", exitCode: 127 },
    ]);
    const result = await enrichUnits(ctx, [unit("aaa11111"), unit("bbb22222")], config);

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.error === "no-gh")).toBe(true);
    expect(result.every((r) => r.pr === null)).toBe(true);
  });

  test("returns error: 'auth' when gh is not authenticated", async () => {
    const ctx = makeCtx([
      { stdout: "", stderr: "You are not logged into any GitHub hosts.", exitCode: 4 },
    ]);
    const result = await enrichUnits(ctx, [unit("aaa11111")], config);
    expect(result[0]!.error).toBe("auth");
  });

  test("returns error: 'no-remote' when repo is not a GitHub repo", async () => {
    const ctx = makeCtx([
      { stdout: "", stderr: "no GitHub remotes found in the current directory", exitCode: 1 },
    ]);
    const result = await enrichUnits(ctx, [unit("aaa11111")], config);
    expect(result[0]!.error).toBe("no-remote");
  });

  test("returns error: 'network' for other post-retry failures", async () => {
    // Three transient failures exhaust the retry budget
    const transient = {
      stdout: "",
      stderr: "HTTP 503: Service Unavailable",
      exitCode: 1,
    };
    const ctx = makeCtx([transient, transient, transient]);
    const result = await enrichUnits(ctx, [unit("aaa11111")], config);
    expect(result[0]!.error).toBe("network");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test:docker tests/gh/enrich.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement `enrichUnits`**

Create [src/gh/enrich.ts](src/gh/enrich.ts):

```ts
import type { SpryContext } from "../lib/context.ts";
import type { SpryConfig } from "../git/config.ts";
import type { PRUnit } from "../parse/types.ts";
import { branchForUnit } from "../git/branch.ts";
import { findPRsForBranches } from "./pr.ts";
import type { PRInfo } from "./pr.ts";
import { GhAuthError, GhNotInstalledError } from "./errors.ts";

export type EnrichmentError = "no-gh" | "auth" | "network" | "no-remote";

export type EnrichedUnit =
  | { unit: PRUnit; pr: PRInfo | null; error?: undefined }
  | { unit: PRUnit; pr: null; error: EnrichmentError };

export async function enrichUnits(
  ctx: SpryContext,
  units: PRUnit[],
  config: SpryConfig,
): Promise<EnrichedUnit[]> {
  if (units.length === 0) return [];

  const branches = units.map((u) => branchForUnit(u, config));

  try {
    const map = await findPRsForBranches(ctx, branches);
    return units.map((unit, i) => ({
      unit,
      pr: map.get(branches[i]!) ?? null,
    }));
  } catch (err) {
    const error = classifyEnrichmentError(err);
    return units.map((unit) => ({ unit, pr: null, error }));
  }
}

function classifyEnrichmentError(err: unknown): EnrichmentError {
  if (err instanceof GhNotInstalledError) return "no-gh";
  if (err instanceof GhAuthError) return "auth";
  if (err instanceof Error && /no github remotes|not a github/i.test(err.message)) {
    return "no-remote";
  }
  return "network";
}
```

Add to [src/gh/index.ts](src/gh/index.ts):

```ts
export { enrichUnits } from "./enrich.ts";
export type { EnrichedUnit, EnrichmentError } from "./enrich.ts";
```

**Step 4: Run tests to verify they pass**

```bash
bun run test:docker tests/gh/enrich.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/gh/enrich.ts src/gh/index.ts tests/gh/enrich.test.ts
git commit -m "feat(gh): add enrichUnits orchestrator with classified failures"
```

---

## Task 6: Rewrite `formatStackView` for two-line layout

**Files:**

- Modify: `src/ui/format.ts` (rewrite `formatStackView`)
- Modify: `tests/ui/format.test.ts` (update existing tests + add new)

**Step 1: Update existing tests to use new signature**

The signature changes from `formatStackView(units, branch, count, ref)` to `formatStackView(enriched, branch, count, ref)`. Every existing test in [tests/ui/format.test.ts](tests/ui/format.test.ts) needs to wrap `units` in `EnrichedUnit[]` form.

Update the import block at the top:

```ts
import { describe, test, expect } from "bun:test";
import { formatStackView, formatValidationError } from "../../src/ui/format.ts";
import type { PRUnit, StackParseResult } from "../../src/parse/types.ts";
import type { EnrichedUnit, EnrichmentError } from "../../src/gh/enrich.ts";
import type { PRInfo } from "../../src/gh/pr.ts";

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function asEnriched(units: PRUnit[]): EnrichedUnit[] {
  return units.map((unit) => ({ unit, pr: null }));
}

function withPR(unit: PRUnit, pr: PRInfo): EnrichedUnit {
  return { unit, pr };
}

function withError(unit: PRUnit, error: EnrichmentError): EnrichedUnit {
  return { unit, pr: null, error };
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 123,
    url: "https://github.com/owner/repo/pull/123",
    state: "OPEN",
    title: "T",
    baseRefName: "main",
    checksStatus: "passing",
    reviewDecision: "approved",
    reviewThreads: { resolved: 2, total: 3 },
    ...overrides,
  };
}
```

For every existing test that calls `formatStackView(units, ...)`, wrap with `asEnriched(units)`. Example:

```ts
const output = formatStackView(asEnriched(units), "main", 0, "origin/main");
```

**Step 2: Add new failing tests for enriched layout**

Append these tests inside `describe("formatStackView", ...)`:

```ts
test("renders two lines for unit with open PR", () => {
  const unit: PRUnit = {
    type: "single",
    id: "a1b2c3d4",
    title: "Add login page",
    commitIds: ["a1b2c3d4"],
    commits: ["aaa"],
    subjects: ["Add login page"],
  };
  const output = stripAnsi(
    formatStackView(
      [withPR(unit, makePR({ state: "OPEN" }))],
      "feat",
      1,
      "origin/main",
    ),
  );

  expect(output).toContain("◐ Add login page (a1b2c3d4)");
  expect(output).toContain("https://github.com/owner/repo/pull/123");
  expect(output).toContain("checks:✓");
  expect(output).toContain("approval:✓");
  expect(output).toContain("comments:2/3");
});

test("uses ✓ for merged PR", () => {
  const unit: PRUnit = {
    type: "single",
    id: "a1",
    title: "Done",
    commitIds: ["a1"],
    commits: ["aaa"],
    subjects: ["Done"],
  };
  const output = stripAnsi(
    formatStackView([withPR(unit, makePR({ state: "MERGED" }))], "feat", 1, "origin/main"),
  );
  expect(output).toContain("✓ Done");
});

test("uses ✗ for closed PR", () => {
  const unit: PRUnit = {
    type: "single",
    id: "a1",
    title: "Abandoned",
    commitIds: ["a1"],
    commits: ["aaa"],
    subjects: ["Abandoned"],
  };
  const output = stripAnsi(
    formatStackView([withPR(unit, makePR({ state: "CLOSED" }))], "feat", 1, "origin/main"),
  );
  expect(output).toContain("✗ Abandoned");
});

test("uses ○ and one-line layout for unit without PR", () => {
  const unit: PRUnit = {
    type: "single",
    id: "a1b2c3d4",
    title: "Pending",
    commitIds: ["a1b2c3d4"],
    commits: ["aaa"],
    subjects: ["Pending"],
  };
  const output = stripAnsi(formatStackView([{ unit, pr: null }], "feat", 1, "origin/main"));
  expect(output).toContain("○ Pending (a1b2c3d4)");
  expect(output).not.toContain("https://");
  expect(output).not.toContain("checks:");
});

test("renders em-dash for none values in checks/approval", () => {
  const unit: PRUnit = {
    type: "single",
    id: "a1",
    title: "T",
    commitIds: ["a1"],
    commits: ["aaa"],
    subjects: ["T"],
  };
  const output = stripAnsi(
    formatStackView(
      [
        withPR(
          unit,
          makePR({
            checksStatus: "none",
            reviewDecision: "none",
            reviewThreads: { resolved: 0, total: 0 },
          }),
        ),
      ],
      "feat",
      1,
      "origin/main",
    ),
  );
  expect(output).toContain("checks:—");
  expect(output).toContain("approval:—");
  expect(output).toContain("comments:0/0");
});

test("renders extended legend when any unit has a PR", () => {
  const unit: PRUnit = {
    type: "single",
    id: "a1",
    title: "T",
    commitIds: ["a1"],
    commits: ["aaa"],
    subjects: ["T"],
  };
  const output = stripAnsi(
    formatStackView([withPR(unit, makePR())], "feat", 1, "origin/main"),
  );
  expect(output).toContain("checks: ✓ pass");
  expect(output).toContain("approval: ✓ approved");
});

test("shows fallback hint when all units share the same enrichment error", () => {
  const unit: PRUnit = {
    type: "single",
    id: "a1",
    title: "T",
    commitIds: ["a1"],
    commits: ["aaa"],
    subjects: ["T"],
  };
  const output = stripAnsi(
    formatStackView([withError(unit, "auth")], "feat", 1, "origin/main"),
  );
  expect(output).toContain("PR status unavailable: gh auth login");
  expect(output).toContain("○ T");
  expect(output).not.toContain("https://");
});

test("fallback hint varies by error class", () => {
  const unit: PRUnit = {
    type: "single",
    id: "a1",
    title: "T",
    commitIds: ["a1"],
    commits: ["aaa"],
    subjects: ["T"],
  };

  expect(
    stripAnsi(formatStackView([withError(unit, "no-gh")], "feat", 1, "origin/main")),
  ).toContain("install gh");

  expect(
    stripAnsi(formatStackView([withError(unit, "no-remote")], "feat", 1, "origin/main")),
  ).toContain("not a GitHub repository");

  expect(
    stripAnsi(formatStackView([withError(unit, "network")], "feat", 1, "origin/main")),
  ).toContain("network error");
});

test("group with PR renders state icon + URL line then tree", () => {
  const unit: PRUnit = {
    type: "group",
    id: "grp1",
    title: "Auth system",
    commitIds: ["a1", "b2"],
    commits: ["aaa", "bbb"],
    subjects: ["Add middleware", "Add session"],
  };
  const output = stripAnsi(
    formatStackView(
      [withPR(unit, makePR({ state: "OPEN" }))],
      "feat",
      2,
      "origin/main",
    ),
  );
  expect(output).toContain("◐ Auth system");
  expect(output).toContain("https://github.com/owner/repo/pull/123");
  expect(output).toContain("├─ Add middleware (a1)");
  expect(output).toContain("└─ Add session (b2)");
});
```

**Step 3: Run tests to verify they fail**

```bash
bun run test:docker tests/ui/format.test.ts
```

Expected: FAIL — current `formatStackView` takes `PRUnit[]`, not `EnrichedUnit[]`; doesn't render PR data.

**Step 4: Rewrite `formatStackView`**

Replace the body of [src/ui/format.ts](src/ui/format.ts) with:

```ts
import kleur from "kleur";
import type { PRUnit, StackParseResult } from "../parse/types.ts";
import type { EnrichedUnit, EnrichmentError } from "../gh/enrich.ts";
import type { ChecksStatus, PRInfo, PRState, ReviewDecision } from "../gh/pr.ts";

const SEPARATOR = "─".repeat(72);

function getCommitIdDisplay(commitIds: string[], index: number): string {
  const id = commitIds[index];
  return id ? kleur.dim(`(${id})`) : kleur.dim("(no ID)");
}

function stateIcon(state: PRState | null): string {
  if (state === null) return kleur.dim("○");
  if (state === "OPEN") return kleur.blue("◐");
  if (state === "MERGED") return kleur.green("✓");
  return kleur.red("✗"); // CLOSED
}

function checksGlyph(s: ChecksStatus): string {
  if (s === "passing") return kleur.green("✓");
  if (s === "failing") return kleur.red("✗");
  if (s === "pending") return kleur.yellow("⏳");
  return kleur.dim("—");
}

function approvalGlyph(d: ReviewDecision): string {
  if (d === "approved") return kleur.green("✓");
  if (d === "changes_requested") return kleur.red("✗");
  if (d === "review_required") return kleur.yellow("?");
  return kleur.dim("—");
}

const HINT_BY_ERROR: Record<EnrichmentError, string> = {
  "no-gh": "PR status unavailable: install gh (https://cli.github.com)",
  auth: "PR status unavailable: gh auth login",
  "no-remote": "PR status unavailable: not a GitHub repository",
  network: "PR status unavailable: network error",
};

function commonError(enriched: EnrichedUnit[]): EnrichmentError | null {
  if (enriched.length === 0) return null;
  const first = enriched[0]!.error;
  if (!first) return null;
  return enriched.every((e) => e.error === first) ? first : null;
}

function prMetaLine(pr: PRInfo): string {
  return (
    `    ${kleur.blue(pr.url)} - ` +
    `checks:${checksGlyph(pr.checksStatus)} ` +
    `approval:${approvalGlyph(pr.reviewDecision)} ` +
    `comments:${pr.reviewThreads.resolved}/${pr.reviewThreads.total}`
  );
}

export function formatStackView(
  enriched: EnrichedUnit[],
  branch: string,
  commitCount: number,
  trunkRef: string,
): string {
  if (enriched.length === 0) {
    return `No commits ahead of ${trunkRef}`;
  }

  const lines: string[] = [];
  const plural = commitCount === 1 ? "commit" : "commits";
  lines.push(`Stack: ${branch} (${commitCount} ${plural})`);

  const fallback = commonError(enriched);
  if (fallback) {
    lines.push(kleur.dim(`${HINT_BY_ERROR[fallback]} (showing local view)`));
  }

  // Legend
  lines.push(kleur.dim("○ no PR  ◐ open  ✓ merged  ✗ closed"));
  const showExtendedLegend = !fallback && enriched.some((e) => e.pr !== null);
  if (showExtendedLegend) {
    lines.push(kleur.dim("checks: ✓ pass  ✗ fail  ⏳ pending  — none"));
    lines.push(kleur.dim("approval: ✓ approved  ✗ changes  ? required  — none"));
  }
  lines.push("");
  lines.push(`  → ${trunkRef}`);

  let letterIndex = 0;
  for (const entry of enriched) {
    lines.push(SEPARATOR);
    const unit = entry.unit;
    const showPRLine = !fallback && entry.pr !== null;
    const icon = showPRLine ? stateIcon(entry.pr!.state) : stateIcon(null);

    if (unit.type === "single") {
      const idDisplay = getCommitIdDisplay(unit.commitIds, 0);
      lines.push(`  ${icon} ${unit.title ?? unit.subjects[0] ?? "Untitled"} ${idDisplay}`);
      if (showPRLine) lines.push(prMetaLine(entry.pr!));
    } else {
      let groupTitle: string;
      if (unit.title) {
        groupTitle = unit.title;
      } else {
        const letter = String.fromCharCode(65 + letterIndex);
        letterIndex++;
        groupTitle = `${letter} (${unit.commits.length} commits)`;
      }
      lines.push(`  ${icon} ${groupTitle}`);
      if (showPRLine) lines.push(prMetaLine(entry.pr!));
      for (let i = 0; i < unit.commits.length; i++) {
        const isLast = i === unit.commits.length - 1;
        const prefix = isLast ? "└─" : "├─";
        const subject = unit.subjects[i] ?? "Unknown commit";
        const idDisplay = getCommitIdDisplay(unit.commitIds, i);
        lines.push(`    ${prefix} ${subject} ${idDisplay}`);
      }
    }
  }

  lines.push(SEPARATOR);
  return lines.join("\n");
}

export function formatValidationError(result: Exclude<StackParseResult, { ok: true }>): string {
  const lines: string[] = [];
  switch (result.error) {
    case "split-group": {
      const commitList = result.group.commits.map((h) => h.slice(0, 8)).join(", ");
      lines.push("Error: Split group detected");
      lines.push("");
      lines.push(
        `  Group "${result.group.title}" (${result.group.id.slice(0, 8)}) has non-contiguous commits.`,
      );
      lines.push(`  Commits: [${commitList}]`);
      lines.push("");
      lines.push(`  ${result.interruptingCommits.length} commit(s) appear between group members:`);
      for (const hash of result.interruptingCommits) {
        lines.push(`    - ${hash.slice(0, 8)}`);
      }
      lines.push("");
      lines.push("  This can happen when fixup! commits are squashed into a group.");
      lines.push("  To fix:");
      lines.push("    sp group --fix   Guided repair (merge or dissolve)");
      lines.push("    sp group         Manual fix via the group editor");
      break;
    }
  }
  return lines.join("\n");
}
```

**Step 5: Run tests to verify**

```bash
bun run test:docker tests/ui/format.test.ts
```

Expected: all green.

**Step 6: Commit**

```bash
git add src/ui/format.ts tests/ui/format.test.ts
git commit -m "feat(ui): two-line per-unit layout with PR enrichment"
```

---

## Task 7: Wire `viewCommand` to call `enrichUnits` + `--no-fetch`

**Files:**

- Modify: `src/commands/view.ts`
- Modify: `tests/commands/view.test.ts` (extend with enrichment cases)

**Step 1: Add failing tests for enrichment integration**

Append to [tests/commands/view.test.ts](tests/commands/view.test.ts) inside `describe("viewCommand", ...)`. First adjust the existing `captureView` helper to accept `opts`:

Change line 9:

```ts
async function captureView(
  ctx: SpryContext,
  opts: { noFetch?: boolean } = {},
): Promise<{ stdout: string; exitCode: number }> {
```

Change line 25:

```ts
    await viewCommand(ctx, opts);
```

Then append:

```ts
test("--no-fetch skips gh and shows local-only view", async () => {
  const repo = await repos.create();
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

  await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
    cwd: repo.path,
  });

  // Use a context whose gh client throws if called
  let ghCalled = false;
  const ctx: SpryContext = {
    git: {
      run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }),
    },
    gh: {
      run: async () => {
        ghCalled = true;
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    },
  };

  const { stdout, exitCode } = await captureView(ctx, { noFetch: true });
  const plain = stripAnsi(stdout);

  expect(exitCode).toBe(0);
  expect(plain).toContain("○ C");
  expect(ghCalled).toBe(false);
});

test("default (no --no-fetch) calls gh and falls back gracefully when gh missing", async () => {
  const repo = await repos.create();
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

  await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
    cwd: repo.path,
  });

  const ctx: SpryContext = {
    git: {
      run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }),
    },
    gh: {
      run: async () => ({
        stdout: "",
        stderr: "/bin/sh: gh: command not found",
        exitCode: 127,
      }),
    },
  };

  const { stdout, exitCode } = await captureView(ctx);
  const plain = stripAnsi(stdout);

  expect(exitCode).toBe(0);
  expect(plain).toContain("PR status unavailable: install gh");
  expect(plain).toContain("○ C");
});
```

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker tests/commands/view.test.ts
```

Expected: FAIL — `viewCommand` doesn't accept opts; doesn't call `enrichUnits`.

**Step 3: Update `viewCommand`**

Replace [src/commands/view.ts](src/commands/view.ts) with:

```ts
import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef, getCurrentBranch, getStackCommits } from "../git/index.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { enrichUnits } from "../gh/enrich.ts";
import type { EnrichedUnit } from "../gh/enrich.ts";
import { formatStackView, formatValidationError } from "../ui/format.ts";

export interface ViewOptions {
  noFetch?: boolean;
}

export async function viewCommand(
  ctx: SpryContext,
  opts: ViewOptions = {},
): Promise<void> {
  const config = await loadConfig(ctx.git);
  const branch = await getCurrentBranch(ctx.git);
  const ref = trunkRef(config);
  const commits = await getStackCommits(ctx.git, ref);
  const withTrailers = await parseCommitTrailers(commits, ctx.git);
  const result = parseStack(withTrailers);

  if (!result.ok) {
    console.error(formatValidationError(result));
    process.exit(1);
  }

  const enriched: EnrichedUnit[] = opts.noFetch
    ? result.units.map((unit) => ({ unit, pr: null }))
    : await enrichUnits(ctx, result.units, config);

  console.log(formatStackView(enriched, branch, commits.length, ref));
}
```

**Step 4: Run tests to verify**

```bash
bun run test:docker tests/commands/view.test.ts
```

Expected: all green.

**Step 5: Commit**

```bash
git add src/commands/view.ts tests/commands/view.test.ts
git commit -m "feat(view): wire enrichUnits with --no-fetch escape hatch"
```

---

## Task 8: Wire CLI `--no-fetch` flag

**Files:**

- Modify: `src/cli/index.ts`

**Step 1: Update CLI to accept `--no-fetch`**

Replace the `view` command registration in [src/cli/index.ts](src/cli/index.ts):

```ts
program
  .command("view")
  .description("View the current stack of commits with PR status")
  .option("--no-fetch", "Skip GitHub enrichment (local view only)")
  .action((opts: { fetch: boolean }) => viewCommand(ctx, { noFetch: !opts.fetch }));
```

Commander's convention: `--no-fetch` produces `opts.fetch === false`.

**Step 2: Smoke-test the CLI manually**

```bash
bun run src/cli/index.ts view --help
```

Expected output should include `--no-fetch  Skip GitHub enrichment (local view only)`.

**Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): add --no-fetch flag to view command"
```

---

## Task 9: Extend doc-producing tests

**Files:**

- Modify: `tests/commands/view.doc.test.ts`
- Generated: `docs/generated/commands/view.md` (regenerated by `docs:build`)

**Step 1: Update the existing `docTest` cases**

The existing tests run the real `sp view` against a real repo. Without a gh client that recognizes the repo, enrichment will produce a fallback hint. We need both:

- A "local-only via `--no-fetch`" doc fragment (clean baseline output).
- A "fallback when gh unavailable" doc fragment.

Replace [tests/commands/view.doc.test.ts](tests/commands/view.doc.test.ts) with:

```ts
import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import { docTest, createRunner, createRepo, createRealGitRunner } from "../lib/index.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const runSp = createRunner(cliPath);

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

describe("sp view docs", () => {
  docTest(
    "Viewing a simple stack (offline)",
    { section: "commands/view", order: 10 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.branch("feature");
      await git.run(
        ["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"],
        { cwd: repo.path },
      );
      await git.run(
        ["commit", "--allow-empty", "-m", "Add signup form\n\nSpry-Commit-Id: bbb22222"],
        { cwd: repo.path },
      );

      doc.prose(
        "View the current stack of commits on your feature branch (use --no-fetch for offline/CI):",
      );

      const { command, result } = await runSp(repo.path, "view", ["--no-fetch"]);
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Stack:");
      expect(result.stdout).toContain("2 commits");
      expect(result.stdout).toContain("Add login page");
      expect(result.stdout).toContain("Add signup form");
    },
  );

  docTest(
    "Viewing an empty stack",
    { section: "commands/view", order: 20 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      doc.prose("When you're on a branch with no commits ahead of trunk:");

      const { command, result } = await runSp(repo.path, "view", ["--no-fetch"]);
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No commits ahead of");
    },
  );

  docTest(
    "PR status unavailable (fallback)",
    { section: "commands/view", order: 30 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.branch("feature");
      await git.run(
        ["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"],
        { cwd: repo.path },
      );

      doc.prose(
        "If gh isn't installed, isn't authenticated, or can't reach GitHub, sp view falls back to local mode with a hint:",
      );

      // Default invocation (no --no-fetch). With no gh on PATH or no auth in test
      // env, we get the no-gh / auth fallback. We assert only on the "PR status
      // unavailable" prefix to keep this stable across environments.
      const { command, result } = await runSp(repo.path, "view");
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("PR status unavailable");
    },
  );
});
```

**Step 2: Run doc tests**

```bash
bun run test:docker tests/commands/view.doc.test.ts
```

Expected: all green. Doc fragments written to `.test-tmp/doc-fragments/`.

**Step 3: Rebuild docs**

```bash
bun run docs:build
```

Expected: `docs/generated/commands/view.md` regenerated with three sections.

**Step 4: Sanity-check the generated docs**

Open [docs/generated/commands/view.md](docs/generated/commands/view.md) and verify:

- Three doc sections appear (Viewing a simple stack, Viewing an empty stack, PR status unavailable).
- The `--no-fetch` invocations show local-only output.
- The fallback section shows a "PR status unavailable: ..." hint.

**Step 5: Commit**

```bash
git add tests/commands/view.doc.test.ts docs/generated/commands/view.md
git commit -m "test(view): doc-producing tests for enriched view"
```

---

## Task 10: Update CHANGELOG

**Files:**

- Modify: `CHANGELOG.md`

**Step 1: Add Unreleased entries**

Edit [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased] / ### Added`:

```markdown
- `sp view` now enriches each unit with PR state (◐ open, ✓ merged, ✗ closed),
  PR URL, checks status, review decision, and resolved-comment count on a
  two-line layout. Defaults to enrichment; falls back to local-only with a
  hint when gh is missing, unauthenticated, the repo isn't a GitHub repo, or
  the network is unreachable.
- `sp view --no-fetch` flag for offline/CI use (skips GitHub enrichment).
- `spry.branchPrefix` config (required) — derives PR branch names as
  `<prefix>/<unit-id>`. For legacy parity, set to `spry/<your-username>`.
- `branchForUnit(unit, config)` helper in `src/git/branch.ts`.
- `enrichUnits(ctx, units, config)` orchestrator in `src/gh/enrich.ts` that
  classifies infra failures into `EnrichmentError` (`no-gh` | `auth` |
  `network` | `no-remote`).
- `PRInfo.reviewThreads: { resolved, total }` from extended GraphQL query.
```

**Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for sp view enrichment"
```

---

## Task 11: Final verification

**Step 1: Run full test suite**

```bash
bun run test:docker
```

Expected: all green.

**Step 2: Run typecheck and lint**

```bash
bun run check
```

Expected: clean.

**Step 3: Smoke-test against a real repo (optional but recommended)**

If you have GitHub auth set up, run against this repo's branch:

```bash
git config spry.trunk main
git config spry.remote origin
git config spry.branchPrefix spry/$(gh api user --jq .login 2>/dev/null || echo test)
bun run src/cli/index.ts view
bun run src/cli/index.ts view --no-fetch
```

Both should produce reasonable output. The first should attempt enrichment (succeed if PR exists, show ○ otherwise); the second should always show local-only.

**Step 4: Final commit if any cleanup needed**

If lint/format auto-corrected anything:

```bash
git add -A
git commit -m "chore: lint/format pass"
```

Otherwise, this task has no commit.

---

## Summary

By completion:

- `SpryConfig` has a third required field (`branchPrefix`).
- `branchForUnit(unit, config)` derives `<prefix>/<unit-id>`.
- `gh/pr.ts` fetches `reviewThreads` alongside checks/review.
- `enrichUnits(ctx, units, config)` returns `EnrichedUnit[]` with classified failures.
- `formatStackView` renders two-line per-unit layout with state icons, URL, checks, approval, comments.
- `sp view` enriches by default, falls back gracefully, supports `--no-fetch`.
- Doc fragments cover local, empty, and fallback scenarios.
- Existing cassettes and tests are updated; full suite passes.
