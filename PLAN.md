# Plan: GitHub Service with Record/Replay Testing

## Status: Phase 3 complete

**Phase 1 (Infrastructure)** - DONE

- All 6 service files created
- Example test created
- Tests skip gracefully without snapshots (using native Bun skip)

**Phase 2 (Record Snapshots)** - DONE

- Snapshots recorded for service.snapshot.test.ts
- Replay mode verified (~8s vs ~17s record mode)
- Snapshot file cleared on re-recording (no stale entries)

**Phase 2.5 (Offline Replay)** - DONE

- `repoManager({ github: true })` now uses local bare repos in replay mode (no `gh` CLI needed)
- Snapshot files store `context` (`owner`/`repo`) for replay-mode fixture stubs
- Replay mode runs in ~900ms (down from ~12s) with zero network calls
- Verified with `ribbin activate` (blocks `gh` CLI) — all 4 tests pass

**Phase 3 (Migration)** - DONE

- `pr-status.test.ts` fully migrated: all 8 runnable tests work in both record and replay modes
- All `skipIf(SKIP_CI_TESTS)` and `skipIf(SKIP_GITHUB_TESTS)` guards removed
- Record-mode-only operations (git push, waitForCI, branch protection, `gh` CLI) wrapped in `isGitHubIntegrationEnabled()`
- Story tests restructured: `runSync()` replaced with direct `service.createPR()` calls
- Stub fixture methods changed from throwing to no-ops (safe in replay mode)
- `snapshot-compose.ts` enhanced: `noStory` wrapped with snapshot support, `wrapTestFn` arity bug fixed
- Replay mode runs all 8 tests in ~25ms each (vs ~10-17s in record mode)
- Verified offline with `ribbin activate`: 73 pass, 39 skip, 0 fail (8 more tests passing than before)

**Phase 3.5 (Migrate remaining test files)** - TODO

Migrate sync, land, view, and clean integration tests to the snapshot replay system. Goal: zero skips in replay mode (except permanently-skipped tests needing a second GitHub user).

**Current state:** 39 skipped tests in replay mode across 4 unmigrated files.

**Key challenge:** Unlike pr-status (which calls `getGitHubService()` directly), these tests run the `sp` CLI via subprocesses (`runSync()`, `runLand()`, etc.) and verify CLI output. GitHub API calls happen _inside_ the subprocess, which has no snapshot context.

**Proposed approach — subprocess snapshot passthrough:**

1. Pass snapshot context to subprocesses via env vars (`SNAPSHOT_TEST_FILE`, `SNAPSHOT_TEST_NAME`, `SNAPSHOT_TEST_ID`)
2. Have `snapshot-context.ts` check for these env vars as a fallback when `getSnapshotContext()` has no in-process context
3. Have `runSpry()` in `tests/integration/helpers.ts` set these env vars from the current test context
4. Subprocesses then record/replay service calls automatically

**Pre-requisite investigation:** Verify that the `sp` CLI uses `getGitHubService()` for _all_ GitHub operations (not direct `gh` CLI calls). Any direct `gh` calls in production code would bypass the snapshot service.

**Files to migrate (priority order):**

| File            | GitHub tests | Difficulty | Notes                                                        |
| --------------- | ------------ | ---------- | ------------------------------------------------------------ |
| `view.test.ts`  | 4            | Easy       | No fixture methods, just `runSync()` + `runView()`           |
| `clean.test.ts` | 5            | Moderate   | Uses `mergePR()` fixture (4x), direct `gh` CLI (6x)          |
| `sync.test.ts`  | 7            | Moderate   | Branch protection (2x), `waitForCI()` (3x), `mergePR()` (1x) |
| `land.test.ts`  | 9            | Hard       | Heavy CI dependency: `waitForCI()` (13x), 8/9 tests CI-gated |

**Per-file migration pattern (same as pr-status):**

1. Add `withGitHubSnapshots(base)` wrapping
2. Remove `skipIf(SKIP_GITHUB_TESTS)` / `skipIf(SKIP_CI_TESTS)` guards
3. Wrap record-mode-only operations in `isGitHubIntegrationEnabled()`
4. Ensure all observable GitHub calls go through `getGitHubService()`
5. Record snapshots with `test:ci:docker`, verify replay with `ribbin activate`

---

## Quick Summary

**What:** Create a `GitHubService` abstraction layer with snapshot-based testing that records real GitHub API responses and replays them in subsequent test runs.

