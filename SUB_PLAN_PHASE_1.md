# Phase 1: Discovering Spry Branches - `listSpryLocalBranches()`

**Goal:** Prove we can identify which local branches are Spry-tracked.

**Status:** Not Started

---

## What Makes a Branch "Spry-Tracked"?

A local branch is Spry-tracked if it has **at least one commit** between the branch tip and `origin/main` that contains a `Spry-Commit-Id` trailer.

Non-Spry branches:

- Branches with no commits above origin/main
- Branches where no commits have Spry-Commit-Id trailers

---

## Interface

**File:** `src/git/commands.ts`

```typescript
export interface SpryBranchInfo {
  /** Branch name (without refs/heads/) */
  name: string;
  /** Branch tip SHA */
  tipSha: string;
  /** Number of commits in stack (between branch and origin/main) */
  commitCount: number;
  /** Whether branch is checked out in a worktree */
  inWorktree: boolean;
  /** Path to worktree if checked out */
  worktreePath?: string;
}

/**
 * List all local branches that have Spry-tracked commits.
 * A branch is Spry-tracked if it has commits with Spry-Commit-Id trailers
 * between the branch tip and origin/main.
 */
export async function listSpryLocalBranches(
  options: GitOptions = {},
): Promise<SpryBranchInfo[]>
```

---

## Implementation Approach

### Step 1: Get all local branches

```bash
git for-each-ref --format='%(refname:short) %(objectname)' refs/heads/
```

Output:

```
feature-auth abc123...
feature-api def456...
main 789xyz...
```

### Step 2: Get default branch ref

Use existing `getDefaultBranchRef()` to get `origin/main` or equivalent.

### Step 3: For each branch (excluding default branch):

1. Check if branch is ahead of default:

   ```bash
   git rev-list --count origin/main..branch
   ```

   If 0, skip (no commits to check).

2. Check for Spry-Commit-Id trailers:

   ```bash
   git log --format=%B origin/main..branch | grep -q "Spry-Commit-Id:"
   ```

   Or more efficiently, get all commits and check trailers.

3. If has Spry commits, check worktree status:
   ```typescript
   const worktreeInfo = await getBranchWorktree(branch, options);
   ```

### Step 4: Return list

---

## Test Cases

### Test 1: Identifies Spry-tracked branches

**Setup:**

- Create `feature-spry` branch with Spry commits
- Create `feature-plain` branch without Spry commits

**Assert:**

- `listSpryLocalBranches()` returns only `feature-spry`

### Test 2: Excludes main branch

**Setup:**

- Repo with main and one Spry branch

**Assert:**

- Main is not in the result list

### Test 3: Handles branches with no commits above main

**Setup:**

- Create branch at same commit as main

**Assert:**

- Branch not in result (commitCount would be 0)

### Test 4: Detects branches in worktrees

**Setup:**

- Create Spry branch
- Create worktree for it

**Assert:**

- Branch in result with `inWorktree: true` and `worktreePath` set

### Test 5: Returns commit count correctly

**Setup:**

- Create Spry branch with 3 commits

**Assert:**

- `commitCount: 3` in result

---

## Scenario to Add

**Name:** `multiSpryBranches`

**Location:** `src/scenario/definitions.ts`

```typescript
/**
 * Multiple branches, some Spry-tracked, some not.
 * For testing listSpryLocalBranches().
 */
multiSpryBranches: {
  name: "multi-spry-branches",
  description: "Multiple branches for sync --all testing",
  repoType: "local",
  setup: async (repo: ScenarioRepo) => {
    if (!hasUpdateOriginMain(repo)) {
      throw new Error("multiSpryBranches requires updateOriginMain method");
    }

    // Branch 1: Spry-tracked, up-to-date with origin/main
    await repo.branch("feature-uptodate");
    await repo.commit({
      message: "Feature uptodate commit",
      trailers: { "Spry-Commit-Id": "upto0001" },
    });

    // Go back to main for next branch
    await repo.checkout(repo.defaultBranch);

    // Branch 2: Spry-tracked, will be behind after origin update
    await repo.branch("feature-behind");
    await repo.commit({
      message: "Feature behind commit",
      trailers: { "Spry-Commit-Id": "bhnd0001" },
    });

    await repo.checkout(repo.defaultBranch);

    // Branch 3: Spry-tracked, will conflict
    await repo.branch("feature-conflict");
    await repo.commitFiles(
      { "conflict.txt": "Feature content\n" },
      {
        message: "Feature conflict commit",
        trailers: { "Spry-Commit-Id": "cnfl0001" },
      },
    );

    await repo.checkout(repo.defaultBranch);

    // Branch 4: NOT Spry-tracked (no trailer)
    await repo.branch("feature-nospy");
    await repo.commit({ message: "Plain commit without Spry-Commit-Id" });

    // Update origin/main with conflicting content
    await repo.updateOriginMain("Upstream change", {
      "conflict.txt": "Main content\n",
    });
    await repo.fetch();

    // End on feature-behind as the "current" branch
    await repo.checkout("feature-behind-" + repo.uniqueId);
  },
}
```

---

## Test File

**File:** `tests/integration/sync-all.test.ts`

```typescript
import { test, expect, describe } from "bun:test";
import { repoManager } from "../helpers/local-repo.ts";
import { listSpryLocalBranches } from "../../src/git/commands.ts";
import { scenarios } from "../../src/scenario/definitions.ts";

describe("sync --all: Phase 1 - listSpryLocalBranches", () => {
  const repos = repoManager();

  test("identifies Spry-tracked branches", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const branches = await listSpryLocalBranches({ cwd: repo.path });
    const names = branches.map(b => b.name);

    // Should include Spry branches
    expect(names).toContain(expect.stringContaining("feature-uptodate"));
    expect(names).toContain(expect.stringContaining("feature-behind"));
    expect(names).toContain(expect.stringContaining("feature-conflict"));

    // Should NOT include non-Spry branch
    expect(names).not.toContain(expect.stringContaining("feature-nospy"));

    // Should NOT include main
    expect(names).not.toContain("main");
  });

  test("returns correct commit counts", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const branches = await listSpryLocalBranches({ cwd: repo.path });

    for (const branch of branches) {
      expect(branch.commitCount).toBeGreaterThan(0);
      expect(branch.tipSha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("detects branches in worktrees", async () => {
    const repo = await repos.create();

    // Create a Spry branch
    const branchName = await repo.branch("feature-wt");
    await repo.commit({
      message: "Worktree commit",
      trailers: { "Spry-Commit-Id": "wt000001" },
    });

    // Go back to main and create worktree
    await repo.checkout("main");
    const worktree = await repo.createWorktree(branchName);

    const branches = await listSpryLocalBranches({ cwd: repo.path });
    const wtBranch = branches.find(b => b.name === branchName);

    expect(wtBranch).toBeDefined();
    expect(wtBranch!.inWorktree).toBe(true);
    expect(wtBranch!.worktreePath).toBe(worktree.path);
  });
});
```

---

## Definition of Done

- [ ] `listSpryLocalBranches()` function implemented in `src/git/commands.ts`
- [ ] `multiSpryBranches` scenario added to `src/scenario/definitions.ts`
- [ ] All Phase 1 tests pass
- [ ] Function correctly identifies Spry vs non-Spry branches
- [ ] Function correctly detects worktree status

---

## Next Phase

Once this phase is complete, proceed to [SUB_PLAN_PHASE_2.md](./SUB_PLAN_PHASE_2.md) - Conflict Prediction.
