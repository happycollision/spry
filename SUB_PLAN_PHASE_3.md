# Phase 3: Stack Validation

**Goal:** Implement `validateBranchStack()` to detect malformed groups (split groups) on any branch. Update `syncAllCommand()` to skip branches with invalid stacks.

**Status:** Not Started

**Depends on:** Phase 2

---

## Why This Phase?

A branch may have a "split group" - commits with the same `Spry-Group` ID that aren't contiguous. This is a structural error that the user must fix before syncing. We should skip such branches with a clear error message rather than attempting to sync them.

Example of a split group:

```
commit 3: Group A part 2    <- Spry-Group: groupA
commit 2: Interrupting commit  <- No group (splits the group!)
commit 1: Group A part 1    <- Spry-Group: groupA
```

---

## Part A: Implement `validateBranchStack()`

**File:** `src/git/rebase.ts`

### Interface

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

  // Get group titles for display
  const groupTitles = await readGroupTitles(options);

  // Use existing parseStack() - it's already branch-agnostic and detects split groups
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

**Note:** The heavy lifting is done by `parseStack()` which already exists and validates group contiguity. This function is a convenience wrapper that makes it work on any branch.

---

## Part B: Update `syncAllCommand()` to Validate Stacks

**File:** `src/cli/commands/sync.ts`

Add validation step after up-to-date and dirty-worktree checks:

```typescript
export async function syncAllCommand(options: SyncOptions = {}): Promise<SyncAllResult> {
  await fetchRemote();

  const currentBranch = await getCurrentBranch();
  const target = await getDefaultBranchRef();
  const spryBranches = await listSpryLocalBranches(options);

  if (spryBranches.length === 0) {
    console.log("No Spry-tracked branches found.");
    return { rebased: [], skipped: [] };
  }

  console.log(`Syncing ${spryBranches.length} Spry branch(es)...\n`);

  const rebased: SyncAllResult["rebased"] = [];
  const skipped: SyncAllResult["skipped"] = [];

  for (const branch of spryBranches) {
    // Skip current branch
    if (branch.name === currentBranch) {
      console.log(`⊘ ${branch.name}: skipped (current branch - run 'sp sync' without --all)`);
      skipped.push({ branch: branch.name, reason: "current-branch" });
      continue;
    }

    // Check if behind target
    const isBehind = await isBranchBehindTarget(branch.name, target, options);
    if (!isBehind) {
      console.log(`⊘ ${branch.name}: skipped (up-to-date)`);
      skipped.push({ branch: branch.name, reason: "up-to-date" });
      continue;
    }

    // Check dirty worktree
    if (branch.inWorktree) {
      const isDirty = await hasUncommittedChanges({ cwd: branch.worktreePath });
      if (isDirty) {
        console.log(`⊘ ${branch.name}: skipped (worktree has uncommitted changes)`);
        skipped.push({ branch: branch.name, reason: "dirty-worktree" });
        continue;
      }
    }

    // NEW: Validate stack structure (check for split groups)
    const validation = await validateBranchStack(branch.name, options);
    if (!validation.valid) {
      const groupInfo = validation.splitGroupInfo?.groupTitle ?? validation.splitGroupInfo?.groupId ?? "unknown";
      console.log(`⊘ ${branch.name}: skipped (split group "${groupInfo}" - run 'sp group --fix' on that branch)`);
      skipped.push({
        branch: branch.name,
        reason: "split-group",
        splitGroupInfo: validation.splitGroupInfo,
      });
      continue;
    }

    // Phase 3: Still stub the actual rebase (done in Phase 4)
    console.log(`⊘ ${branch.name}: skipped (rebase not yet implemented)`);
    skipped.push({ branch: branch.name, reason: "up-to-date" }); // placeholder
  }

  reportSyncAllResults(rebased, skipped, target);
  return { rebased, skipped };
}
```

---

## Test Cases

**File:** `tests/integration/sync-all.test.ts`

### Test 1: Detects split group on non-current branch

```typescript
test("validateBranchStack detects split group on non-current branch", async () => {
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
```

### Test 2: Valid branch passes validation

```typescript
test("validateBranchStack returns valid for well-formed branch", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const result = await validateBranchStack(
    `feature-behind-${repo.uniqueId}`,
    { cwd: repo.path },
  );

  expect(result.valid).toBe(true);
});
```

### Test 3: Does not change current branch

```typescript
test("validateBranchStack does not change current branch", async () => {
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
```

### Test 4: CLI shows split group skip reason

```typescript
test("--all skips branches with split groups", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const result = await runSpry(repo.path, "sync", ["--all"]);

  expect(result.stdout).toContain("feature-split");
  expect(result.stdout).toContain("split group");
  expect(result.stdout).toContain("groupA");
});
```

---

## Definition of Done

- [ ] `validateBranchStack()` function implemented in `src/git/rebase.ts`
- [ ] `syncAllCommand()` updated to validate stacks and skip branches with split groups
- [ ] CLI output shows split group reason with group ID/title
- [ ] All Phase 3 tests pass
- [ ] `validateBranchStack()` works without modifying current branch

---

## Next Phase

Once this phase is complete, proceed to [SUB_PLAN_PHASE_4.md](./SUB_PLAN_PHASE_4.md) - Full Orchestration.
