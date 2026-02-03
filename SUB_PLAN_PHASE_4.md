# Phase 4: Full Orchestration

**Goal:** Complete `syncAllCommand()` with ID injection, conflict prediction, and rebase execution. Remove all stubs.

**Status:** Not Started

**Depends on:** Phases 1-3

---

## What This Phase Delivers

The complete `sp sync --all` implementation:

1. **Discover** - Find all Spry branches (Phase 1) ✅
2. **Sync Current** - Use existing sync logic for current branch (Phase 1 Addendum) ✅
3. **Filter** - Skip up-to-date, dirty worktree (Phase 2)
4. **Validate** - Check for split groups (Phase 3)
5. **Inject IDs** - For non-current branches with missing IDs ← NEW
6. **Predict Conflicts** - Skip non-current branches that would conflict ← NEW
7. **Rebase** - Execute rebase for safe non-current branches ← NEW
8. **Report** - Show results ✅

**Note:** Current branch sync is already complete (Phase 1 Addendum). This phase completes sync for non-current branches using the branch-aware functions from Phase 2.

---

## Part A: Complete `syncAllCommand()` for Non-Current Branches

**File:** `src/cli/commands/sync.ts`

Remove stub placeholders for non-current branches and implement full flow. Current branch sync is already implemented (Phase 1 Addendum).

```typescript
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

  console.log(`Syncing ${spryBranches.length} Spry branch(es)...\n`);

  const rebased: SyncAllResult["rebased"] = [];
  const skipped: SyncAllResult["skipped"] = [];

  for (const branch of spryBranches) {
    // 1. Current branch: already implemented (Phase 1 Addendum)
    if (branch.name === currentBranch) {
      const result = await syncCurrentBranchForAll();
      // ... (existing implementation handles rebased/skipped)
      continue;
    }

    // 2. Check if behind target
    const isBehind = await isBranchBehindTarget(branch.name, target, options);
    if (!isBehind) {
      console.log(`⊘ ${branch.name}: skipped (up-to-date)`);
      skipped.push({ branch: branch.name, reason: "up-to-date" });
      continue;
    }

    // 3. Check dirty worktree
    if (branch.inWorktree) {
      const isDirty = await hasUncommittedChanges({ cwd: branch.worktreePath });
      if (isDirty) {
        console.log(`⊘ ${branch.name}: skipped (worktree has uncommitted changes)`);
        skipped.push({ branch: branch.name, reason: "dirty-worktree" });
        continue;
      }
    }

    // 4. Validate stack structure (check for split groups)
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

    // 5. Inject missing IDs if needed
    let idsInjected = 0;
    if (branch.hasMissingIds) {
      const injectResult = await injectMissingIds({ ...options, branch: branch.name });
      if (!injectResult.ok) {
        // Handle detached HEAD in worktree
        console.log(`⊘ ${branch.name}: skipped (${injectResult.reason})`);
        skipped.push({ branch: branch.name, reason: injectResult.reason as any });
        continue;
      }
      idsInjected = injectResult.modifiedCount;
    }

    // 6. Predict conflicts before attempting rebase
    const prediction = await predictRebaseConflicts({
      ...options,
      branch: branch.name,
      onto: target,
    });

    if (!prediction.wouldSucceed) {
      const files = prediction.conflictInfo?.files.slice(0, 3).join(", ") ?? "unknown";
      console.log(`⊘ ${branch.name}: skipped (would conflict in: ${files})`);
      skipped.push({
        branch: branch.name,
        reason: "conflict",
        conflictFiles: prediction.conflictInfo?.files,
      });
      continue;
    }

    // 7. Perform the rebase
    const result = await rebaseOntoMain({
      ...options,
      branch: branch.name,
      onto: target,
      worktreePath: branch.inWorktree ? branch.worktreePath : undefined,
    });

    if (result.ok) {
      const wtNote = branch.inWorktree ? " (worktree updated)" : "";
      console.log(`✓ ${branch.name}: rebased ${result.commitCount} commit(s) onto ${target}${wtNote}`);
      rebased.push({
        branch: branch.name,
        commitCount: result.commitCount,
        wasInWorktree: branch.inWorktree,
        idsInjected: idsInjected > 0 ? idsInjected : undefined,
      });
    } else {
      // Unexpected failure (shouldn't happen after prediction, but handle gracefully)
      console.log(`⊘ ${branch.name}: skipped (${result.reason})`);
      skipped.push({
        branch: branch.name,
        reason: result.reason === "conflict" ? "conflict" : ("error" as any),
        conflictFiles: result.conflictFile ? [result.conflictFile] : undefined,
      });
    }
  }

  // Report summary
  reportSyncAllResults(rebased, skipped, target);
  return { rebased, skipped };
}
```

