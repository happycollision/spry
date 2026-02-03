# Phase 2: Branch-Aware Core Functions

**Goal:** Add optional `branch` parameter to existing functions, convert to result types where appropriate. This enables `syncAllCommand()` to reuse the same logic as `syncCommand()`.

**Status:** Complete

**Depends on:** Phase 1

---

## Design Principles

### 1. Optional Parameters for Backwards Compatibility

All changes add optional parameters. Existing callers continue to work:

```typescript
// Before: only works on current branch
await injectMissingIds();

// After: works on any branch, defaults to current
await injectMissingIds();                        // current branch (unchanged)
await injectMissingIds({ branch: "feature-x" }); // specific branch
```

### 2. Result Types Over Exceptions

For recoverable errors (detached HEAD, conflicts, dirty worktree), return result types:

```typescript
// Instead of: throw new Error("Detached HEAD")
// Return: { ok: false, reason: "detached-head" }

type InjectIdsResult =
  | { ok: true; modifiedCount: number; rebasePerformed: boolean }
  | { ok: false; reason: "detached-head" };
```

### 3. Worktree Detached HEAD Handling

When operating on a branch in a worktree, that worktree could be in detached HEAD state. We don't throw - we return a result indicating the issue:

```typescript
if (options.branch) {
  const worktreeInfo = await getBranchWorktree(options.branch, options);
  if (worktreeInfo.checkedOut && worktreeInfo.worktreePath) {
    const isDetached = await isDetachedHead({ cwd: worktreeInfo.worktreePath });
    if (isDetached) {
      return { ok: false, reason: "detached-head" };
    }
  }
}
```

---

## Part A: Helper - `getStackCommitsForBranch()`

**File:** `src/git/commands.ts`

New helper function to get commits for any branch (not just HEAD):

```typescript
/**
 * Get commits between origin/main and a specific branch.
 * Unlike getStackCommits(), this works on any branch, not just HEAD.
 */
export async function getStackCommitsForBranch(
  branch: string,
  options: GitOptions = {},
): Promise<CommitInfo[]> {
  const defaultBranchRef = await getDefaultBranchRef();
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} log --reverse --format=%H%x00%s%x00%b ${defaultBranchRef}..${branch}`.text()
    : await $`git log --reverse --format=%H%x00%s%x00%b ${defaultBranchRef}..${branch}`.text();

  // Parse commits (same format as getStackCommits)
  return parseCommitLog(result);
}
```

---

## Part B: Extend `getStackCommitsWithTrailers()`

**File:** `src/git/commands.ts`

Add optional `branch` parameter:

```typescript
export async function getStackCommitsWithTrailers(
  options: GitOptions & { branch?: string } = {},
): Promise<CommitWithTrailers[]> {
  const { branch, ...gitOptions } = options;

  // Get commits for specified branch or HEAD
  const commits = branch
    ? await getStackCommitsForBranch(branch, gitOptions)
    : await getStackCommits(gitOptions);

  // Parse trailers (existing logic)
  return commits.map(commit => ({
    ...commit,
    trailers: parseTrailers(commit.body),
  }));
}
```

### Test Case

```typescript
test("getStackCommitsWithTrailers works on non-current branch", async () => {
  const repo = await repos.create();

  // Create branch A with a commit
  const branchA = await repo.branch("feature-a");
  await repo.commit({
    message: "Commit on A",
    trailers: { "Spry-Commit-Id": "aaa00001" },
  });

  // Create branch B with different commits
  await repo.checkout("main");
  const branchB = await repo.branch("feature-b");
  await repo.commit({
    message: "Commit on B",
    trailers: { "Spry-Commit-Id": "bbb00001" },
  });

  // Stay on B, query A
  const commitsA = await getStackCommitsWithTrailers({
    cwd: repo.path,
    branch: branchA,
  });

  expect(commitsA).toHaveLength(1);
  expect(commitsA[0].trailers["Spry-Commit-Id"]).toBe("aaa00001");

  // Verify still on B
  expect(await repo.currentBranch()).toBe(branchB);
});
```

---

## Part C: Extend `injectMissingIds()` with Result Type

**File:** `src/git/rebase.ts`

### Updated Interface

```typescript
export type InjectIdsResult =
  | { ok: true; modifiedCount: number; rebasePerformed: boolean }
  | { ok: false; reason: "detached-head" };

