# GitHub Integration (Read-Only) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `src/gh/` — read-only GitHub PR lookup that `sp view (enriched)` will consume in the next step. `findPRsForBranches(ctx, branches)` returns a `Map<branch, PRInfo | null>` with state, baseRef, checks status, and review decision.

**Architecture:** Three small modules under `src/gh/`. `errors.ts` defines typed throws for infra failures. `retry.ts` wraps `GhClient.run` with exponential backoff on transient failures (network/5xx). `pr.ts` orchestrates per-branch GraphQL queries, exposing pure parsers (`parsePRResponse`, `determineChecksStatus`, `determineReviewDecision`) for cheap unit-test coverage of the response-shape combinatorics, and `findPRsForBranches` as the public entry point.

**Tech Stack:** Bun, TypeScript, `gh` CLI (via `GhClient` from `src/lib/context.ts`), bun:test. No new dependencies.

**Design doc:** [docs/plans/2026-04-29-gh-integration-design.md](2026-04-29-gh-integration-design.md)

**Testing constraint:** This machine has git < 2.40, so all test runs go through Docker. Use `bun run test:docker` (full suite). For tighter per-file iteration during TDD, enter the dev shell with `bun run docker:shell` and run `bun test tests/path/file.ts` from inside the container.

**Test cassette decision:** The design says "record once, replay always" — but real-GitHub recording requires a stable PR fixture repo that doesn't yet exist. To avoid blocking `src/gh/` on fixture setup, this plan uses **stub `GhClient` implementations** for integration-style tests of `findPRsForBranches`. Stubs return crafted `CommandResult` objects, exactly mirroring what `gh api graphql` would output. The cassette infrastructure (recording-client.ts / replaying-client.ts) is already proven by `tests/lib/record-replay.integration.test.ts`. Wiring `bun test:record` against a real fixture repo is a separate, deferred task — the cassette format is the same JSON either way.

---

## Task 0: Move createRealGhClient into src/lib/context.ts

The `createRealGhClient()` factory currently lives in `tests/lib/gh-client.ts`. Phase 2 #3 already moved `createRealGitRunner` into `src/lib/context.ts`; we mirror that move now so production code can construct a real gh client without depending on `tests/`.

**Files:**

- Modify: `src/lib/context.ts` — add `createRealGhClient()`
- Modify: `tests/lib/gh-client.ts` — re-export from `src/lib/context.ts`
- Modify: `tests/lib/index.ts` — barrel still exports `createRealGhClient` (no change needed if it already does)

**Step 1: Add `createRealGhClient` to `src/lib/context.ts`**

Append to `src/lib/context.ts`:

```ts
export function createRealGhClient(): GhClient {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      let proc = $`gh ${args}`.nothrow().quiet();
      if (options?.cwd) proc = proc.cwd(options.cwd);
      if (options?.env) proc = proc.env(options.env);
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

(The `$` import already exists at the top of the file from `createRealGitRunner`.)

**Step 2: Update `tests/lib/gh-client.ts` to re-export**

Replace the body of `tests/lib/gh-client.ts` with:

```ts
export { createRealGhClient } from "../../src/lib/context.ts";
```

**Step 3: Run the full test suite**

Run: `bun run test:docker`
Expected: All existing tests pass. No import errors.

**Step 4: Commit**

```bash
git add src/lib/context.ts tests/lib/gh-client.ts
git commit -m "refactor(lib): move createRealGhClient into src/lib/context"
```

---

## Task 1: Wire gh into the CLI's SpryContext

`src/cli/index.ts` currently builds `SpryContext` with only `git`. Add `gh: createRealGhClient()` so future commands have it available.

**Files:**

- Modify: `src/cli/index.ts`

**Step 1: Update CLI bootstrap**

In `src/cli/index.ts`, change the imports and context construction:

```ts
import { createRealGitRunner, createRealGhClient } from "../lib/context.ts";

// ...