**Key Innovation:** Dynamic test ID substitution - record with one test ID (e.g., `happy-penguin-x3f`), replay with a different one (e.g., `brave-falcon-k2m`) while automatically substituting IDs in responses.

**Composability:** Use `withGitHubSnapshots()` composition function to add snapshot support to any test suite (including `createStoryTest`).

**Test Experience:**

```typescript
// withGitHubSnapshots auto-detects test file from Bun.main
const base = createStoryTest(import.meta.file);
const { test } = withGitHubSnapshots(base);

describe("PR operations", () => {
  const repos = repoManager({ github: true });

  test("creates PR", async (story) => {
    const repo = await repos.clone();
    // GitHub service automatically uses repos.uniqueId and test context
    const result = await getGitHubService().createPR({...});
    // Fast in replay mode, uses real data from record mode
  });
});
```

## Goal

Create a `GitHubService` interface that wraps all GitHub operations with a **snapshot-based testing approach**. The test service wraps the real service and records results, allowing tests to replay recorded responses without hitting GitHub.

## Updated Testing Strategy (Key Change)

Instead of swapping services based on ENV vars, we'll use a **record/replay pattern**:

### Record Mode (with `GITHUB_INTEGRATION_TESTS=1`)

1. Test calls `service.getUsername()`
2. Snapshot service wraps the real service
3. Real service calls `gh` CLI → returns `"testuser"`
4. Snapshot service records `"testuser"` to a snapshot file
5. Returns `"testuser"` to caller

### Replay Mode (without ENV vars - default)

1. Test calls `service.getUsername()`
2. Snapshot service reads from snapshot file
3. Returns `Promise.resolve("testuser")` from snapshot
4. No GitHub API calls, no `gh` CLI execution

### Benefits

- Tests are fast by default (replay mode)
- Tests use real GitHub responses (not hand-crafted mocks)
- Can re-record snapshots when GitHub API changes
- Explicit about what responses are being tested
- **Gradual migration**: Tests without snapshots skip gracefully (no failures)
- Run partial test suites without all snapshots recorded

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Test Code                                       │
│ (uses getGitHubService())                       │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│ Service Layer (DI)                              │
│ - getGitHubService()                            │
│ - setGitHubService()                            │
└────────────────────┬────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
┌──────────────────┐    ┌──────────────────────┐
│ Snapshot Service │    │ Default (Real)       │
│ (Test Mode)      │    │ Service              │
│                  │    │ (Production)         │
│ Wraps Real ───►  │    │                      │
│ Records/Replays  │    │ Direct gh CLI        │
│ Results          │    │ via ghExecWithLimit  │
└──────────────────┘    └──────────────────────┘
```

## Files to Create

### 1. `src/github/service.ts` - Interface and DI

```typescript
export interface GitHubService {
  // User/Auth
  getUsername(): Promise<string>;

  // PR Queries
  findPRByBranch(branch: string): Promise<PRInfo | null>;
  findPRsByBranches(branches: string[]): Promise<Map<string, PRInfo | null>>;
  getPRChecksStatus(prNumber: number): Promise<ChecksStatus>;
  getPRReviewStatus(prNumber: number): Promise<ReviewDecision>;
  getPRCommentStatus(prNumber: number): Promise<CommentStatus>;
  getPRMergeStatus(prNumber: number): Promise<PRMergeStatus>;
  getPRState(prNumber: number): Promise<"OPEN" | "CLOSED" | "MERGED">;
  getPRBody(prNumber: number): Promise<string>;
  getPRBaseBranch(prNumber: number): Promise<string>;

  // PR Mutations
  createPR(options: CreatePROptions): Promise<{ number: number; url: string }>;
  retargetPR(prNumber: number, newBase: string): Promise<void>;
  updatePRBody(prNumber: number, body: string): Promise<void>;
  addPRComment(prNumber: number, body: string): Promise<void>;
  closePR(prNumber: number, comment?: string): Promise<void>;
}

// DI functions
let githubService: GitHubService | null = null;

export function getGitHubService(): GitHubService {
  if (!githubService) {
    // Default to snapshot service in tests, real service in production
    githubService = isTestEnvironment()
      ? createSnapshotGitHubService()
      : createDefaultGitHubService();
  }
  return githubService;
}

export function setGitHubService(service: GitHubService): void {
  githubService = service;
}

