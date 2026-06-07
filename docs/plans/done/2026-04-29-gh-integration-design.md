---
name: GitHub integration (read-only)
description: Phase 2 Step 4 of the test-first rebuild — production src/gh/ for PR lookup by branch
---

# GitHub Integration (Read-Only) Design

Date: 2026-04-29

## Scope

Phase 2 Step 4 of the test-first rebuild. First module to exercise the recording/replaying client infrastructure built in Phase 1.

**In scope:** PR lookup by branch name, returning state, base ref, checks status, review decision. Simple exponential retry on transient `gh` failures. Typed errors thrown for infra failures (gh missing, auth missing).

**Out of scope (later steps):**

- PR create / update / merge / retarget — landed with their consumers (`sp sync` Step 6, `sp land` Step 8).
- PR body templating (`pr-body.ts`) — Step 6.
- Concurrency limiting / semaphore — Step 10 (`sp sync --all`), the first feature that actually fans out parallel calls.
- `getRepoInfo`, `getCurrentUser`, explicit `ensureGhInstalled` preflight — added when a consumer needs them. The first `gh` call surfaces install/auth failures clearly enough for now.

## Design Decisions

1. **Read-only first.** Port only what `sp view (enriched)` (Step 5) needs. Each later command extends `src/gh/` with the operations it requires. Matches the test-first principle: code lands when its consumer can exercise it end-to-end.

2. **Throw on infra, return data on domain outcomes.** Auth missing, `gh` not installed, network exhausted → typed throw (`GhAuthError`, `GhNotInstalledError`, plain `Error`). "No PR for this branch" → `null` entry in the result `Map`. Same split `loadConfig` already uses in `src/git/config.ts`.

3. **Per-branch GraphQL queries, one `gh api graphql` call each.** Stable cassette entries: editing the branch list doesn't churn unrelated cassette content. GraphQL gets state, baseRef, statusCheckRollup, and reviewDecision in one round trip per branch.

4. **Pure parsing function exposed for unit tests.** `parsePRResponse(json: string): PRInfo | null` is a separate exported function. The orchestrator `findPRsForBranches` composes `ctx.gh.run` + `withRetry` + `parsePRResponse`. Lets us cover the `(state × checksStatus × reviewDecision)` combinatorial space cheaply with synthetic JSON instead of cassettes.

5. **Simple exponential retry, network/5xx only.** Max 3 attempts. 250ms → 500ms → 1000ms with ±20% jitter. No retry on auth failures (they throw). No concurrency cap. Upgrade path is Step 10.

6. **GhClient stays unchanged.** The `GhClient` interface from `src/lib/context.ts` already takes `args: string[]` and returns `{ stdout, stderr, exitCode }`. `src/gh/` only consumes that interface — no new test infrastructure needed.

7. **Recorded cassettes for integration tests, synthetic stubs for unit tests.** Real GitHub gets exercised via `bun test:record` to refresh cassettes; CI replays. Parsing edge cases and retry behavior use stub `GhClient` impls — no cassette churn for those.

## Module: `src/gh/errors.ts`

```ts
export class GhNotInstalledError extends Error {
  constructor() {
    super(
      "gh CLI not found. Install it:\n" +
      "  brew install gh         # macOS\n" +
      "  apt install gh          # Ubuntu\n" +
      "  https://cli.github.com  # Other"
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

Detection lives in `pr.ts` — when `ctx.gh.run` returns non-zero, inspect stderr for known patterns (`command not found`, `not logged into`, `authentication required`) and throw the appropriate typed error. Anything else that survives retry exhaustion bubbles up as a plain `Error` with the stderr included.

## Module: `src/gh/retry.ts`

```ts
export interface RetryOptions {
  maxAttempts?: number;        // default 3
  initialDelayMs?: number;     // default 250
  jitter?: number;             // default 0.2 (±20%)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
  options?: RetryOptions,
): Promise<T>;
```

`fn` is called up to `maxAttempts` times. After each attempt, `shouldRetry(result)` decides if another attempt should be made; when `false`, the result is returned. Backs off by `initialDelayMs * 2^(attempt-1)` with ±jitter. Throws from `fn` propagate immediately (no retry on thrown errors — those are programmer/infra failures, not transient).

In `pr.ts`, the wrapper is used like:

```ts
const result = await withRetry(
  () => ctx.gh.run(args, { cwd }),
  (r) => isTransientFailure(r),
);
```

`isTransientFailure(result)` returns `true` for `exitCode !== 0` AND stderr matches network/5xx patterns (`HTTP 5\d\d`, `connection reset`, `Could not resolve host`, `EAI_AGAIN`, `i/o timeout`). Returns `false` for success or non-transient errors (auth, validation, not-found).

## Module: `src/gh/pr.ts`

```ts
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

export interface FindPRsOptions {
  cwd?: string;
}

export async function findPRsForBranches(
  ctx: SpryContext,
  branches: string[],
  options?: FindPRsOptions,
): Promise<Map<string, PRInfo | null>>;

// Pure: exposed for unit tests. Returns null when GraphQL response shows no PR.
export function parsePRResponse(json: string): PRInfo | null;

// Pure: exposed for unit tests.
export function determineChecksStatus(
  rollup: Array<{ status: string; conclusion: string | null }> | null,
): ChecksStatus;

