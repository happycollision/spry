# Phase 1: Foundation + CLI Stub

**Goal:** Add `--all` flag with stub implementation, implement branch discovery, create test scenario. Enable end-to-end testing of branch discovery immediately.

**Status:** ✅ Complete

---

## What This Phase Delivers

1. `--all` flag added to CLI with mutual exclusivity checks
2. `listSpryLocalBranches()` function to discover Spry-tracked branches
3. Stub `syncAllCommand()` that reports discovered branches
4. `multiSpryBranches` test scenario
5. End-to-end tests validating branch discovery works

After this phase, `sp sync --all` will show discovered branches (all skipped as "not yet implemented"), proving the discovery logic works.

**Note:** The current branch IS included in `--all` - it should be synced like any other branch.

---

## Part A: Add `--all` Flag to CLI

**File:** `src/cli/index.ts`

```typescript
program
  .command("sync")
  .description("Sync stack with GitHub: add IDs, push branches, and optionally create PRs")
  .option("--open", "Create PRs for branches that don't have them")
  .option("--all", "Sync all Spry-tracked branches in the repository")  // NEW
  .option(
    "--apply <json>",
    "Only open PRs for specified commits/groups (JSON array of identifiers)",
  )
  .option("--up-to <id>", "Only open PRs for commits/groups up to and including this identifier")
  .option("-i, --interactive", "Interactively select which commits/groups to open PRs for")
  .option(
    "--allow-untitled-pr",
    "Allow creating PRs for groups without stored titles (uses first commit subject)",
  )
  .action((options) => syncCommand(options));
```

---

## Part B: Mutual Exclusivity Check

**File:** `src/cli/commands/sync.ts`

Add at the start of `syncCommand()`:

```typescript
export interface SyncOptions {
  open?: boolean;
  apply?: string;
  upTo?: string;
  interactive?: boolean;
  allowUntitledPr?: boolean;
  all?: boolean;  // NEW
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  // Check mutual exclusivity first
  if (options.all && options.open) {
    console.error("✗ Error: --all and --open are mutually exclusive");
    console.error("  Run 'sp sync --all' first, then 'sp sync --open' on each branch");
    process.exit(1);
  }

  if (options.all) {
    if (options.apply || options.upTo || options.interactive) {
      console.error("✗ Error: --all cannot be used with --apply, --up-to, or --interactive");
      process.exit(1);
    }

    await syncAllCommand(options);
    return;
  }

  // ... existing sync logic ...
}
```

---

## Part C: Implement `listSpryLocalBranches()`

**File:** `src/git/commands.ts`

### Interface

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
  /** Whether any commits in stack are missing Spry-Commit-Id (needs ID injection) */
  hasMissingIds: boolean;
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

### What Makes a Branch "Spry-Tracked"?

A local branch is Spry-tracked if it has **at least one commit** between the branch tip and `origin/main` that contains a `Spry-Commit-Id` trailer.

Non-Spry branches:

- Branches with no commits above origin/main
- Branches where no commits have Spry-Commit-Id trailers

### Implementation Approach

#### Step 1: Get all local branches

```bash
git for-each-ref --format='%(refname:short) %(objectname)' refs/heads/
```

#### Step 2: Get default branch ref

Use existing `getDefaultBranchRef()` to get `origin/main` or equivalent.

#### Step 3: For each branch (excluding default branch):

1. Check if branch is ahead of default:

   ```bash
   git rev-list --count origin/main..branch
   ```

   If 0, skip (no commits to check).

2. Check for Spry-Commit-Id trailers in commits

3. If has Spry commits, check worktree status:

   ```typescript
   const worktreeInfo = await getBranchWorktree(branch, options);
   ```

4. Check if any commits are missing IDs (for `hasMissingIds`)

#### Step 4: Return list

---

## Part D: Stub `syncAllCommand()`

**File:** `src/cli/commands/sync.ts`

```typescript
export interface SyncAllResult {
  rebased: Array<{
    branch: string;
    commitCount: number;
    wasInWorktree: boolean;
  }>;
  skipped: Array<{
    branch: string;
    reason: "up-to-date" | "conflict" | "dirty-worktree" | "split-group";
    conflictFiles?: string[];
    splitGroupInfo?: { groupId: string; groupTitle?: string };
  }>;
}

/**
 * Sync all Spry-tracked branches in the repository.
 * Phase 1: Stub implementation that discovers and reports branches.
 */
export async function syncAllCommand(options: SyncOptions = {}): Promise<SyncAllResult> {
  // Fetch from remote to get latest state
  await fetchRemote();

  const currentBranch = await getCurrentBranch();
  const target = await getDefaultBranchRef();
  const spryBranches = await listSpryLocalBranches(options);

  if (spryBranches.length === 0) {
    console.log("No Spry-tracked branches found.");
    return { rebased: [], skipped: [] };
  }

  console.log(`Found ${spryBranches.length} Spry branch(es):\n`);

  const skipped: SyncAllResult["skipped"] = [];

  for (const branch of spryBranches) {
    // Phase 1: Report all branches as not-yet-implemented (including current branch)
    console.log(`⊘ ${branch.name}: skipped (sync not yet implemented)`);
    // Use a temporary reason for the stub
    skipped.push({ branch: branch.name, reason: "up-to-date" }); // placeholder
  }

  console.log(`\nSkipped: ${skipped.length} branch(es)`);
  return { rebased: [], skipped };
}
```

---

## Part E: Test Scenario - `multiSpryBranches`

**File:** `src/scenario/definitions.ts`