export function resetGitHubService(): void {
  githubService = null;
}

function isTestEnvironment(): boolean {
  return typeof Bun !== 'undefined' && Bun.jest !== undefined;
}
```

### 2. `src/github/service.default.ts` - Real Implementation

Delegates all methods to existing functions in `api.ts`, `pr.ts`, etc.

```typescript
import { getGitHubUsername } from './api.ts';
import { findPRForBranch, /* other functions */ } from './pr.ts';

export function createDefaultGitHubService(): GitHubService {
  return {
    getUsername: async () => getGitHubUsername(),
    findPRByBranch: async (branch: string) => findPRForBranch(branch),
    // ... all other methods delegate to existing implementations
  };
}
```

### 3. `src/github/service.snapshot.ts` - Record/Replay with Dynamic Substitution

**Key component!** See full implementation in code blocks below. Key features:

- Wraps real service
- Records responses with test context (testFile, testName, testId)
- Replays responses with test ID substitution
- Throws `SnapshotNotFoundError` for missing snapshots (handled gracefully by test wrapper)

### 4. `src/github/snapshot-context.ts` - Test Context Registry

Global registry that tracks:

- `testFile`: e.g., "pr.test.ts"
- `testName`: e.g., "creates PR for feature branch"
- `testId`: e.g., "happy-penguin-x3f" from `repos.uniqueId`

Functions:

- `registerRepoContext(uniqueId)` - called by repoManager in beforeEach
- `setTestMetadata(testFile, testName)` - called by test wrapper
- `getSnapshotContext()` - used by snapshot service
- `clearSnapshotContext()` - called in afterEach
- `getSnapshotPath(testFile)` - converts "pr.test.ts" → "tests/snapshots/pr.json"

### 5. `tests/helpers/snapshot-compose.ts` - Composition Function

**Composable function to add snapshot support:**

```typescript
export function withGitHubSnapshots(suite: TestSuite, testFile: string): TestSuite
```

Usage:

```typescript
const base = createStoryTest("pr.test.ts");
const { test } = withGitHubSnapshots(base, "pr.test.ts");
```

Features:

- Wraps test functions to set test metadata before execution
- Catches `SnapshotNotFoundError` and skips test with warning
- Clears context in afterEach
- Preserves test.skip, test.only, etc.

### 6. `src/github/service.mock.ts` - Simple Mocks

For unit tests that need specific behavior:

```typescript
export function createMockGitHubService(
  overrides: Partial<GitHubService> = {}
): GitHubService
```

## Files to Modify

### `tests/helpers/local-repo.ts`

Add ONE line in the beforeEach hook for GitHub repos:

```typescript
import { registerRepoContext } from "../../src/github/snapshot-context.ts";

// In the beforeEach hook for GitHub repos (around line 328):
beforeEach(async () => {
  ctx.uniqueId = generateUniqueId();
  registerRepoContext(ctx.uniqueId);  // ADD THIS LINE
  await githubFixture?.reset();
});
```

## Environment Variable Behavior

| Mode              | ENV Var                      | Service Used                    | Behavior                                                                           |
| ----------------- | ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| **Production**    | None                         | Default                         | Real `gh` CLI calls                                                                |
| **Test - Replay** | None                         | Snapshot (replay)               | Returns recorded results with ID substitution. **Tests skip if snapshot missing.** |
| **Test - Record** | `GITHUB_INTEGRATION_TESTS=1` | Snapshot (record)               | Calls real service, records results with test context                              |
| **Test - Custom** | Any                          | Manual via `setGitHubService()` | Uses provided mock                                                                 |

### Test Skip Behavior

In **replay mode** (no ENV var):

- ✅ Tests with snapshots: Run fast using recorded data
- ⊘ Tests without snapshots: Skip with warning message
- No test failures for missing snapshots

In **record mode** (`GITHUB_INTEGRATION_TESTS=1`):

- ✅ All tests run against real GitHub
- 📝 Snapshots created/updated for all tests
- Tests may be slower but create complete snapshot coverage

## Snapshot Storage Strategy

**Per-test-file snapshots:**

- `pr.test.ts` → `tests/snapshots/pr.json`
- `sync.test.ts` → `tests/snapshots/sync.json`
- `api.test.ts` → `tests/snapshots/api.json`

**Benefits:**

- Test names only need to be unique within a file
- Smaller, more manageable snapshot files
- Easier to re-record specific test areas
- Clear organization that mirrors test file structure

## Example Test Usage

### Integration Tests with Story + Snapshots

```typescript
import { createStoryTest } from "../helpers/story-test.ts";
import { withGitHubSnapshots } from "../helpers/snapshot-compose.ts";
import { repoManager } from "../helpers/local-repo.ts";
import { getGitHubService } from "../../src/github/service.ts";