export function determineReviewDecision(raw: string | null): ReviewDecision;
```

### GraphQL query shape

One query per branch. Looks up PRs with `headRefName == branch` in the repo `gh` resolves from cwd, returns the most recently updated:

```graphql
query($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(headRefName: $branch, first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        url
        state
        title
        baseRefName
        reviewDecision
        statusCheckRollup {
          state
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
}
```

`gh` resolves `$owner`/`$repo` from the local repo's origin remote — we pass them via `--field owner=... --field repo=... --field branch=...` after reading them via `gh repo view --json owner,name` once per `findPRsForBranches` call (one extra `gh` call, cached for the duration of the call).

Actually, simpler: use `gh api graphql -F branch=... -f query=...` and reference `${{repository(owner: $repository.owner.login, name: $repository.name)}}` style — `gh` injects the current repo. That avoids the extra `repo view` call. The implementation will pick whichever `gh api graphql` template form turns out cleanest in practice.

### Auth detection

If a `gh` call returns non-zero with stderr matching:

- `command not found` / `gh: not found` → `throw new GhNotInstalledError()`
- `not logged into` / `authentication required` / `HTTP 401` → `throw new GhAuthError(stderr.trim())`
- Other non-zero AFTER retries exhausted → `throw new Error(\`gh failed: \${stderr.trim()}\`)`

Detected once at the first failed call; later branches in the loop will hit the same condition and the function exits early via the throw.

## Test Plan

```
tests/gh/
  pr.test.ts          # findPRsForBranches integration tests (recorded cassettes)
  pr-parse.test.ts    # parsePRResponse + determine* unit tests (synthetic JSON)
  retry.test.ts       # withRetry unit tests with stub fn
fixtures/tests/gh/<test-file>/<test-name>.json   # committed cassettes
```

### Integration scenarios (recorded cassettes)

Refreshable via `bun test:record`. CI replays.

- Branch with open PR — returns `state: OPEN`, populated `baseRefName`.
- Branch with merged PR — returns `state: MERGED`.
- Branch with closed PR — returns `state: CLOSED`.
- Branch with no PR — returns `null`.
- Multiple branches mixed (open + none + merged) — returns `Map` with correct entries.
- PR with failing checks — `checksStatus: "failing"`.
- PR with passing checks — `checksStatus: "passing"`.
- PR with pending checks — `checksStatus: "pending"`.
- PR with no checks configured — `checksStatus: "none"`.
- PR with approved review — `reviewDecision: "approved"`.
- PR with changes requested — `reviewDecision: "changes_requested"`.

A dedicated test repository (the rebuild's `fixtures/` will get a `gh-test-repo` companion or we set up branches in spry itself) hosts the recorded PRs. Decision deferred to plan-writing.

### Unit scenarios (synthetic, no cassette)

- `parsePRResponse` for each meaningful `(state × checksStatus × reviewDecision)` combination from hand-crafted GraphQL JSON.
- `parsePRResponse` returns `null` for empty `nodes` array.
- `determineChecksStatus` for `null`, empty, all-passing, mixed, all-failing, all-pending rollups.
- `determineReviewDecision` for `null`, `"APPROVED"`, `"CHANGES_REQUESTED"`, `"REVIEW_REQUIRED"`, unknown values.
- `withRetry`:
  - returns immediately when `shouldRetry` is `false` after first call.
  - retries up to `maxAttempts` times, then returns the last result.
  - propagates thrown errors from `fn` without retry.
  - sleeps approximately exponentially (assert delays via fake timers or coarse bounds).
- `findPRsForBranches` with stub gh client:
  - throws `GhAuthError` when stderr matches `not logged into` (no cassette).
  - throws `GhNotInstalledError` when stderr matches `command not found`.
  - exhausted retries on transient failures throw a plain `Error` with stderr included.

## File Layout

```
src/
  gh/
    pr.ts
    retry.ts
    errors.ts
    index.ts        # barrel
tests/
  gh/
    pr.test.ts
    pr-parse.test.ts
    retry.test.ts
fixtures/
  tests/
    gh/
      <recorded cassettes>
```

`src/lib/context.ts` already has `gh: GhClient`. `src/cli/index.ts` already wires `createRealGhClient()` (or will, in this step's task list). No changes to existing test infrastructure needed — `src/gh/` consumes only the `GhClient` interface that Phase 1 already provides.

## Risks & Mitigations

- **Cassette drift over time.** GraphQL response shapes evolve. Mitigation: `bun test:record` regenerates everything from real GitHub; treat cassette refreshes as a routine maintenance task. Document in README alongside the existing testing notes.
- **Recording requires a real PR fixture.** The recording session needs branches that genuinely have the PR states we test against. Mitigation: maintain a small `fixtures/gh-test-repo` script (or notes) that documents how to set up the test repo, with branches like `gh-test/open`, `gh-test/merged`, `gh-test/closed`, etc. Specifics deferred to the plan.
- **Retry interferes with cassette index.** Each transient failure that retries records two entries (failure + retry success). On replay, the same number of calls happens, in the same order. No special handling needed — but if a recorded cassette includes transient failures, the test will replay through them deterministically.