const ctx: SpryContext = {
  git: createRealGitRunner(),
  gh: createRealGhClient(),
};
```

**Step 2: Verify the CLI still loads**

Run: `bun src/cli/index.ts --help`
Expected: usage text printed, exit 0.

**Step 3: Run full test suite**

Run: `bun run test:docker`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): wire createRealGhClient into SpryContext"
```

---

## Task 2: Errors module

Tiny module with two typed error classes. No tests — these are pure data carriers exercised indirectly by `findPRsForBranches` tests in Task 5.

**Files:**

- Create: `src/gh/errors.ts`

**Step 1: Create the module**

```ts
// src/gh/errors.ts

export class GhNotInstalledError extends Error {
  constructor() {
    super(
      "gh CLI not found. Install it:\n" +
        "  brew install gh         # macOS\n" +
        "  apt install gh          # Ubuntu\n" +
        "  https://cli.github.com  # Other",
    );
    this.name = "GhNotInstalledError";
  }
}

export class GhAuthError extends Error {
  constructor(detail: string) {
    super(`GitHub authentication failed: ${detail}\nRun: gh auth login`);
    this.name = "GhAuthError";
  }
}
```

**Step 2: Confirm it type-checks**

Run: `bun run types`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/gh/errors.ts
git commit -m "feat(gh): add typed errors for missing gh CLI and auth failures"
```

---

## Task 3: Retry helper with unit tests

Generic `withRetry` wrapper plus an `isTransientFailure(result)` predicate that the PR module will use.

**Files:**

- Create: `src/gh/retry.ts`
- Create: `tests/gh/retry.test.ts`

**Step 1: Write the failing tests**

Create `tests/gh/retry.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { withRetry, isTransientFailure } from "../../src/gh/retry.ts";
import type { CommandResult } from "../../src/lib/context.ts";

const ok: CommandResult = { stdout: "ok", stderr: "", exitCode: 0 };
const transient500: CommandResult = {
  stdout: "",
  stderr: "HTTP 503: Service Unavailable",
  exitCode: 1,
};
const networkErr: CommandResult = {
  stdout: "",
  stderr: "Could not resolve host: api.github.com",
  exitCode: 1,
};
const authErr: CommandResult = {
  stdout: "",
  stderr: "You are not logged into any GitHub hosts.",
  exitCode: 1,
};

describe("isTransientFailure", () => {
  test("false for success", () => {
    expect(isTransientFailure(ok)).toBe(false);
  });

  test("true for HTTP 5xx", () => {
    expect(isTransientFailure(transient500)).toBe(true);
    expect(
      isTransientFailure({ stdout: "", stderr: "HTTP 502 Bad Gateway", exitCode: 1 }),
    ).toBe(true);
  });

  test("true for connection reset / DNS / timeout", () => {
    expect(isTransientFailure(networkErr)).toBe(true);
    expect(
      isTransientFailure({ stdout: "", stderr: "connection reset by peer", exitCode: 1 }),
    ).toBe(true);
    expect(
      isTransientFailure({ stdout: "", stderr: "i/o timeout", exitCode: 1 }),
    ).toBe(true);
    expect(
      isTransientFailure({ stdout: "", stderr: "EAI_AGAIN", exitCode: 1 }),
    ).toBe(true);
  });

  test("false for auth errors", () => {
    expect(isTransientFailure(authErr)).toBe(false);
  });

  test("false for non-zero exit with unrelated stderr", () => {
    expect(
      isTransientFailure({ stdout: "", stderr: "no such PR", exitCode: 1 }),
    ).toBe(false);
  });
});