// Compose story test + GitHub snapshot support
const base = createStoryTest("pr.test.ts");
const { test } = withGitHubSnapshots(base, "pr.test.ts");

describe("GitHub PR operations", () => {
  const repos = repoManager({ github: true });

  test("creates PR for feature branch", async (story) => {
    const repo = await repos.clone();
    const testId = repos.uniqueId;

    story.strip(testId);
    story.narrate("Creating a PR for a feature branch");

    const branchName = await repo.branch("feature");
    await repo.commit({ message: "Add feature" });
    await $`git -C ${repo.path} push -u origin ${branchName}`.quiet();

    // GitHub service call - automatically snapshots
    const result = await getGitHubService().createPR({
      title: `Test Feature ${testId}`,
      base: "main",
      head: branchName,
    });

    expect(result.number).toBeGreaterThan(0);

    // RECORD mode: Real GitHub, saves snapshot
    // REPLAY mode: Uses snapshot, substitutes testId
  });
});
```

### Just Snapshots (No Story)

```typescript
import { test as bunTest } from "bun:test";
import { withGitHubSnapshots } from "../helpers/snapshot-compose.ts";

const { test } = withGitHubSnapshots({ test: bunTest }, "api.test.ts");

describe("GitHub API", () => {
  const repos = repoManager({ github: true });

  test("gets username", async () => {
    const username = await getGitHubService().getUsername();
    expect(username).toBeTruthy();
  });
});
```

## How It Works: The Complete Flow

1. **Test Setup (beforeEach)**:
   - `repoManager` generates `uniqueId` → "happy-penguin-x3f"
   - Calls `registerRepoContext("happy-penguin-x3f")`

2. **Test Execution**:
   - `withGitHubSnapshots` wrapper calls `setTestMetadata("pr.test.ts", "creates PR")`
   - Context now has: `{ testFile: "pr.test.ts", testName: "creates PR", testId: "happy-penguin-x3f" }`

3. **GitHub Service Call**:
   - Test calls `getGitHubService().createPR({...})`
   - Service reads context via `getSnapshotContext()`
   - **Record mode**: Calls real service, saves response to `tests/snapshots/pr.json`
   - **Replay mode**: Loads snapshot, substitutes test ID, returns modified response

4. **Test Cleanup (afterEach)**:
   - `clearSnapshotContext()` resets state

## Migration Strategy

**Phase 1: Create infrastructure** (this PR)

1. Create all 6 new files
2. Modify `tests/helpers/local-repo.ts` (1 line)
3. No changes to existing test files yet
4. Infrastructure is additive - no breaking changes

**Phase 2: Write initial snapshot tests** (next PR)

1. Create example test using composition pattern
2. Record snapshots: `GITHUB_INTEGRATION_TESTS=1 bun test`
3. Verify replay: `bun test` (fast, uses snapshots)
4. Commit snapshots to repository

**Phase 3: Migrate existing tests incrementally** (future PRs)

1. Update tests to use `getGitHubService()` instead of direct `gh` CLI calls
2. Wrap tests with `withGitHubSnapshots()`
3. Record snapshots for migrated tests
4. Priority: pr-detection, sync, other integration tests

## Verification Steps

### 1. Create Infrastructure

- Implement all 6 new files
- Modify `local-repo.ts` (1 line)
- Run existing tests: `bun test` (should pass, no changes yet)

### 2. Write Example Test

- Create `tests/github/service.snapshot.test.ts`
- Use composition pattern with `withGitHubSnapshots()`
- Initially fails with "Snapshot not found" warning

### 3. Record Snapshots

```bash
GITHUB_INTEGRATION_TESTS=1 bun test tests/github/service.snapshot.test.ts
```

- Real GitHub calls
- Creates `tests/snapshots/service.json`
- Test passes

### 4. Verify Replay Mode

```bash
bun test tests/github/service.snapshot.test.ts
```

- No GitHub calls
- New test IDs generated
- Test IDs substituted in responses
- Test passes, fast (< 1s)

### 5. Verify Offline Replay (no `gh` CLI)

Use `ribbin` to block the `gh` CLI and confirm snapshots work without any GitHub access:

```bash
# Block gh CLI
ribbin activate