export async function injectMissingIds(
  options: GitOptions & { branch?: string } = {},
): Promise<InjectIdsResult>
```

### Implementation

```typescript
export async function injectMissingIds(
  options: GitOptions & { branch?: string } = {},
): Promise<InjectIdsResult> {
  const { branch: branchParam, ...gitOptions } = options;
  const branch = branchParam ?? await getCurrentBranch(gitOptions);

  // Check for detached HEAD
  if (!branchParam) {
    // Operating on current branch - check current worktree
    const isDetached = await isDetachedHead(gitOptions);
    if (isDetached) {
      return { ok: false, reason: "detached-head" };
    }
  } else {
    // Operating on specific branch - check if it's in a worktree with detached HEAD
    const worktreeInfo = await getBranchWorktree(branch, gitOptions);
    if (worktreeInfo.checkedOut && worktreeInfo.worktreePath) {
      const isDetached = await isDetachedHead({ cwd: worktreeInfo.worktreePath });
      if (isDetached) {
        return { ok: false, reason: "detached-head" };
      }
    }
  }

  // Get commits with trailers parsed (branch-aware)
  const commits = await getStackCommitsWithTrailers({ ...gitOptions, branch });

  // Find commits without IDs
  const needsId = commits.filter((c) => !c.trailers["Spry-Commit-Id"]);

  if (needsId.length === 0) {
    return { ok: true, modifiedCount: 0, rebasePerformed: false };
  }

  // Build the rewrites map
  const rewrites = new Map<string, string>();
  for (const commit of needsId) {
    const newId = generateCommitId();
    const originalMessage = await getCommitMessage(commit.hash, gitOptions);
    const newMessage = await addTrailers(originalMessage, { "Spry-Commit-Id": newId });
    rewrites.set(commit.hash, newMessage);
  }

  // Get all commit hashes in order
  const allHashes = commits.map((c) => c.hash);
  const oldTip = asserted(allHashes.at(-1));

  // Rewrite the commit chain
  const result = await rewriteCommitChain(allHashes, rewrites, gitOptions);

  // Finalize based on context
  if (branchParam) {
    // Non-current branch: just update ref
    await updateRef(`refs/heads/${branch}`, result.newTip, oldTip, gitOptions);

    // If in worktree, also update working directory
    const worktreeInfo = await getBranchWorktree(branch, gitOptions);
    if (worktreeInfo.checkedOut && worktreeInfo.worktreePath) {
      await $`git -C ${worktreeInfo.worktreePath} reset --hard ${result.newTip}`.quiet();
    }
  } else {
    // Current branch: use finalizeRewrite
    await finalizeRewrite(branch, oldTip, result.newTip, gitOptions);
  }

  return { ok: true, modifiedCount: needsId.length, rebasePerformed: true };
}
```

### Test Case

```typescript
test("injectMissingIds works on non-current branch", async () => {
  const repo = await repos.create();

  // Create branch with mixed commits
  const branch = await repo.branch("feature-mixed");
  await repo.commit({
    message: "Commit with ID",
    trailers: { "Spry-Commit-Id": "mix00001" },
  });
  await repo.commit({ message: "Commit without ID" });

  // Go back to main
  await repo.checkout("main");

  // Inject IDs on the feature branch
  const result = await injectMissingIds({ cwd: repo.path, branch });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.modifiedCount).toBe(1);
  }

  // Verify all commits now have IDs
  const commits = await getStackCommitsWithTrailers({ cwd: repo.path, branch });
  for (const commit of commits) {
    expect(commit.trailers["Spry-Commit-Id"]).toBeDefined();
  }

  // Verify still on main
  expect(await repo.currentBranch()).toBe("main");
});
```

---

## Part D: Extend `predictRebaseConflicts()`

**File:** `src/git/rebase.ts`

Add optional `branch` and `onto` parameters:

```typescript
export async function predictRebaseConflicts(
  options: GitOptions & { branch?: string; onto?: string } = {},
): Promise<RebaseConflictPrediction> {
  const { branch, onto: ontoParam, ...gitOptions } = options;
  const onto = ontoParam ?? await getDefaultBranchRef();

  // Get commits for specified branch or HEAD
  const commits = branch
    ? await getStackCommitsForBranch(branch, gitOptions)
    : await getStackCommits(gitOptions);

  const commitCount = commits.length;

  if (commitCount === 0) {
    return { wouldSucceed: true, commitCount: 0 };
  }

  // Get the target SHA
  const ontoSha = await getFullSha(onto, gitOptions);

  // Get commit hashes in order
  const commitHashes = commits.map((c) => c.hash);

  // Test rebase with plumbing
  const result = await rebasePlumbing(ontoSha, commitHashes, gitOptions);

  if (result.ok) {
    return { wouldSucceed: true, commitCount };
  }

  // Would conflict - parse conflict info
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

### Test Cases

```typescript
test("predictRebaseConflicts works on non-current branch", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  // Stay on feature-behind, check feature-conflict
  const prediction = await predictRebaseConflicts({
    cwd: repo.path,
    branch: `feature-conflict-${repo.uniqueId}`,
    onto: "origin/main",
  });

  expect(prediction.wouldSucceed).toBe(false);
  expect(prediction.conflictInfo?.files).toContain("conflict.txt");
});

test("predictRebaseConflicts does not change current branch", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const branchBefore = await repo.currentBranch();

  await predictRebaseConflicts({
    cwd: repo.path,
    branch: `feature-conflict-${repo.uniqueId}`,
  });

  const branchAfter = await repo.currentBranch();
  expect(branchAfter).toBe(branchBefore);
});
```

---

## Part E: Extend `rebaseOntoMain()` with Result Type

**File:** `src/git/rebase.ts`

### Updated Interface

```typescript
export type RebaseResult =
  | { ok: true; commitCount: number; newTip: string }
  | { ok: false; reason: "detached-head" | "conflict"; conflictFile?: string };

export async function rebaseOntoMain(
  options: GitOptions & {
    branch?: string;
    onto?: string;
    worktreePath?: string;
  } = {},
): Promise<RebaseResult>
```

### Implementation

```typescript
export async function rebaseOntoMain(
  options: GitOptions & {
    branch?: string;
    onto?: string;
    worktreePath?: string;
  } = {},
): Promise<RebaseResult> {
  const { branch: branchParam, onto: ontoParam, worktreePath, ...gitOptions } = options;
  const branch = branchParam ?? await getCurrentBranch(gitOptions);
  const onto = ontoParam ?? await getDefaultBranchRef();

  // Check for detached HEAD
  if (!branchParam) {
    const isDetached = await isDetachedHead(gitOptions);
    if (isDetached) {
      return { ok: false, reason: "detached-head" };
    }
  } else if (worktreePath) {
    const isDetached = await isDetachedHead({ cwd: worktreePath });
    if (isDetached) {
      return { ok: false, reason: "detached-head" };
    }
  }

  // Get commits
  const commits = branchParam
    ? await getStackCommitsForBranch(branch, gitOptions)
    : await getStackCommits(gitOptions);

  const commitCount = commits.length;

  if (commitCount === 0) {
    return { ok: true, commitCount: 0, newTip: await getFullSha(branch, gitOptions) };
  }

  // Get the target SHA
  const ontoSha = await getFullSha(onto, gitOptions);
  const commitHashes = commits.map((c) => c.hash);

  // Try plumbing rebase
  const result = await rebasePlumbing(ontoSha, commitHashes, gitOptions);

  if (!result.ok) {
    // For non-current branches, we don't fall back to traditional rebase
    // Just report the conflict
    if (branchParam) {
      const { files } = parseConflictOutput(result.conflictInfo ?? "");
      return { ok: false, reason: "conflict", conflictFile: files[0] };
    }

    // For current branch, fall back to traditional rebase for user resolution
    // (existing behavior)
    const traditionalResult = await $`git rebase --no-autosquash --no-verify ${onto}`
      .quiet()
      .nothrow();

    if (traditionalResult.exitCode === 0) {
      const newTip = await getFullSha("HEAD", gitOptions);
      return { ok: true, commitCount, newTip };
    }

    // Check for conflict file
    const statusResult = await $`git status --porcelain`.text();
    const conflictMatch = statusResult.match(/^(?:UU|AA|DD|AU|UA|DU|UD) (.+)$/m);

    return {
      ok: false,
      reason: "conflict",
      conflictFile: conflictMatch?.[1],
    };
  }

  // Success - finalize
  const oldTip = asserted(commitHashes.at(-1));

  if (worktreePath) {
    // Branch in worktree: update ref + reset worktree
    await updateRef(`refs/heads/${branch}`, result.newTip, oldTip, gitOptions);
    await $`git -C ${worktreePath} reset --hard ${result.newTip}`.quiet();
  } else if (branchParam) {
    // Non-current branch: just update ref
    await updateRef(`refs/heads/${branch}`, result.newTip, oldTip, gitOptions);
  } else {
    // Current branch: use finalizeRewrite
    await finalizeRewrite(branch, oldTip, result.newTip, gitOptions);
  }

  return { ok: true, commitCount, newTip: result.newTip };
}
```

### Test Cases

```typescript
test("rebaseOntoMain works on non-current branch", async () => {
  const repo = await repos.create();

  // Create feature branch
  const featureBranch = await repo.branch("feature");
  await repo.commit({
    message: "Feature commit",
    trailers: { "Spry-Commit-Id": "feat0001" },
  });

  // Go back to main and update origin
  await repo.checkout("main");
  await repo.updateOriginMain("Upstream change");
  await repo.fetch();

  // Rebase the feature branch (not checked out)
  const result = await rebaseOntoMain({
    cwd: repo.path,
    branch: featureBranch,
    onto: "origin/main",
  });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.commitCount).toBe(1);
  }

  // Verify we're still on main
  expect(await repo.currentBranch()).toBe("main");

  // Verify feature is now on top of origin/main
  const mergeBase = await $`git -C ${repo.path} merge-base ${featureBranch} origin/main`.text();
  const originMain = await $`git -C ${repo.path} rev-parse origin/main`.text();
  expect(mergeBase.trim()).toBe(originMain.trim());
});

test("rebaseOntoMain returns result for conflict instead of throwing", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const result = await rebaseOntoMain({
    cwd: repo.path,
    branch: `feature-conflict-${repo.uniqueId}`,
    onto: "origin/main",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("conflict");
  }
});
```

---

## Part F: Update `syncAllCommand()` for Non-Current Branches

Add up-to-date and dirty-worktree checks for non-current branches.

**Note:** Current branch sync is already implemented (Phase 1 Addendum). This phase only needs to add checks for non-current branches.

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
    // Current branch: already implemented in Phase 1 Addendum
    if (branch.name === currentBranch) {
      const result = await syncCurrentBranchForAll();
      // ... (existing implementation from Phase 1)
      continue;
    }

    // NEW: Check if behind target
    const isBehind = await isBranchBehindTarget(branch.name, target);
    if (!isBehind) {
      console.log(`⊘ ${branch.name}: skipped (up-to-date)`);
      skipped.push({ branch: branch.name, reason: "up-to-date" });
      continue;
    }

    // NEW: Check dirty worktree
    if (branch.inWorktree) {
      const isDirty = await hasUncommittedChanges({ cwd: branch.worktreePath });
      if (isDirty) {
        console.log(`⊘ ${branch.name}: skipped (worktree has uncommitted changes)`);
        skipped.push({ branch: branch.name, reason: "dirty-worktree" });
        continue;
      }
    }

    // Phase 2: Still stub the actual rebase (done in Phase 4)
    console.log(`⊘ ${branch.name}: skipped (rebase not yet implemented)`);
    skipped.push({ branch: branch.name, reason: "up-to-date" }); // placeholder
  }

  // Summary (existing implementation)
  return { rebased, skipped };
}