describe("withRetry", () => {
  test("returns first result when shouldRetry is false", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return ok;
      },
      () => false,
    );
    expect(result).toBe(ok);
    expect(calls).toBe(1);
  });

  test("retries until shouldRetry returns false", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return calls < 3 ? transient500 : ok;
      },
      (r) => r.exitCode !== 0,
      { initialDelayMs: 1, maxAttempts: 5 },
    );
    expect(result).toBe(ok);
    expect(calls).toBe(3);
  });

  test("returns last result after maxAttempts", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return transient500;
      },
      () => true,
      { initialDelayMs: 1, maxAttempts: 3 },
    );
    expect(result).toBe(transient500);
    expect(calls).toBe(3);
  });

  test("propagates thrown errors immediately", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("boom");
        },
        () => true,
        { initialDelayMs: 1, maxAttempts: 5 },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  test("backoff grows between attempts", async () => {
    const delays: number[] = [];
    let prev = Date.now();
    let calls = 0;
    await withRetry(
      async () => {
        const now = Date.now();
        if (calls > 0) delays.push(now - prev);
        prev = now;
        calls++;
        return transient500;
      },
      () => true,
      { initialDelayMs: 20, maxAttempts: 3, jitter: 0 },
    );
    // delays[0] ~ 20ms, delays[1] ~ 40ms — coarse bounds for CI flakiness
    expect(delays[0]!).toBeGreaterThanOrEqual(15);
    expect(delays[1]!).toBeGreaterThanOrEqual(35);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test:docker`
Expected: FAIL — `src/gh/retry.ts` does not exist.

**Step 3: Implement `src/gh/retry.ts`**

```ts
// src/gh/retry.ts
import type { CommandResult } from "../lib/context.ts";

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  jitter?: number; // fraction (e.g. 0.2 for ±20%)
}

const TRANSIENT_PATTERNS = [
  /HTTP\s+5\d\d/i,
  /connection reset/i,
  /could not resolve host/i,
  /EAI_AGAIN/,
  /i\/o timeout/i,
  /network is unreachable/i,
];

export function isTransientFailure(result: CommandResult): boolean {
  if (result.exitCode === 0) return false;
  return TRANSIENT_PATTERNS.some((pat) => pat.test(result.stderr));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const initialDelayMs = options?.initialDelayMs ?? 250;
  const jitter = options?.jitter ?? 0.2;

  let lastResult: T | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    lastResult = result;
    if (!shouldRetry(result) || attempt === maxAttempts) {
      return result;
    }
    const base = initialDelayMs * 2 ** (attempt - 1);
    const jitterAmount = base * jitter * (Math.random() * 2 - 1);
    const delay = Math.max(0, base + jitterAmount);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  // Unreachable: loop always returns. Keeps TS happy.
  return lastResult as T;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun run test:docker`
Expected: All retry tests PASS, plus all existing tests still pass.

**Step 5: Commit**

```bash
git add src/gh/retry.ts tests/gh/retry.test.ts
git commit -m "feat(gh): add withRetry helper with isTransientFailure detection"
```

---

## Task 4: PR module — pure parsers

Just the pure functions: `parsePRResponse`, `determineChecksStatus`, `determineReviewDecision`. Synthetic JSON in tests, no `gh` calls. The orchestrator (`findPRsForBranches`) lands in Task 5.

**Files:**

- Create: `src/gh/pr.ts` (parsers only — orchestrator added in next task)
- Create: `tests/gh/pr-parse.test.ts`

**Step 1: Write the failing tests**

Create `tests/gh/pr-parse.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  parsePRResponse,
  determineChecksStatus,
  determineReviewDecision,
} from "../../src/gh/pr.ts";

describe("determineReviewDecision", () => {
  test("maps GitHub review decision strings", () => {
    expect(determineReviewDecision("APPROVED")).toBe("approved");
    expect(determineReviewDecision("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(determineReviewDecision("REVIEW_REQUIRED")).toBe("review_required");
  });

  test("maps null and unknown values to 'none'", () => {
    expect(determineReviewDecision(null)).toBe("none");
    expect(determineReviewDecision("FOOBAR")).toBe("none");
  });
});

describe("determineChecksStatus", () => {
  test("'none' for null or empty rollup", () => {
    expect(determineChecksStatus(null)).toBe("none");
    expect(determineChecksStatus([])).toBe("none");
  });

  test("'pending' when any check is in_progress or queued", () => {
    expect(
      determineChecksStatus([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toBe("pending");

    expect(
      determineChecksStatus([{ status: "QUEUED", conclusion: null }]),
    ).toBe("pending");
  });

  test("'failing' when any completed check is failure/cancelled/timed_out", () => {
    expect(
      determineChecksStatus([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("failing");

    expect(
      determineChecksStatus([{ status: "COMPLETED", conclusion: "CANCELLED" }]),
    ).toBe("failing");

    expect(
      determineChecksStatus([{ status: "COMPLETED", conclusion: "TIMED_OUT" }]),
    ).toBe("failing");
  });

  test("'passing' when all completed checks are success/skipped/neutral", () => {
    expect(
      determineChecksStatus([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
        { status: "COMPLETED", conclusion: "NEUTRAL" },
      ]),
    ).toBe("passing");
  });
});

describe("parsePRResponse", () => {
  // Helper: build a GraphQL response shape with one PR node
  function makeResponse(pr: object | null) {
    return JSON.stringify({
      data: {
        repository: {
          pullRequests: { nodes: pr === null ? [] : [pr] },
        },
      },
    });
  }

  test("returns null when no PRs match", () => {
    expect(parsePRResponse(makeResponse(null))).toBeNull();
  });

  test("parses an open PR with passing checks and approved review", () => {
    const json = makeResponse({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "OPEN",
      title: "Add login page",
      baseRefName: "main",
      reviewDecision: "APPROVED",
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
                  ],
                },
              },
            },
          },
        ],
      },
    });
    const pr = parsePRResponse(json);
    expect(pr).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "OPEN",
      title: "Add login page",
      baseRefName: "main",
      checksStatus: "passing",
      reviewDecision: "approved",
    });
  });

  test("parses a merged PR", () => {
    const json = makeResponse({
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      state: "MERGED",
      title: "Old work",
      baseRefName: "main",
      reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    const pr = parsePRResponse(json);
    expect(pr?.state).toBe("MERGED");
    expect(pr?.checksStatus).toBe("none");
    expect(pr?.reviewDecision).toBe("none");
  });

  test("parses a PR with StatusContext entries (legacy commit statuses)", () => {
    const json = makeResponse({
      number: 11,
      url: "https://github.com/owner/repo/pull/11",
      state: "OPEN",
      title: "Legacy CI",
      baseRefName: "main",
      reviewDecision: "REVIEW_REQUIRED",
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [{ __typename: "StatusContext", state: "FAILURE" }],
                },
              },
            },
          },
        ],
      },
    });
    expect(parsePRResponse(json)?.checksStatus).toBe("failing");
  });

  test("parses a PR with no commits.nodes entries", () => {
    const json = makeResponse({
      number: 3,
      url: "https://github.com/owner/repo/pull/3",
      state: "OPEN",
      title: "No commits in response",
      baseRefName: "main",
      reviewDecision: null,
      commits: { nodes: [] },
    });
    expect(parsePRResponse(json)?.checksStatus).toBe("none");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test:docker`
Expected: FAIL — `src/gh/pr.ts` does not exist.

**Step 3: Implement the parsers**

Create `src/gh/pr.ts`:

```ts
// src/gh/pr.ts

export type PRState = "OPEN" | "CLOSED" | "MERGED";
export type ChecksStatus = "pending" | "passing" | "failing" | "none";
export type ReviewDecision =
  | "approved"
  | "changes_requested"
  | "review_required"
  | "none";

export interface PRInfo {
  number: number;
  url: string;
  state: PRState;
  title: string;
  baseRefName: string;
  checksStatus: ChecksStatus;
  reviewDecision: ReviewDecision;
}

interface CheckContextNode {
  __typename?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
}

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
}

interface GraphQLResponse {
  data?: {
    repository?: {
      pullRequests?: { nodes?: PRNode[] };
    };
  };
}

export function determineReviewDecision(raw: string | null): ReviewDecision {
  switch (raw) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

export function determineChecksStatus(
  rollup: Array<{ status: string; conclusion: string | null }> | null,
): ChecksStatus {
  if (!rollup || rollup.length === 0) return "none";

  const PASS_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  const FAIL_CONCLUSIONS = new Set([
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ]);

  let hasPending = false;
  let hasFailure = false;

  for (const item of rollup) {
    if (item.status !== "COMPLETED") {
      hasPending = true;
      continue;
    }
    if (item.conclusion && FAIL_CONCLUSIONS.has(item.conclusion)) {
      hasFailure = true;
    } else if (item.conclusion && !PASS_CONCLUSIONS.has(item.conclusion)) {
      // Unknown completed conclusion — treat as failure to be safe
      hasFailure = true;
    }
  }

  if (hasFailure) return "failing";
  if (hasPending) return "pending";
  return "passing";
}

function flattenCheckContexts(
  pr: PRNode,
): Array<{ status: string; conclusion: string | null }> | null {
  const node = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!node) return null;
  const contexts = node.contexts?.nodes ?? [];
  if (contexts.length === 0) return [];

  return contexts.map((c) => {
    // CheckRun has status + conclusion. StatusContext has state only.
    if (c.__typename === "StatusContext") {
      // Map state strings to our (status, conclusion) shape.
      // GitHub StatusContext states: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED.
      switch (c.state) {
        case "SUCCESS":
          return { status: "COMPLETED", conclusion: "SUCCESS" };
        case "FAILURE":
        case "ERROR":
          return { status: "COMPLETED", conclusion: "FAILURE" };
        case "PENDING":
        case "EXPECTED":
        default:
          return { status: "IN_PROGRESS", conclusion: null };
      }
    }
    // CheckRun
    return {
      status: c.status ?? "QUEUED",
      conclusion: c.conclusion ?? null,
    };
  });
}

export function parsePRResponse(json: string): PRInfo | null {
  const parsed = JSON.parse(json) as GraphQLResponse;
  const node = parsed.data?.repository?.pullRequests?.nodes?.[0];
  if (!node) return null;

  return {
    number: node.number,
    url: node.url,
    state: node.state,
    title: node.title,
    baseRefName: node.baseRefName,
    checksStatus: determineChecksStatus(flattenCheckContexts(node)),
    reviewDecision: determineReviewDecision(node.reviewDecision),
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun run test:docker`
Expected: All parsing tests PASS plus existing tests.

**Step 5: Commit**

```bash
git add src/gh/pr.ts tests/gh/pr-parse.test.ts
git commit -m "feat(gh): add PR response parsers (parsePRResponse and helpers)"
```

---

## Task 5: PR module — findPRsForBranches orchestrator

Add the public entry point that runs one `gh api graphql` call per branch through `withRetry`, parses results, and surfaces auth/install failures as typed throws.

**Files:**

- Modify: `src/gh/pr.ts` — append `findPRsForBranches`
- Create: `tests/gh/pr.test.ts`

**Step 1: Write the failing tests**

Create `tests/gh/pr.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { findPRsForBranches } from "../../src/gh/pr.ts";
import { GhAuthError, GhNotInstalledError } from "../../src/gh/errors.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  SpryContext,
  GitRunner,
} from "../../src/lib/context.ts";

// Build a stub GhClient that returns a queue of CommandResults in order.
// Captures every call for assertions.
function stubGh(responses: CommandResult[]): {
  ctx: SpryContext;
  calls: Array<{ args: string[]; options?: CommandOptions }>;
} {
  let i = 0;
  const calls: Array<{ args: string[]; options?: CommandOptions }> = [];
  const gh: GhClient = {
    async run(args, options) {
      calls.push({ args, options });
      const resp = responses[i++];
      if (!resp) throw new Error(`stub gh: no more responses; called with ${args.join(" ")}`);
      return resp;
    },
  };
  // Tests don't exercise git via findPRsForBranches.
  const git: GitRunner = {
    async run() {
      throw new Error("findPRsForBranches should not call git");
    },
  };
  return { ctx: { git, gh }, calls };
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
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
};

describe("findPRsForBranches", () => {
  test("returns empty Map for empty branches array", async () => {
    const { ctx, calls } = stubGh([]);
    const result = await findPRsForBranches(ctx, []);
    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("returns null entry for branch with no matching PR", async () => {
    const { ctx } = stubGh([ghOk(null)]);
    const result = await findPRsForBranches(ctx, ["feature/x"]);
    expect(result.get("feature/x")).toBeNull();
    expect(result.size).toBe(1);
  });

  test("returns PRInfo for branch with a matching PR", async () => {
    const { ctx } = stubGh([ghOk(samplePR)]);
    const result = await findPRsForBranches(ctx, ["feature/x"]);
    expect(result.get("feature/x")?.number).toBe(1);
    expect(result.get("feature/x")?.state).toBe("OPEN");
  });

  test("queries each branch once and preserves order in result Map", async () => {
    const { ctx, calls } = stubGh([
      ghOk({ ...samplePR, number: 1 }),
      ghOk(null),
      ghOk({ ...samplePR, number: 3 }),
    ]);
    const result = await findPRsForBranches(ctx, ["a", "b", "c"]);
    expect([...result.keys()]).toEqual(["a", "b", "c"]);
    expect(result.get("a")?.number).toBe(1);
    expect(result.get("b")).toBeNull();
    expect(result.get("c")?.number).toBe(3);
    expect(calls).toHaveLength(3);
  });

  test("passes cwd to the gh client", async () => {
    const { ctx, calls } = stubGh([ghOk(null)]);
    await findPRsForBranches(ctx, ["x"], { cwd: "/tmp/repo" });
    expect(calls[0]!.options?.cwd).toBe("/tmp/repo");
  });

  test("throws GhNotInstalledError when stderr matches", async () => {
    const { ctx } = stubGh([
      { stdout: "", stderr: "/bin/sh: gh: command not found", exitCode: 127 },
    ]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toBeInstanceOf(
      GhNotInstalledError,
    );
  });

  test("throws GhAuthError when stderr indicates not logged in", async () => {
    const { ctx } = stubGh([
      { stdout: "", stderr: "You are not logged into any GitHub hosts. Run `gh auth login`.", exitCode: 4 },
    ]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toBeInstanceOf(GhAuthError);
  });

  test("throws GhAuthError on HTTP 401", async () => {
    const { ctx } = stubGh([
      { stdout: "", stderr: "HTTP 401: Bad credentials", exitCode: 1 },
    ]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toBeInstanceOf(GhAuthError);
  });

  test("retries transient failures and returns success", async () => {
    const { ctx, calls } = stubGh([
      { stdout: "", stderr: "HTTP 503: Service Unavailable", exitCode: 1 },
      ghOk(samplePR),
    ]);
    const result = await findPRsForBranches(ctx, ["x"]);
    expect(result.get("x")?.number).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("throws after retries exhausted with stderr in the message", async () => {
    const transient = {
      stdout: "",
      stderr: "HTTP 503: Service Unavailable",
      exitCode: 1,
    };
    const { ctx } = stubGh([transient, transient, transient]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toThrow(/503/);
  });

  test("throws plain Error on non-transient unknown failure", async () => {
    const { ctx } = stubGh([
      { stdout: "", stderr: "GraphQL error: malformed query", exitCode: 1 },
    ]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toThrow(/GraphQL error/);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test:docker`
Expected: FAIL — `findPRsForBranches` is not exported.

**Step 3: Append `findPRsForBranches` to `src/gh/pr.ts`**

Add to the bottom of `src/gh/pr.ts`:

```ts
import type { SpryContext, CommandResult } from "../lib/context.ts";
import { GhAuthError, GhNotInstalledError } from "./errors.ts";
import { withRetry, isTransientFailure } from "./retry.ts";

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

export interface FindPRsOptions {
  cwd?: string;
}

const NOT_INSTALLED_PATTERNS = [
  /command not found/i,
  /\bgh\s*:\s*not found\b/i,
  /no such file or directory.*gh/i,
];

const AUTH_PATTERNS = [
  /not logged into/i,
  /authentication required/i,
  /HTTP 401/i,
  /bad credentials/i,
];

function classifyError(stderr: string): "not-installed" | "auth" | "other" {
  if (NOT_INSTALLED_PATTERNS.some((p) => p.test(stderr))) return "not-installed";
  if (AUTH_PATTERNS.some((p) => p.test(stderr))) return "auth";
  return "other";
}

function throwForFailure(result: CommandResult): never {
  const kind = classifyError(result.stderr);
  if (kind === "not-installed") throw new GhNotInstalledError();
  if (kind === "auth") throw new GhAuthError(result.stderr.trim());
  throw new Error(`gh failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

async function lookupOne(
  ctx: SpryContext,
  branch: string,
  options?: FindPRsOptions,
): Promise<PRInfo | null> {
  const args = [
    "api",
    "graphql",
    "-F",
    `branch=${branch}`,
    "-f",
    `query=${PR_QUERY}`,
  ];
  // Auth/install errors are detectable on the first attempt — short-circuit before retrying.
  const result = await withRetry(
    () => ctx.gh.run(args, { cwd: options?.cwd }),
    (r) => {
      if (r.exitCode === 0) return false;
      // Don't retry auth/install failures. Let them bubble out as throws.
      if (classifyError(r.stderr) !== "other") return false;
      return isTransientFailure(r);
    },
  );

  if (result.exitCode !== 0) throwForFailure(result);
  return parsePRResponse(result.stdout);
}

export async function findPRsForBranches(
  ctx: SpryContext,
  branches: string[],
  options?: FindPRsOptions,
): Promise<Map<string, PRInfo | null>> {
  const result = new Map<string, PRInfo | null>();
  for (const branch of branches) {
    result.set(branch, await lookupOne(ctx, branch, options));
  }
  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun run test:docker`
Expected: All `findPRsForBranches` tests PASS plus existing tests.

**Step 5: Commit**

```bash
git add src/gh/pr.ts tests/gh/pr.test.ts
git commit -m "feat(gh): add findPRsForBranches with retry and typed error handling"
```

---

## Task 6: Barrel export

Single import surface for `src/gh/`.

**Files:**

- Create: `src/gh/index.ts`

**Step 1: Create the barrel**

```ts
// src/gh/index.ts
export {
  findPRsForBranches,
  parsePRResponse,
  determineChecksStatus,
  determineReviewDecision,
} from "./pr.ts";
export type {
  PRInfo,
  PRState,
  ChecksStatus,
  ReviewDecision,
  FindPRsOptions,
} from "./pr.ts";
export { GhAuthError, GhNotInstalledError } from "./errors.ts";
export { withRetry, isTransientFailure } from "./retry.ts";
export type { RetryOptions } from "./retry.ts";
```

**Step 2: Verify it type-checks**

Run: `bun run types`
Expected: No errors.

**Step 3: Run full test suite**

Run: `bun run test:docker`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/gh/index.ts
git commit -m "feat(gh): add barrel export for src/gh"
```

---

## Task 7: Update CHANGELOG and final verification

**Files:**

- Modify: `CHANGELOG.md`

**Step 1: Add changelog entry**

Add under Unreleased / Added in `CHANGELOG.md`:

```
- `src/gh/` module — read-only GitHub PR lookup (`findPRsForBranches`)
- Typed errors `GhAuthError` and `GhNotInstalledError` for infra failures
- `withRetry` helper with exponential backoff on transient (network/5xx) failures
- `createRealGhClient` factory promoted from `tests/lib/` to `src/lib/context.ts`
```

**Step 2: Run full lint + types + tests**

Run: `bun run check && bun run test:docker`
Expected: All clean.

**Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for src/gh read-only module"
```

---

## Done

After Task 7, `src/gh/` is ready to be consumed by Phase 2 #5 (`sp view (enriched)`). Recording real-GitHub cassettes for `findPRsForBranches` is a deferred task — track it as a follow-up when a stable PR fixture repo is wired up.