```typescript
/**
 * Multiple branches, some Spry-tracked, some not.
 * For testing listSpryLocalBranches() and sync --all.
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
    await repo.branch("feature-nospry");
    await repo.commit({ message: "Plain commit without Spry-Commit-Id" });

    await repo.checkout(repo.defaultBranch);

    // Branch 5: Spry-tracked but has commits missing IDs (mixed)
    await repo.branch("feature-mixed");
    await repo.commit({
      message: "Commit with ID",
      trailers: { "Spry-Commit-Id": "mix00001" },
    });
    await repo.commit({ message: "Commit without ID" }); // No Spry-Commit-Id!

    await repo.checkout(repo.defaultBranch);

    // Branch 6: Spry-tracked but has split group (malformed)
    await repo.branch("feature-split");
    await repo.commit({
      message: "Group A part 1",
      trailers: { "Spry-Commit-Id": "splt0001", "Spry-Group": "groupA" },
    });
    await repo.commit({
      message: "Interrupting commit",
      trailers: { "Spry-Commit-Id": "splt0002" },
    });
    await repo.commit({
      message: "Group A part 2",
      trailers: { "Spry-Commit-Id": "splt0003", "Spry-Group": "groupA" },
    });

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

## Test Cases

**File:** `tests/integration/sync-all.test.ts`

### Test 1: Discovers Spry branches, excludes non-Spry

```typescript
test("--all discovers Spry branches and excludes non-Spry", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const result = await runSpry(repo.path, "sync", ["--all"]);

  expect(result.exitCode).toBe(0);
  // Should include Spry branches
  expect(result.stdout).toContain("feature-behind");
  expect(result.stdout).toContain("feature-conflict");
  expect(result.stdout).toContain("feature-mixed");
  expect(result.stdout).toContain("feature-split");
  // Should NOT include non-Spry branch
  expect(result.stdout).not.toContain("feature-nospry");
});
```

### Test 2: Includes current branch

```typescript
test("--all includes current branch", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const result = await runSpry(repo.path, "sync", ["--all"]);

  // Current branch (feature-behind) should be included, not skipped
  expect(result.stdout).toContain("feature-behind");
  // Should NOT say "current branch - run 'sp sync' without --all"
  expect(result.stdout).not.toContain("run 'sp sync' without --all");
});
```

### Test 3: --all and --open are mutually exclusive

```typescript
test("--all and --open are mutually exclusive", async () => {
  const repo = await repos.create();
  const result = await runSpry(repo.path, "sync", ["--all", "--open"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("mutually exclusive");
});
```

### Test 4: --all incompatible with --apply

```typescript
test("--all is incompatible with --apply", async () => {
  const repo = await repos.create();
  const result = await runSpry(repo.path, "sync", ["--all", "--apply", '["abc"]']);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("cannot be used with");
});
```

### Test 5: Help shows --all option

```typescript
test("help shows --all option", async () => {
  const repo = await repos.create();
  const result = await runSpry(repo.path, "sync", ["--help"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--all");
});
```

### Test 6: listSpryLocalBranches detects hasMissingIds

```typescript
test("listSpryLocalBranches detects hasMissingIds", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const branches = await listSpryLocalBranches({ cwd: repo.path });

  const mixedBranch = branches.find(b => b.name.includes("feature-mixed"));
  expect(mixedBranch).toBeDefined();
  expect(mixedBranch!.hasMissingIds).toBe(true);

  const behindBranch = branches.find(b => b.name.includes("feature-behind"));
  expect(behindBranch).toBeDefined();
  expect(behindBranch!.hasMissingIds).toBe(false);
});
```

---

## Definition of Done

- [x] `--all` flag added to CLI in `src/cli/index.ts`
- [x] Mutual exclusivity checks in `syncCommand()` for `--all` vs `--open`, `--apply`, etc.
- [x] `listSpryLocalBranches()` function implemented in `src/git/commands.ts`
- [x] `syncAllCommand()` implemented in `src/cli/commands/sync.ts`
- [x] `multiSpryBranches` scenario added to `src/scenario/definitions.ts`
- [x] All Phase 1 tests pass
- [x] `sp sync --all` shows discovered Spry branches (non-Spry branches excluded)
- [x] Current branch is included in `--all` (not skipped)
- [x] **Addendum:** Current branch is actually synced (rebase, ID injection, conflict prediction)
- [x] **Addendum:** Test verifies actual sync occurs (not just inclusion)
- [x] Full CI test run passes: `bun run test:docker`

---

## Addendum: Current Branch Sync ✅ COMPLETE

The current branch is now synced like any other branch when using `--all`. The implementation:

1. **Detects current branch** in `syncAllCommand()` using `getCurrentBranch()`
2. **Calls `syncCurrentBranchForAll()`** helper that reuses existing sync logic:
   - Checks for ongoing rebase conflicts
   - Checks for clean working tree (uncommitted changes)
   - Fast-forwards local main if behind
   - Predicts rebase conflicts before rebasing
   - Rebases if behind main and no conflicts
   - Injects missing IDs after rebase
3. **Reports results** using the same format as other branches with "(current branch)" suffix

**Key insight:** No branch-aware functions needed for current branch - the existing functions already work on HEAD.

**Files modified:**

- `src/cli/commands/sync.ts` - Added `syncCurrentBranchForAll()` helper
- `tests/integration/sync-all.test.ts` - Updated test to verify actual sync occurs

**Output format:**

```
✓ feature-behind: rebased 1 commit(s) onto origin/main (current branch)
```

---

## Next Phase

Once this phase is complete, proceed to [SUB_PLAN_PHASE_2.md](./SUB_PLAN_PHASE_2.md) - Branch-Aware Core Functions.