# Run snapshot tests — should pass in ~1s with no network
bun test tests/github/service.snapshot.test.ts

# Restore gh CLI
ribbin deactivate
```

This should be done for every new test file that gets snapshot support during Phase 3 migration. It proves the snapshot replay truly uses recorded data and doesn't fall back to `gh`.

### 6. Verify Skip Behavior

- Add new test without recording snapshot
- Run without ENV var
- Test skips with warning (no failure)

### 6. Verify Production

```bash
bun run sync
```

- Real `gh` CLI calls (not snapshots)
- Rate limiting still works
- No user-facing changes

## Critical Implementation Details

### Dynamic Test ID Substitution

**Example:**

```
RECORD (testId: "old-test-af4"):
  Input:  createPR({ head: "feature-old-test-af4" })
  Output: { number: 42, branch: "feature-old-test-af4" }
  Saved:  { testContext: "creates PR", testId: "old-test-af4", ... }

REPLAY (testId: "new-test-x3f"):
  Input:  createPR({ head: "feature-new-test-x3f" })
  Match:  Found snapshot for "creates PR" + createPR
  Substitute: "old-test-af4" → "new-test-x3f" in result
  Return: { number: 42, branch: "feature-new-test-x3f" }
```

### Snapshot Matching Strategy

1. Filter by `testContext` (test name)
2. Filter by `method` name
3. If multiple candidates, match by args (normalize test IDs)
4. Return first match

### Missing Snapshots

When snapshot not found in replay mode:

1. Throw `SnapshotNotFoundError`
2. Test wrapper catches it
3. Logs warning: `⊘ Skipped: test name - snapshot not available`
4. Test passes (not fails)

## Design Decisions Summary

1. **Snapshot file organization**: Per-module files (e.g., `tests/snapshots/pr.json`)
2. **Snapshot matching**: Test context + method name (inspired by story tests)
3. **Test ID handling**: Dynamic substitution with recorded inputs
4. **Non-deterministic data**: Record as-is, substitute only test IDs
5. **Snapshot updates**: Manual re-recording with `GITHUB_INTEGRATION_TESTS=1`
6. **Missing snapshots**: Skip tests gracefully instead of failing
7. **Composability**: Use `withGitHubSnapshots()` to add snapshot support to any test suite
8. **Unique IDs**: Use existing `repoManager({github:true}).uniqueId` (don't create duplicate system)

## Key Files Reference

| File                                | Purpose                                               |
| ----------------------------------- | ----------------------------------------------------- |
| **NEW Service Layer**               |                                                       |
| `src/github/service.ts`             | Interface + DI (getGitHubService, setGitHubService)   |
| `src/github/service.default.ts`     | Real implementation (delegates to existing functions) |
| `src/github/service.snapshot.ts`    | Record/replay with test ID substitution               |
| `src/github/service.mock.ts`        | Simple mocks for unit tests                           |
| `src/github/snapshot-context.ts`    | Global test context registry                          |
| **NEW Test Helpers**                |                                                       |
| `tests/helpers/snapshot-compose.ts` | Composition function (withGitHubSnapshots)            |
| **MODIFIED**                        |                                                       |
| `tests/helpers/local-repo.ts`       | Add registerRepoContext call in beforeEach (1 line)   |
| **Existing (Reference)**            |                                                       |
| `tests/helpers/story-test.ts`       | Composes with snapshot via withGitHubSnapshots        |
| `tests/helpers/unique-id.ts`        | Source of repos.uniqueId                              |
| `src/github/pr.ts`                  | Existing PR operations (to be wrapped)                |
| `src/github/api.ts`                 | Contains getGitHubUsername() (to be wrapped)          |
| `src/github/retry.ts`               | Rate limiting (unchanged, used internally)            |

## Success Criteria

- ✅ Tests pass in record mode (with `GITHUB_INTEGRATION_TESTS=1`)
- ✅ Tests pass in replay mode (without env var)
- ✅ Test IDs are different between runs but tests still pass
- ✅ Replay mode is fast (< 1 second per test)
- ✅ Tests without snapshots skip gracefully (no failures)
- ✅ Production commands still work with real GitHub
- ✅ Existing tests continue to pass (no regressions)
