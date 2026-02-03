# Testing Infrastructure for `sp sync --all`

This document explains how testing works in Spry and what test scenarios support the `sync --all` feature.

## Testing Philosophy

We use **TDD at the integration/story test level**. This means:

1. Write integration tests first that describe the desired behavior
2. Implement code to make the tests pass
3. Use story logging to generate human-readable documentation

## Test Infrastructure Overview

### Key Files

| File                           | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `tests/helpers/local-repo.ts`  | `repoManager()` - creates test repos with automatic cleanup             |
| `src/scenario/core.ts`         | `LocalRepo` interface and `createLocalRepo()` - low-level repo creation |
| `src/scenario/definitions.ts`  | Pre-built scenarios for common test setups                              |
| `tests/helpers/story-test.ts`  | `createStoryTest()` - test wrapper with documentation generation        |
| `tests/helpers/story.ts`       | Low-level story logging API                                             |
| `tests/integration/helpers.ts` | `runSync()`, `runSpry()` - CLI execution helpers                        |

### The `repoManager()` Pattern

```typescript
import { repoManager } from "../helpers/local-repo.ts";

describe("my feature", () => {
  const repos = repoManager();  // Auto-registers cleanup hooks

  test("does something", async () => {
    const repo = await repos.create();  // Creates repo with bare origin
    await repo.branch("feature");
    await repo.commit({ message: "Add feature" });
    // repo.cleanup() is automatic via afterEach
  });
});
```

### The `LocalRepo` Interface

A `LocalRepo` provides:

- `path` - Path to the working repository
- `originPath` - Path to the bare "origin" repository
- `uniqueId` - Unique identifier for this test run (used in branch names)
- `commit(options?)` - Create a commit with auto-generated file
- `commitFiles(files, options?)` - Create a commit with specific files
- `branch(name)` - Create and checkout a new branch (auto-suffixed with uniqueId)
- `checkout(name)` - Checkout an existing branch
- `fetch()` - Fetch from origin
- `currentBranch()` - Get current branch name
- `updateOriginMain(message, files?)` - Simulate upstream changes on main
- `createWorktree(branch, path?)` - Create a worktree for a branch
- `listWorktrees()` - List all worktrees
- `removeWorktree(path)` - Remove a worktree
- `cleanup()` - Clean up all directories

### Story Testing

Story tests generate documentation during test runs:

```typescript
import { createStoryTest } from "../helpers/story-test.ts";

const { test: storyTest } = createStoryTest("sync-all.test.ts");

storyTest("Syncs multiple branches", async (story) => {
  story.strip(repos.uniqueId);  // Sanitize dynamic IDs
  story.narrate("When multiple Spry branches exist, sync --all rebases them all.");

  const result = await runSync(repo.path, { all: true });
  story.log(result);  // Captures command output for docs

  expect(result.exitCode).toBe(0);
});
```

Enable story logging with: `SPRY_STORY_TEST_LOGGING=1 bun test`

### Scenarios

Pre-built scenarios in `src/scenario/definitions.ts`:

```typescript
import { scenarios } from "../../src/scenario/definitions.ts";

test("my test", async () => {
  const repo = await repos.create();
  await scenarios.withSpryIds.setup(repo);
  // repo now has 5 commits with Spry-Commit-Id trailers
});
```

---

## New Scenario: `multiSpryBranches`

For `sync --all`, we need a scenario with multiple branches in various states:

### Scenario Definition

**Location:** `src/scenario/definitions.ts`

```typescript
/**
 * Multiple Spry-tracked branches for testing sync --all.
 *
 * Creates:
 * - feature-uptodate: Spry branch, already on origin/main
 * - feature-behind: Spry branch, needs rebase (no conflict)
 * - feature-conflict: Spry branch, would conflict on rebase
 * - feature-nospry: Non-Spry branch (no Spry-Commit-Id trailers)
 * - feature-mixed: Spry branch with some commits missing IDs
 * - feature-split: Spry branch with split group (malformed)
 *
 * Leaves repo on feature-behind branch.
 * REQUIRES: LocalRepo (uses updateOriginMain)
 */
multiSpryBranches: {
  name: "multi-spry-branches",
  description: "Multiple Spry branches for sync --all testing",
  repoType: "local",
  setup: async (repo: ScenarioRepo) => { /* ... */ }
}
```

### Branch States Created