---

## Part B: Helper Functions

**File:** `src/cli/commands/sync.ts`

```typescript
async function isBranchBehindTarget(
  branch: string,
  target: string,
  options: GitOptions = {},
): Promise<boolean> {
  const { cwd } = options;
  const behindCount = cwd
    ? (await $`git -C ${cwd} rev-list --count ${branch}..${target}`.text()).trim()
    : (await $`git rev-list --count ${branch}..${target}`.text()).trim();
  return parseInt(behindCount, 10) > 0;
}

function reportSyncAllResults(
  rebased: SyncAllResult["rebased"],
  skipped: SyncAllResult["skipped"],
  target: string,
): void {
  console.log("");

  // Summary counts
  const upToDate = skipped.filter(s => s.reason === "up-to-date").length;
  const conflicts = skipped.filter(s => s.reason === "conflict").length;
  const dirty = skipped.filter(s => s.reason === "dirty-worktree").length;
  const splitGroups = skipped.filter(s => s.reason === "split-group").length;

  console.log(`Rebased: ${rebased.length} branch(es)`);
  if (skipped.length > 0) {
    const parts = [];
    if (upToDate > 0) parts.push(`${upToDate} up-to-date`);
    if (conflicts > 0) parts.push(`${conflicts} conflict`);
    if (dirty > 0) parts.push(`${dirty} dirty`);
    if (splitGroups > 0) parts.push(`${splitGroups} split-group`);
    console.log(`Skipped: ${skipped.length} branch(es) (${parts.join(", ")})`);
  }
}
```

---

## Part C: Update `SyncAllResult` Interface

**File:** `src/cli/commands/sync.ts`

Ensure the interface supports all skip reasons:

```typescript
export interface SyncAllResult {
  /** Branches that were successfully rebased */
  rebased: Array<{
    branch: string;
    commitCount: number;
    wasInWorktree: boolean;
    idsInjected?: number;
  }>;
  /** Branches that were skipped */
  skipped: Array<{
    branch: string;
    reason: "up-to-date" | "conflict" | "dirty-worktree" | "split-group" | "detached-head";
    conflictFiles?: string[];
    splitGroupInfo?: {
      groupId: string;
      groupTitle?: string;
    };
  }>;
}
```

---

## Test Cases

**File:** `tests/integration/sync-all.test.ts`

### Test 1: Full end-to-end sync

```typescript
test("syncs multiple Spry branches end-to-end", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const result = await syncAllCommand({ cwd: repo.path });

  // feature-behind should be rebased
  expect(result.rebased.map(r => r.branch)).toContain(
    expect.stringContaining("feature-behind")
  );

  // feature-conflict should be skipped with conflict reason
  const conflictSkip = result.skipped.find(s =>
    s.branch.includes("feature-conflict")
  );
  expect(conflictSkip).toBeDefined();
  expect(conflictSkip?.reason).toBe("conflict");

  // feature-split should be skipped with split-group reason
  const splitSkip = result.skipped.find(s =>
    s.branch.includes("feature-split")
  );
  expect(splitSkip).toBeDefined();
  expect(splitSkip?.reason).toBe("split-group");
});
```

### Test 2: Rebased branches are actually rebased

```typescript
test("rebased branches have correct ancestry", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const behindBranch = `feature-behind-${repo.uniqueId}`;

  // Verify branch is behind before sync
  const behindBefore = await $`git -C ${repo.path} rev-list --count ${behindBranch}..origin/main`.text();
  expect(parseInt(behindBefore.trim())).toBeGreaterThan(0);

  await syncAllCommand({ cwd: repo.path });

  // After sync, branch should be on top of origin/main
  const mergeBase = await $`git -C ${repo.path} merge-base ${behindBranch} origin/main`.text();
  const originMain = await $`git -C ${repo.path} rev-parse origin/main`.text();
  expect(mergeBase.trim()).toBe(originMain.trim());
});
```

### Test 3: Injects missing IDs before rebasing