async function isBranchBehindTarget(branch: string, target: string): Promise<boolean> {
  const behindCount = (
    await $`git rev-list --count ${branch}..${target}`.text()
  ).trim();
  return parseInt(behindCount, 10) > 0;
}
```

---

## Part G: Export `parseConflictOutput`

**File:** `src/git/conflict-predict.ts`

Change from internal function to export:

```typescript
// Before
function parseConflictOutput(output: string): { files: string[]; lines: string[] }

// After
export function parseConflictOutput(output: string): { files: string[]; lines: string[] }
```

---

## Definition of Done

- [x] `getStackCommitsForBranch()` helper implemented
- [x] `getStackCommitsWithTrailers()` extended with optional `branch` parameter
- [x] `injectMissingIds()` extended with optional `branch` parameter and returns result type
- [x] `predictRebaseConflicts()` extended with optional `branch` and `onto` parameters
- [x] `rebaseOntoMain()` extended with optional `branch`, `onto`, `worktreePath` parameters and returns result type
- [x] `parseConflictOutput()` exported from `conflict-predict.ts`
- [x] `syncAllCommand()` updated with up-to-date and dirty-worktree checks
- [x] All Phase 2 tests pass
- [x] Existing tests still pass (backwards compatibility)
- [x] Full CI test run passes: `bun run test:docker`

---

## Next Phase

Once this phase is complete, proceed to [SUB_PLAN_PHASE_3.md](./SUB_PLAN_PHASE_3.md) - Stack Validation.