| Branch             | Spry-Tracked | State                   | Expected Sync Result               |
| ------------------ | ------------ | ----------------------- | ---------------------------------- |
| `feature-uptodate` | Yes          | On origin/main          | Skip (up-to-date)                  |
| `feature-behind`   | Yes          | Behind origin/main      | Rebase succeeds                    |
| `feature-conflict` | Yes          | Behind, conflicts       | Skip (conflict)                    |
| `feature-nospry`   | No           | Behind origin/main      | Not processed                      |
| `feature-mixed`    | Yes          | Has commits missing IDs | IDs injected, then rebase succeeds |
| `feature-split`    | Yes          | Has split group         | Skip (split-group)                 |

### Setup Sequence

1. Create `feature-uptodate` branch from main
2. Add Spry commit, stay on origin/main
3. Create `feature-behind` branch from main
4. Add Spry commit
5. Create `feature-conflict` branch from main
6. Add Spry commit that modifies `conflict.txt`
7. Create `feature-nospry` branch from main
8. Add commit WITHOUT Spry-Commit-Id
9. Create `feature-mixed` branch from main
10. Add Spry commit WITH ID, then add commit WITHOUT ID (mixed)
11. Create `feature-split` branch from main
12. Add commit in group A, add interrupting commit, add another commit in group A (split)
13. Update origin/main with change to `conflict.txt`
14. Fetch to update origin/main ref
15. Checkout `feature-behind` as the "current" branch

---

## Worktree Scenario: `multiSpryBranchesWithWorktrees`

For testing worktree behavior:

### Additional States

| Branch             | Location | Working Dir State | Expected Sync Result        |
| ------------------ | -------- | ----------------- | --------------------------- |
| `feature-wt-clean` | Worktree | Clean             | Rebase + update working dir |
| `feature-wt-dirty` | Worktree | Dirty             | Skip (dirty-worktree)       |

---

## Test File Structure

**File:** `tests/integration/sync-all.test.ts`

```typescript
describe("sync --all: local behavior", () => {
  // Phase 1 tests: listSpryLocalBranches + CLI stub
  test("identifies Spry-tracked branches");
  test("excludes non-Spry branches");
  test("detects branches in worktrees");
  test("detects branches with missing Spry-Commit-Ids (hasMissingIds)");
  test("--all flag works");
  test("--all and --open are mutually exclusive");
  test("--all is incompatible with --apply");

  // Phase 2 tests: branch-aware APIs
  test("getStackCommitsWithTrailers works on non-current branch");
  test("injectMissingIds works on non-current branch");
  test("predicts conflicts for specific branch");
  test("detects up-to-date branches");

  // Phase 3 tests: stack validation
  test("validateBranchStack detects split groups");
  test("validateBranchStack passes valid branches");
  test("validateBranchStack does not change current branch");

  // Phase 4 tests: full orchestration
  test("syncs all Spry branches");
  test("skips current branch");
  test("reports results correctly");
  test("injects missing IDs before rebasing (mixed commits)");
  test("skips branch with split group");
  test("rebases branch not in worktree");
  test("rebases branch in clean worktree");
  test("skips branch in dirty worktree");
});
```

---

## Running Tests

```bash
# Run all tests (requires Git 2.40+ or use docker)
bun run test:docker

# Run specific test file
bun run test:docker tests/integration/sync-all.test.ts

# Run with story logging
SPRY_STORY_TEST_LOGGING=1 bun run test:docker

# Run GitHub integration tests (requires GITHUB_INTEGRATION_TESTS=1)
GITHUB_INTEGRATION_TESTS=1 bun run test:github
```

---

## Implementation Phases

Each phase has its own sub-plan document:

1. **[SUB_PLAN_PHASE_1.md](./SUB_PLAN_PHASE_1.md)** - Foundation + CLI Stub: `listSpryLocalBranches()`, `--all` flag, test scenario
2. **[SUB_PLAN_PHASE_2.md](./SUB_PLAN_PHASE_2.md)** - Branch-Aware Core Functions: Add `branch` param to existing functions, result types
3. **[SUB_PLAN_PHASE_3.md](./SUB_PLAN_PHASE_3.md)** - Stack Validation: `validateBranchStack()` for split group detection
4. **[SUB_PLAN_PHASE_4.md](./SUB_PLAN_PHASE_4.md)** - Full Orchestration: Complete `syncAllCommand()` with rebase

Each phase builds on the previous and proves a specific capability works before moving on.
