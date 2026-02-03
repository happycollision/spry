# Plan: Wrap GitHub Interactions for Testability

## Goal

Create a `GitHubService` interface that wraps all GitHub operations returning typed data structures. Use module-level dependency injection so tests can swap in mocks while production code continues using the `gh` CLI with existing rate limiting.

## Context

### Current Architecture

All `gh` CLI commands route through `ghExecWithLimit()` in [src/github/retry.ts](src/github/retry.ts) which provides:

- Concurrency limiting (max 5 concurrent calls)
- Exponential backoff retry (3 attempts, 1-30s)
- Rate limit detection

GitHub operations are spread across several files:

- [src/github/pr.ts](src/github/pr.ts) - PR operations (create, view, edit, list, close)
- [src/github/api.ts](src/github/api.ts) - User/auth operations (`getGitHubUsername()`)
- [src/github/branches.ts](src/github/branches.ts) - Branch naming and push operations (uses `getGitHubUsername()`)

### Key Consumers

The largest consumer of GitHub operations is [src/cli/commands/sync.ts](src/cli/commands/sync.ts) which imports from:

- `../../github/api.ts` - username, auth checks
- `../../github/branches.ts` - branch naming, pushing
- `../../github/pr.ts` - PR creation, querying, retargeting
- `../../github/pr-body.ts` - PR body formatting

Other consumers:

- [src/git/pr-detection.ts](src/git/pr-detection.ts) - Finding PRs by branch
- [src/git/stack-settings.ts](src/git/stack-settings.ts) - PR queries
- [src/git/group-titles.ts](src/git/group-titles.ts) - PR body parsing
- [src/cli/commands/group.ts](src/cli/commands/group.ts) - PR operations

### Current Testing Pattern

- `GITHUB_INTEGRATION_TESTS=1` enables real GitHub tests
- `GITHUB_CI_TESTS=1` enables CI-dependent tests
- Tests use repo managers for local git repos
- GitHub tests use a real test repo via [tests/helpers/github-fixture.ts](tests/helpers/github-fixture.ts)
- Scenario-based tests in [src/scenario/](src/scenario/) for complex multi-branch setups

### Recent Changes on Main (since worktree created)

The following features have been merged and may affect this plan:

1. **`sync --all` command** - Syncs all Spry-tracked branches at once. This significantly expanded [src/cli/commands/sync.ts](src/cli/commands/sync.ts), making it the largest consumer of GitHub operations. The service abstraction will help test this complex feature.

2. **Scenario-based testing** - New [src/scenario/](src/scenario/) module provides reusable test scenarios for complex multi-branch setups. Consider using scenarios when testing the mock service.

3. **Branch-aware functions** - Core functions like `injectMissingIds()`, `predictRebaseConflicts()`, `rebaseOntoMain()` now accept optional `branch` parameters. No impact on GitHub service design.

## Design Decisions

1. **Single interface** (`GitHubService`) rather than multiple smaller interfaces - operations share context and are typically mocked together
2. **Module-level singleton with getter/setter** - matches existing patterns (`cachedBranchConfig`), zero changes to existing consumers initially
3. **Default implementation delegates to existing functions** - keeps rate limiting via `ghExecWithLimit()` intact
4. **Env var controls mock vs real** - same pattern as existing tests

## Files to Create

### `src/github/service.ts` - Main interface and DI

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
export function getGitHubService(): GitHubService;
export function setGitHubService(service: GitHubService): void;
export function resetGitHubService(): void;
export function createDefaultGitHubService(): GitHubService;
```

### `src/github/service.mock.ts` - Test helper

```typescript
export function createMockGitHubService(
  overrides: Partial<GitHubService> = {}
): GitHubService;
```

## Files to Modify

### `src/github/pr.ts`

- Re-export service functions for convenience
- No functional changes to existing code

## Environment Variable Control

Following the existing pattern (`GITHUB_INTEGRATION_TESTS`, `GITHUB_CI_TESTS`):

- **No env var** → `getGitHubService()` returns mock service (fast local tests)
- **`GITHUB_INTEGRATION_TESTS=1`** → `getGitHubService()` returns real service

```typescript
// In service.ts
export function getGitHubService(): GitHubService {
  if (!githubService) {
    githubService = process.env.GITHUB_INTEGRATION_TESTS
      ? createDefaultGitHubService()  // Real gh CLI
      : createMockGitHubService();    // Mock with sensible defaults
  }
  return githubService;
}
```

This means:

- `bun test` → runs with mocks (fast, no network)
- `GITHUB_INTEGRATION_TESTS=1 bun test` → runs with real GitHub (existing behavior)
- Tests can still override with `setGitHubService()` for specific scenarios

## Migration Strategy

**Phase 1: Create infrastructure (this PR)**

- Create `service.ts` with interface and default implementation
- Create `service.mock.ts` with mock factory
- No changes to existing consumers

**Phase 2: Migrate consumers incrementally (future PRs)**

- Update modules one at a time to use `getGitHubService()`
- Start with [src/git/pr-detection.ts](src/git/pr-detection.ts) which already has spyOn-based tests
- Then migrate [src/cli/commands/sync.ts](src/cli/commands/sync.ts) - the largest consumer
- Each migration is a small, isolated change
- The `cachedBranchConfig` pattern in [src/github/branches.ts](src/github/branches.ts) is a good model for the DI approach

## Example Test Usage

```typescript
import { setGitHubService } from "../github/service";
import { createMockGitHubService } from "../github/service.mock";

// Most tests just run - they get mock or real based on env var

test("detects PR for branch", async () => {
  // Uses whatever service the env var selected
  const result = await detectPRs(commits);
  expect(result).toBeDefined();
});

// Tests that need specific mock behavior can override
test("handles missing PR gracefully", async () => {
  setGitHubService(createMockGitHubService({
    findPRByBranch: async () => null,  // Force "no PR found" scenario
  }));

  const result = await detectPRs(commits);
  expect(result).toEqual([]);
});
```

## Key Files Reference

| File                                                               | Purpose                                         |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| [src/github/pr.ts](src/github/pr.ts)                               | Existing PR operations to wrap                  |
| [src/github/api.ts](src/github/api.ts)                             | Contains `getGitHubUsername()`                  |
| [src/github/branches.ts](src/github/branches.ts)                   | Branch naming with `cachedBranchConfig` pattern |
| [src/github/retry.ts](src/github/retry.ts)                         | Rate limiting (unchanged, used internally)      |
| [src/cli/commands/sync.ts](src/cli/commands/sync.ts)               | Largest consumer - sync and sync --all          |
| [src/git/pr-detection.ts](src/git/pr-detection.ts)                 | First consumer to migrate                       |
| [tests/helpers/github-fixture.ts](tests/helpers/github-fixture.ts) | Real GitHub test fixture                        |
| [tests/integration/helpers.ts](tests/integration/helpers.ts)       | Test env var definitions                        |
| [src/scenario/](src/scenario/)                                     | Scenario-based test setup for complex cases     |

## Verification

1. Run existing tests to ensure no regressions: `bun test`
2. Create a simple test that uses the mock service
3. Verify the default service works by running `bun run sync` in a real repo
