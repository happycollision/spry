# Phase 2: Validation and Conflict Prediction

**Goal:** Prove we can validate stack structure AND predict conflicts for any branch, without checking it out.

**Status:** Not Started

**Depends on:** Phase 1 (we need to know which branches to check)

---

## Why This Phase?

For `sync --all`, we need to check multiple branches without checking them out. This includes:

1. **Stack validation** - Detect malformed groups (split groups) that would block sync
2. **Conflict prediction** - Detect if rebasing would cause merge conflicts

Both checks must work on non-current branches.

---

## Part A: Stack Validation - `validateBranchStack()`

### Why Validate?

A branch may have a "split group" - commits with the same `Spry-Group` ID that aren't contiguous. This is a structural error that the user must fix before syncing. We should skip such branches with a clear error message.

### Interface

**File:** `src/git/rebase.ts`

```typescript
export interface BranchValidationResult {
  valid: boolean;
  error?: "split-group";
  splitGroupInfo?: {
    groupId: string;
    groupTitle?: string;
    interruptingCommits: string[];
  };
}

/**
 * Validate that a branch's commit stack is structurally valid.
 * Checks for split groups (non-contiguous group commits).
 * Works on any branch, not just the current one.
 */
export async function validateBranchStack(
  branch: string,
  options: GitOptions = {},
): Promise<BranchValidationResult>
```

### Implementation

```typescript
export async function validateBranchStack(
  branch: string,
  options: GitOptions = {},
): Promise<BranchValidationResult> {
  // Get commits for branch (branch-aware)
  const commits = await getStackCommitsWithTrailers({ ...options, branch });

  if (commits.length === 0) {
    return { valid: true };
  }

  // Get group titles
  const groupTitles = await getGroupTitles(options);

  // Use existing parseStack() - it's already branch-agnostic
  const result = parseStack(commits, groupTitles);

  if (result.ok) {
    return { valid: true };
  }

  // result.error === "split-group"
  return {
    valid: false,
    error: "split-group",
    splitGroupInfo: {
      groupId: result.group.id,
      groupTitle: result.group.title,
      interruptingCommits: result.interruptingCommits,
    },
  };
}
```

### Test Cases for Validation

#### Test: Detects split group on non-current branch

**Setup:**

- Use `multiSpryBranches` scenario (includes `feature-split` with split group)
- Stay on a different branch

**Assert:**

- `validateBranchStack("feature-split-...")` returns `valid: false`
- `error` is `"split-group"`
- `splitGroupInfo` contains group ID and interrupting commits

#### Test: Valid branch passes validation

**Setup:**

- Use `multiSpryBranches` scenario
- Check `feature-behind` branch (valid structure)

**Assert:**

- `validateBranchStack("feature-behind-...")` returns `valid: true`

---

## Part B: Conflict Prediction - `predictRebaseConflictsForBranch()`

The existing `predictRebaseConflicts()` only works for the **current branch** (uses `HEAD`). For `sync --all`, we need to check multiple branches without checking them out.

---

## Interface

**File:** `src/git/rebase.ts`

```typescript
/**
 * Check if rebasing a specific branch onto target would cause conflicts.
 * Works on any branch, not just the current one.
 *
 * @param branch - Branch name to check (without refs/heads/)
 * @param onto - Target to rebase onto (e.g., "origin/main")
 * @returns Prediction of whether rebase would succeed
 */
export async function predictRebaseConflictsForBranch(
  branch: string,
  onto: string,
  options: GitOptions = {},
): Promise<RebaseConflictPrediction>
```

Uses existing `RebaseConflictPrediction` type:

```typescript
export interface RebaseConflictPrediction {
  wouldSucceed: boolean;
  commitCount: number;
  conflictInfo?: {
    commitHash: string;
    files: string[];
  };
}
```

---

## Prerequisite

**Export `parseConflictOutput` from `src/git/conflict-predict.ts`:**

The function already exists but is not exported. Add `export` to the function declaration:

```typescript
// Change from:
function parseConflictOutput(output: string): { files: string[]; lines: string[] }

// To:
export function parseConflictOutput(output: string): { files: string[]; lines: string[] }
```

---

## Implementation Approach

### Key Insight

The existing `predictRebaseConflicts()` does:

1. Get commits between `HEAD` and `origin/main`
2. Call `rebasePlumbing(onto, commitHashes)` to test

We need to change step 1 to work with any branch:

1. Get commits between `branch` and `onto`
2. Call `rebasePlumbing(onto, commitHashes)` to test

**Important:** Use the existing `parseConflictOutput()` from `conflict-predict.ts` to properly parse merge-tree output instead of naive line splitting.

### Implementation