```typescript
test("injects missing IDs before rebasing", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const result = await syncAllCommand({ cwd: repo.path });

  // feature-mixed should be rebased (IDs were injected first)
  const mixedRebased = result.rebased.find(r =>
    r.branch.includes("feature-mixed")
  );
  expect(mixedRebased).toBeDefined();

  // Verify all commits on feature-mixed now have IDs
  const commits = await getStackCommitsWithTrailers({
    cwd: repo.path,
    branch: mixedRebased!.branch,
  });
  for (const commit of commits) {
    expect(commit.trailers["Spry-Commit-Id"]).toBeDefined();
  }
});
```

### Test 4: Worktree is updated after rebase

```typescript
test("worktree is updated after rebase", async () => {
  const repo = await repos.create();

  // Create feature branch
  const featureBranch = await repo.branch("feature");
  await repo.commit({
    message: "Feature commit",
    trailers: { "Spry-Commit-Id": "wt000001" },
  });

  // Go back to main and create worktree
  await repo.checkout("main");
  const worktree = await repo.createWorktree(featureBranch);

  // Update origin/main with a new file
  await repo.updateOriginMain("Add upstream file", {
    "upstream.txt": "Upstream content\n",
  });
  await repo.fetch();

  // Run sync --all
  await syncAllCommand({ cwd: repo.path });

  // Verify worktree has the upstream file
  const upstreamExists = await Bun.file(join(worktree.path, "upstream.txt")).exists();
  expect(upstreamExists).toBe(true);

  // Verify worktree is still clean
  const isDirty = await hasUncommittedChanges({ cwd: worktree.path });
  expect(isDirty).toBe(false);
});
```

### Test 5: CLI output format

```typescript
test("CLI output matches expected format", async () => {
  const repo = await repos.create();
  await scenarios.multiSpryBranches.setup(repo);

  const result = await runSpry(repo.path, "sync", ["--all"]);

  expect(result.exitCode).toBe(0);

  // Check for success symbol
  expect(result.stdout).toMatch(/✓.*rebased/);

  // Check for skip symbol
  expect(result.stdout).toMatch(/⊘.*skipped/);

  // Check for summary
  expect(result.stdout).toContain("Rebased:");
  expect(result.stdout).toContain("Skipped:");
});
```

### Test 6: No Spry branches gracefully handled

```typescript
test("handles no Spry branches gracefully", async () => {
  const repo = await repos.create();

  // Create only non-Spry branches
  await repo.branch("feature-plain");
  await repo.commit({ message: "No Spry-Commit-Id" });

  const result = await syncAllCommand({ cwd: repo.path });

  expect(result.rebased).toHaveLength(0);
  expect(result.skipped).toHaveLength(0);
});
```

---

## Expected Output

```
$ sp sync --all
Syncing 7 Spry branch(es)...

✓ feature-auth: rebased 3 commits onto origin/main
✓ feature-api: rebased 5 commits onto origin/main (worktree updated)
✓ feature-mixed: rebased 2 commits onto origin/main
✓ feature-current: rebased 2 commits onto origin/main (current branch)
⊘ feature-ui: skipped (up-to-date)
⊘ feature-db: skipped (would conflict in: src/db/schema.ts)
⊘ feature-wip: skipped (worktree has uncommitted changes)
⊘ feature-split: skipped (split group "groupA" - run 'sp group --fix' on that branch)

Rebased: 4 branch(es)
Skipped: 4 branch(es) (1 up-to-date, 1 conflict, 1 dirty, 1 split-group)
```

**Note:** The current branch is included and synced like any other branch (indicated by "(current branch)" suffix).

---

## Definition of Done

- [x] Current branch sync implemented (Phase 1 Addendum)
- [ ] Non-current branch stubs removed - full implementation
- [ ] ID injection integrated for non-current branches (calls `injectMissingIds({ branch })`)
- [ ] Conflict prediction integrated for non-current branches (calls `predictRebaseConflicts({ branch })`)
- [ ] Rebase execution integrated for non-current branches (calls `rebaseOntoMain({ branch })`)
- [ ] Worktree updates work correctly for non-current branches
- [ ] All Phase 4 tests pass
- [ ] Output format matches specification
- [ ] Full CI test run passes: `bun run test:ci`

---

## Completion

After Phase 4, the `sp sync --all` feature is complete:

- Users can run `sp sync --all` to rebase all Spry branches
- Clear reporting shows what happened to each branch
- Safe handling of worktrees (skips dirty ones, updates clean ones)
- Conflict detection without getting stuck in rebase state
- Split group detection with helpful error messages
- Automatic ID injection for mixed-commit branches

### Full Test Run

```bash
bun run test:docker tests/integration/sync-all.test.ts
bun run test:ci
```

All tests should pass!