```typescript
import { parseConflictOutput } from "./conflict-predict.ts";

export async function predictRebaseConflictsForBranch(
  branch: string,
  onto: string,
  options: GitOptions = {},
): Promise<RebaseConflictPrediction> {
  const { cwd } = options;

  // Get commits between onto and branch (oldest first)
  const logResult = cwd
    ? await $`git -C ${cwd} log --reverse --format=%H ${onto}..${branch}`.text()
    : await $`git log --reverse --format=%H ${onto}..${branch}`.text();

  const commitHashes = logResult.trim().split("\n").filter(Boolean);
  const commitCount = commitHashes.length;

  if (commitCount === 0) {
    return { wouldSucceed: true, commitCount: 0 };
  }

  // Get the target SHA
  const ontoSha = await getFullSha(onto, options);

  // Test rebase with plumbing (creates orphan commits on success, no side effects)
  const result = await rebasePlumbing(ontoSha, commitHashes, options);

  if (result.ok) {
    return { wouldSucceed: true, commitCount };
  }

  // Use parseConflictOutput to properly extract conflict files from merge-tree output
  const { files } = parseConflictOutput(result.conflictInfo ?? "");

  return {
    wouldSucceed: false,
    commitCount,
    conflictInfo: {
      commitHash: result.conflictCommit,
      files,
    },
  };
}
```

---

## Test Cases

### Test 1: Predicts success for non-conflicting branch

**Setup:**

- Use `multiSpryBranches` scenario
- Check `feature-behind` branch

**Assert:**

- `wouldSucceed: true`
- `commitCount > 0`

### Test 2: Predicts conflict for conflicting branch

**Setup:**

- Use `multiSpryBranches` scenario
- Check `feature-conflict` branch

**Assert:**

- `wouldSucceed: false`
- `conflictInfo.files` contains `"conflict.txt"`

### Test 3: Returns up-to-date for branch on origin/main

**Setup:**

- Use `multiSpryBranches` scenario
- Check `feature-uptodate` branch (after fetching, it should be at same point)

Actually, `feature-uptodate` was created before the origin update, so it will be behind. Let me adjust the scenario or test:

**Adjusted Setup:**

- Create a branch, fetch, no new commits since fetch

**Assert:**

- `commitCount: 0` or branch tip equals onto

### Test 4: Works without checking out the branch

**Setup:**

- Create repo with two Spry branches
- Stay on branch A
- Check prediction for branch B

**Assert:**

- Function returns correct result for branch B
- Current branch is still A (not changed)

---

## Test File Addition

**File:** `tests/integration/sync-all.test.ts`

```typescript
describe("sync --all: Phase 2 - validateBranchStack", () => {
  const repos = repoManager();

  test("detects split group on non-current branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await validateBranchStack(
      `feature-split-${repo.uniqueId}`,
      { cwd: repo.path },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("split-group");
    expect(result.splitGroupInfo?.groupId).toBe("groupA");
    expect(result.splitGroupInfo?.interruptingCommits.length).toBeGreaterThan(0);
  });

  test("valid branch passes validation", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await validateBranchStack(
      `feature-behind-${repo.uniqueId}`,
      { cwd: repo.path },
    );

    expect(result.valid).toBe(true);
  });

  test("does not change current branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const branchBefore = await repo.currentBranch();

    await validateBranchStack(
      `feature-split-${repo.uniqueId}`,
      { cwd: repo.path },
    );

    const branchAfter = await repo.currentBranch();
    expect(branchAfter).toBe(branchBefore);
  });
});

describe("sync --all: Phase 2 - predictRebaseConflictsForBranch", () => {
  const repos = repoManager();

  test("predicts success for non-conflicting branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const prediction = await predictRebaseConflictsForBranch(
      `feature-behind-${repo.uniqueId}`,
      "origin/main",
      { cwd: repo.path },
    );

    expect(prediction.wouldSucceed).toBe(true);
    expect(prediction.commitCount).toBeGreaterThan(0);
  });

  test("predicts conflict for conflicting branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const prediction = await predictRebaseConflictsForBranch(
      `feature-conflict-${repo.uniqueId}`,
      "origin/main",
      { cwd: repo.path },
    );

    expect(prediction.wouldSucceed).toBe(false);
    expect(prediction.conflictInfo?.files).toContain("conflict.txt");
  });

  test("does not change current branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const branchBefore = await repo.currentBranch();

    await predictRebaseConflictsForBranch(
      `feature-conflict-${repo.uniqueId}`,
      "origin/main",
      { cwd: repo.path },
    );

    const branchAfter = await repo.currentBranch();
    expect(branchAfter).toBe(branchBefore);
  });
});
```

---

## Definition of Done

- [ ] `validateBranchStack()` function implemented in `src/git/rebase.ts`
- [ ] `predictRebaseConflictsForBranch()` function implemented in `src/git/rebase.ts`
- [ ] All Phase 2 tests pass
- [ ] `validateBranchStack()` correctly detects split groups without checkout
- [ ] `predictRebaseConflictsForBranch()` correctly predicts conflicts without checkout
- [ ] Neither function modifies current branch or working directory

---

## Next Phase

Once this phase is complete, proceed to [SUB_PLAN_PHASE_3.md](./SUB_PLAN_PHASE_3.md) - Plumbing Rebase.
