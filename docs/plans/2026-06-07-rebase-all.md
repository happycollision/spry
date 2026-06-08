# sp rebase --all Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track which branches the user has run `sp` commands on (in a local-only git ref), and add `sp rebase --all` to rebase every tracked branch in one shot.

**Architecture:** A new `src/git/tracked-branches.ts` module stores a JSON array of branch names at `refs/spry/local/tracked-branches` (local-only, never pushed) using the same blob-in-tree-in-commit pattern as the PR cache. `syncCommand`, `groupCommand`, and `rebaseCommand` register the current branch on every run. `rebase --all` loads the tracked list, fetches once, rebases each behind-branch, skips conflicts without aborting, and prunes branches that no longer exist.

**Tech Stack:** Bun, TypeScript, git plumbing commands (`hash-object`, `mktree`, `commit-tree`, `update-ref`, `cat-file`, `for-each-ref`), Commander.js for CLI.

---

### Task 1: `src/git/tracked-branches.ts` — new module

**Files:**

- Create: `src/git/tracked-branches.ts`
- Create: `tests/git/tracked-branches.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/git/tracked-branches.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { loadTrackedBranches, saveTrackedBranches, registerBranch } from "../../src/git/tracked-branches.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()!.cleanup();
});

async function makeRepo() {
  const repo = await createRepo();
  repos.push(repo);
  return { repo, git: createRealGitRunner() };
}

describe("loadTrackedBranches", () => {
  test("returns empty array when ref does not exist", async () => {
    const { repo, git } = await makeRepo();
    const result = await loadTrackedBranches(git, { cwd: repo.path });
    expect(result).toEqual([]);
  });
});

describe("saveTrackedBranches / loadTrackedBranches", () => {
  test("round-trips a list of branch names", async () => {
    const { repo, git } = await makeRepo();
    await saveTrackedBranches(git, ["feature-a", "feature-b"], { cwd: repo.path });
    const loaded = await loadTrackedBranches(git, { cwd: repo.path });
    expect(loaded).toEqual(["feature-a", "feature-b"]);
  });

  test("deletes ref when saving empty list", async () => {
    const { repo, git } = await makeRepo();
    await saveTrackedBranches(git, ["feature-a"], { cwd: repo.path });
    await saveTrackedBranches(git, [], { cwd: repo.path });
    const result = await loadTrackedBranches(git, { cwd: repo.path });
    expect(result).toEqual([]);
  });
});

describe("registerBranch", () => {
  test("adds branch when not already tracked", async () => {
    const { repo, git } = await makeRepo();
    await registerBranch(git, "feature-x", { cwd: repo.path });
    const result = await loadTrackedBranches(git, { cwd: repo.path });
    expect(result).toContain("feature-x");
  });

  test("is idempotent — does not duplicate", async () => {
    const { repo, git } = await makeRepo();
    await registerBranch(git, "feature-x", { cwd: repo.path });
    await registerBranch(git, "feature-x", { cwd: repo.path });
    const result = await loadTrackedBranches(git, { cwd: repo.path });
    expect(result.filter((b) => b === "feature-x")).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker -- tests/git/tracked-branches.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement `src/git/tracked-branches.ts`**

```ts
import type { GitRunner } from "../lib/context.ts";

export const TRACKED_BRANCHES_REF = "refs/spry/local/tracked-branches";

interface Opts {
  cwd?: string;
}

export async function loadTrackedBranches(git: GitRunner, opts?: Opts): Promise<string[]> {
  const cat = await git.run(["cat-file", "blob", `${TRACKED_BRANCHES_REF}:data`], opts);
  if (cat.exitCode !== 0) return [];
  try {
    return JSON.parse(cat.stdout.trim()) as string[];
  } catch {
    return [];
  }
}

export async function saveTrackedBranches(
  git: GitRunner,
  branches: string[],
  opts?: Opts,
): Promise<void> {
  if (branches.length === 0) {
    await git.run(["update-ref", "-d", TRACKED_BRANCHES_REF], opts);
    return;
  }

  const content = JSON.stringify(branches);
  const blob = await git.run(["hash-object", "-w", "--stdin"], { ...opts, stdin: content });
  if (blob.exitCode !== 0)
    throw new Error(`saveTrackedBranches: hash-object failed: ${blob.stderr}`);

  const treeInput = `100644 blob ${blob.stdout.trim()}\tdata\n`;
  const tree = await git.run(["mktree"], { ...opts, stdin: treeInput });
  if (tree.exitCode !== 0)
    throw new Error(`saveTrackedBranches: mktree failed: ${tree.stderr}`);

  const commitArgs = ["commit-tree", tree.stdout.trim(), "-m", "update tracked branches"];
  const parent = await git.run(["rev-parse", "--verify", TRACKED_BRANCHES_REF], opts);
  if (parent.exitCode === 0) commitArgs.push("-p", parent.stdout.trim());
  const commit = await git.run(commitArgs, opts);
  if (commit.exitCode !== 0)
    throw new Error(`saveTrackedBranches: commit-tree failed: ${commit.stderr}`);

  const ref = await git.run(["update-ref", TRACKED_BRANCHES_REF, commit.stdout.trim()], opts);
  if (ref.exitCode !== 0)
    throw new Error(`saveTrackedBranches: update-ref failed: ${ref.stderr}`);
}

export async function registerBranch(
  git: GitRunner,
  branch: string,
  opts?: Opts,
): Promise<void> {
  const branches = await loadTrackedBranches(git, opts);
  if (branches.includes(branch)) return;
  await saveTrackedBranches(git, [...branches, branch], opts);
}
```

**Step 4: Run tests — expect pass**

```bash
bun run test:docker -- tests/git/tracked-branches.test.ts
```

**Step 5: Commit**

```bash
git add src/git/tracked-branches.ts tests/git/tracked-branches.test.ts
git commit -m "feat(git): add tracked-branches module (refs/spry/local/tracked-branches)"
```

---

### Task 2: Export from `src/git/index.ts` + add `isStackBehindTrunkForBranch`

**Files:**

- Modify: `src/git/behind.ts`
- Modify: `src/git/index.ts`
- Modify: `tests/git/tracked-branches.test.ts` (no new file needed — add to existing)

**Step 1: Add a test for `isStackBehindTrunkForBranch` in the existing behind tests**

There is no `tests/git/behind.test.ts` yet — create it:

```ts
// tests/git/behind.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { isStackBehindTrunkForBranch } from "../../src/git/behind.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()!.cleanup();
});

describe("isStackBehindTrunkForBranch", () => {
  test("returns false when branch merge-base equals trunk tip", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const git = createRealGitRunner();

    await repo.fetch();
    const branch = await repo.branch("feature");
    await repo.commit("feature work");
    // origin/main has NOT advanced — branch is up to date

    const behind = await isStackBehindTrunkForBranch(
      git,
      branch,
      "origin/main",
      { cwd: repo.path },
    );
    expect(behind).toBe(false);
  });

  test("returns true when trunk has new commits", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const git = createRealGitRunner();

    await repo.fetch();
    const branch = await repo.branch("feature");
    await repo.commit("feature work");

    // Advance origin/main
    await repo.checkout(repo.defaultBranch);
    await repo.commit("trunk advance");
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
    await repo.checkout(branch);
    await git.run(["fetch", "origin"], { cwd: repo.path });

    const behind = await isStackBehindTrunkForBranch(
      git,
      branch,
      "origin/main",
      { cwd: repo.path },
    );
    expect(behind).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test:docker -- tests/git/behind.test.ts
```

Expected: FAIL — function not exported.

**Step 3: Add `isStackBehindTrunkForBranch` to `src/git/behind.ts`**

Append after the existing `isStackBehindTrunk` function:

```ts
export async function isStackBehindTrunkForBranch(
  git: GitRunner,
  branch: string,
  trunkRef: string,
  options?: BehindOptions,
): Promise<boolean> {
  const result = await git.run(["merge-base", branch, trunkRef], { cwd: options?.cwd });
  const mergeBase = result.stdout.trim();
  const trunkSha = await getFullSha(git, trunkRef, options);
  return mergeBase !== trunkSha;
}
```

**Step 4: Export new symbols from `src/git/index.ts`**

In the `behind.ts` export block, add `isStackBehindTrunkForBranch`:

```ts
export { fetchRemote, isStackBehindTrunk, isStackBehindTrunkForBranch } from "./behind.ts";
```

Also add tracked-branches exports at the end of the file:

```ts
export { loadTrackedBranches, saveTrackedBranches, registerBranch, TRACKED_BRANCHES_REF } from "./tracked-branches.ts";
```

**Step 5: Run tests — expect pass**

```bash
bun run test:docker -- tests/git/behind.test.ts
```

**Step 6: Commit**

```bash
git add src/git/behind.ts src/git/index.ts tests/git/behind.test.ts
git commit -m "feat(git): add isStackBehindTrunkForBranch; export tracked-branches from index"
```

---

### Task 3: Register current branch in sync, group, rebase

**Files:**

- Modify: `src/commands/sync.ts`
- Modify: `src/commands/group.ts`
- Modify: `src/commands/rebase.ts`

Registration is silent — no output. It happens after the clean-working-tree check and after we know we're not in detached HEAD.

**Step 1: Write a test verifying registration in rebaseCommand**

Add a new test to `tests/commands/rebase.test.ts`:

```ts
import { loadTrackedBranches } from "../../src/git/tracked-branches.ts";

// Inside the describe("sp rebase") block:

test("registers current branch in tracked-branches ref", async () => {
  const repo = await makeConfiguredRepo();
  await repo.fetch();
  await repo.branch("tracked-test");
  await repo.commit("some work");

  const git = createRealGitRunner();
  const ctx = makeCtx(repo);
  const logs = captureLogs();
  try {
    await rebaseCommand(ctx, { cwd: repo.path });
  } finally {
    logs.restore();
  }

  const tracked = await loadTrackedBranches(git, { cwd: repo.path });
  expect(tracked).toContain("tracked-test");
});
```

**Step 2: Run to verify it fails**

```bash
bun run test:docker -- tests/commands/rebase.test.ts
```

Expected: the new test fails — "tracked-test" not in tracked list.

**Step 3: Add registration to `src/commands/rebase.ts`**

In `rebaseCommand`, after the detached-HEAD check (line ~27) and before the `requireCleanWorkingTree` call, add:

```ts
import { registerBranch } from "../git/tracked-branches.ts";

// After the isDetachedHead check, inside the non-all path:
const branch = await getCurrentBranch(ctx.git, { cwd });
await registerBranch(ctx.git, branch, { cwd });
```

You already call `getCurrentBranch` later in the function (line ~81). Move that call up so it's reused rather than duplicated.

**Step 4: Add registration to `src/commands/sync.ts`**

After `requireCleanWorkingTree` call (line ~51) and after the `injectMissingIds` success check, add:

```ts
import { registerBranch } from "../git/tracked-branches.ts";
import { getCurrentBranch } from "../git/index.ts";

// After inject.ok check:
const currentBranch = await getCurrentBranch(ctx.git, { cwd });
await registerBranch(ctx.git, currentBranch, { cwd });
```

**Step 5: Add registration to `src/commands/group.ts`**

Read `src/commands/group.ts` first to find the right insertion point (after clean-tree check, before any mutations). Add:

```ts
import { registerBranch } from "../git/tracked-branches.ts";
import { getCurrentBranch } from "../git/index.ts";

// Near top of groupCommand, after requireCleanWorkingTree:
const currentBranch = await getCurrentBranch(ctx.git, { cwd });
await registerBranch(ctx.git, currentBranch, { cwd });
```

**Step 6: Run all rebase tests — expect pass**

```bash
bun run test:docker -- tests/commands/rebase.test.ts
```

**Step 7: Commit**

```bash
git add src/commands/rebase.ts src/commands/sync.ts src/commands/group.ts tests/commands/rebase.test.ts
git commit -m "feat(commands): register current branch in tracked-branches on sync/group/rebase"
```

---

### Task 4: Implement `rebase --all` logic

**Files:**

- Modify: `src/commands/rebase.ts`
- Modify: `tests/commands/rebase.test.ts`

**Step 1: Write failing tests**

Add to `tests/commands/rebase.test.ts`:

```ts
describe("sp rebase --all", () => {
  test("no tracked branches: logs message and exits cleanly", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    await repo.branch("feature-notrack");
    await repo.commit("some work");

    const ctx = makeCtx(repo);
    const logs = captureLogs();
    try {
      await rebaseCommand(ctx, { cwd: repo.path, all: true });
    } finally {
      logs.restore();
    }

    // No tracked branches exist yet — we register current branch then rebase it
    expect(logs.out.join("\n")).toBeTruthy();
    expect(logs.err).toHaveLength(0);
  });

  test("non-current branch behind: updates ref without touching working tree", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    // Create and track feature-other
    const other = await repo.branch("feature-other");
    await repo.commit("other work");
    const origTip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();

    // Register it manually
    const { registerBranch: reg } = await import("../../src/git/tracked-branches.ts");
    await reg(git, other, { cwd: repo.path });

    // Advance main
    await repo.checkout(repo.defaultBranch);
    await repo.commit("trunk advance");
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });

    // Switch to a different branch (so feature-other is NOT current)
    const current = await repo.branch("feature-current");
    await repo.commit("current work");
    const { registerBranch: reg2 } = await import("../../src/git/tracked-branches.ts");
    await reg2(git, current, { cwd: repo.path });

    const ctx = makeCtx(repo);
    const logs = captureLogs();
    const trap = trapExit();
    try {
      await rebaseCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    expect(logs.out.join("\n")).toContain("feature-other");
    expect(logs.out.join("\n")).toContain("Rebased");

    // feature-other ref should have moved
    const newTip = (
      await git.run(["rev-parse", `refs/heads/${other}`], { cwd: repo.path })
    ).stdout.trim();
    expect(newTip).not.toBe(origTip);

    // Working tree should still be on feature-current, clean
    const statusResult = await git.run(["status", "--porcelain"], { cwd: repo.path });
    expect(statusResult.stdout.trim()).toBe("");
    const headBranch = (
      await git.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.path })
    ).stdout.trim();
    expect(headBranch).toBe(current);
  });

  test("branch no longer exists: removes from tracked list", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();
    await repo.branch("feature-alive");
    await repo.commit("some work");

    // Register a branch that doesn't actually exist
    const { registerBranch: reg } = await import("../../src/git/tracked-branches.ts");
    await reg(git, "ghost-branch", { cwd: repo.path });
    await reg(git, "feature-alive", { cwd: repo.path });

    const ctx = makeCtx(repo);
    const logs = captureLogs();
    const trap = trapExit();
    try {
      await rebaseCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(logs.out.join("\n")).toContain("ghost-branch");
    expect(logs.out.join("\n")).toContain("removed");

    const { loadTrackedBranches: load } = await import("../../src/git/tracked-branches.ts");
    const tracked = await load(git, { cwd: repo.path });
    expect(tracked).not.toContain("ghost-branch");
    expect(tracked).toContain("feature-alive");
  });

  test("conflict on one branch: reports error, continues, exits 1", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    // Create conflicting branch
    const conflict = await repo.branch("feature-conflict");
    await repo.commitFiles({ "shared.ts": "feature version\n" }, "feature: add shared");

    // Advance trunk with conflicting file
    await repo.checkout(repo.defaultBranch);
    await repo.commitFiles({ "shared.ts": "trunk version\n" }, "trunk: add shared");
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });

    // Create a clean branch too
    const clean = await repo.branch("feature-clean");
    await repo.commit("clean work");

    const { registerBranch: reg } = await import("../../src/git/tracked-branches.ts");
    await reg(git, conflict, { cwd: repo.path });
    await reg(git, clean, { cwd: repo.path });

    await repo.checkout(clean);

    const ctx = makeCtx(repo);
    const logs = captureLogs();
    const trap = trapExit();
    try {
      await rebaseCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    const errText = logs.err.join("\n");
    expect(errText).toContain("feature-conflict");
    expect(errText).toContain("conflict");
    // Clean branch still processed
    expect(logs.out.join("\n")).toContain("feature-clean");
  });
});
```

**Step 2: Run to verify they fail**

```bash
bun run test:docker -- tests/commands/rebase.test.ts
```

Expected: FAIL — `all` option not recognized.

**Step 3: Implement `--all` in `src/commands/rebase.ts`**

Add `all?: boolean` to `RebaseOptions` and implement a `rebaseAllCommand` helper. The single-branch path is unchanged. Here is the full updated structure:

```ts
import type { SpryContext } from "../lib/context.ts";
import {
  loadConfig,
  trunkRef,
  getStackCommits,
  getStackCommitsForBranch,
  getCurrentBranch,
  getFullSha,
  getCommitMessage,
  updateRef,
} from "../git/index.ts";
import { isDetachedHead } from "../git/queries.ts";
import { requireCleanWorkingTree } from "../git/status.ts";
import { rebasePlumbing, finalizeRewrite } from "../git/plumbing.ts";
import { parseConflictOutput } from "../git/conflict.ts";
import { fetchRemote, isStackBehindTrunk, isStackBehindTrunkForBranch } from "../git/behind.ts";
import { registerBranch, loadTrackedBranches, saveTrackedBranches } from "../git/tracked-branches.ts";
import type { SpryConfig } from "../git/config.ts";

export interface RebaseOptions {
  cwd?: string;
  all?: boolean;
}

export async function rebaseCommand(ctx: SpryContext, opts: RebaseOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });

  if (opts.all) {
    return rebaseAllCommand(ctx, config, cwd);
  }

  // --- single-branch path ---

  if (await isDetachedHead(ctx.git, { cwd })) {
    console.error("✗ Cannot rebase from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }

  await requireCleanWorkingTree(ctx.git, { cwd });

  const branch = await getCurrentBranch(ctx.git, { cwd });
  await registerBranch(ctx.git, branch, { cwd });

  const ref = trunkRef(config);

  const fetchResult = await fetchRemote(ctx.git, config.remote, { cwd });
  if (!fetchResult.ok) {
    console.error(`✗ Could not fetch from ${config.remote}: ${fetchResult.stderr.trim()}`);
    process.exit(1);
  }

  const behind = await isStackBehindTrunk(ctx.git, ref, { cwd });
  if (!behind) {
    console.log("✓ Already up to date");
    return;
  }

  const commits = await getStackCommits(ctx.git, ref, { cwd });
  if (commits.length === 0) {
    console.log("✓ No commits in stack");
    return;
  }

  const ontoSha = await getFullSha(ctx.git, ref, { cwd });
  const commitHashes = commits.map((c) => c.hash);

  const result = await rebasePlumbing(ctx.git, ontoSha, commitHashes, { cwd });

  if (!result.ok) {
    const parsed = parseConflictOutput(result.conflictInfo);
    const shortSha = result.conflictCommit.slice(0, 8);
    const msg = await getCommitMessage(ctx.git, result.conflictCommit, { cwd });
    const subject = msg.split("\n")[0] ?? result.conflictCommit;
    console.error(`✗ Rebase would conflict on commit ${shortSha}: ${subject}`);
    if (parsed.files.length > 0) {
      console.error("");
      console.error("  Conflicting files:");
      for (const f of parsed.files) {
        console.error(`    - ${f}`);
      }
    }
    console.error("");
    console.error("  Resolve the upstream changes manually, then run `sp rebase` again.");
    console.error("  Or use `git rebase` for interactive conflict resolution.");
    process.exit(1);
  }

  const oldTip = commitHashes.at(-1) ?? "";
  await finalizeRewrite(ctx.git, branch, oldTip, result.newTip, { cwd });

  const n = commits.length;
  console.log(`✓ Rebased ${n} commit${n === 1 ? "" : "s"} onto ${config.trunk}`);
}

async function rebaseAllCommand(
  ctx: SpryContext,
  config: SpryConfig,
  cwd: string | undefined,
): Promise<void> {
  await requireCleanWorkingTree(ctx.git, { cwd });

  const fetchResult = await fetchRemote(ctx.git, config.remote, { cwd });
  if (!fetchResult.ok) {
    console.error(`✗ Could not fetch from ${config.remote}: ${fetchResult.stderr.trim()}`);
    process.exit(1);
  }

  // Register current branch (unless detached), then load full tracked list
  const currentBranch = (await isDetachedHead(ctx.git, { cwd }))
    ? null
    : await getCurrentBranch(ctx.git, { cwd });

  if (currentBranch) {
    await registerBranch(ctx.git, currentBranch, { cwd });
  }

  const tracked = await loadTrackedBranches(ctx.git, { cwd });
  if (tracked.length === 0) {
    console.log("✓ No tracked branches");
    return;
  }

  const ref = trunkRef(config);
  const stillTracked: string[] = [];
  let hadFailure = false;

  for (const branch of tracked) {
    // Check if branch still exists
    const revParse = await ctx.git.run(
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      { cwd },
    );
    if (revParse.exitCode !== 0) {
      console.log(`${branch}: removed (branch no longer exists)`);
      continue;
    }

    stillTracked.push(branch);

    const behind = await isStackBehindTrunkForBranch(ctx.git, branch, ref, { cwd });
    if (!behind) {
      console.log(`${branch}: ✓ already up to date`);
      continue;
    }

    const commits = await getStackCommitsForBranch(ctx.git, branch, ref, { cwd });
    if (commits.length === 0) {
      console.log(`${branch}: ✓ no commits in stack`);
      continue;
    }

    const ontoSha = await getFullSha(ctx.git, ref, { cwd });
    const commitHashes = commits.map((c) => c.hash);
    const result = await rebasePlumbing(ctx.git, ontoSha, commitHashes, { cwd });

    if (!result.ok) {
      const parsed = parseConflictOutput(result.conflictInfo);
      const shortSha = result.conflictCommit.slice(0, 8);
      const msg = await getCommitMessage(ctx.git, result.conflictCommit, { cwd });
      const subject = msg.split("\n")[0] ?? result.conflictCommit;
      console.error(`${branch}: ✗ Rebase would conflict on commit ${shortSha}: ${subject}`);
      if (parsed.files.length > 0) {
        for (const f of parsed.files) {
          console.error(`  - ${f}`);
        }
      }
      hadFailure = true;
      continue;
    }

    const oldTip = commitHashes.at(-1) ?? "";
    if (branch === currentBranch) {
      await finalizeRewrite(ctx.git, branch, oldTip, result.newTip, { cwd });
    } else {
      await updateRef(ctx.git, `refs/heads/${branch}`, result.newTip, oldTip, { cwd });
    }

    const n = commits.length;
    console.log(`${branch}: ✓ Rebased ${n} commit${n === 1 ? "" : "s"} onto ${config.trunk}`);
  }

  await saveTrackedBranches(ctx.git, stillTracked, { cwd });

  if (hadFailure) {
    process.exit(1);
  }
}
```

**Step 4: Run tests — expect pass**

```bash
bun run test:docker -- tests/commands/rebase.test.ts
```

**Step 5: Commit**

```bash
git add src/commands/rebase.ts tests/commands/rebase.test.ts
git commit -m "feat(rebase): implement sp rebase --all with branch tracking"
```

---

### Task 5: Wire `--all` flag in CLI

**Files:**

- Modify: `src/cli/index.ts`

**Step 1: Update the `rebase` command in `src/cli/index.ts`**

Replace:

```ts
program
  .command("rebase")
  .description("Fetch, check if behind trunk, and rebase the stack if clean")
  .action(() => rebaseCommand(ctx));
```

With:

```ts
program
  .command("rebase")
  .description("Fetch, check if behind trunk, and rebase the stack if clean")
  .option("--all", "Rebase all tracked branches")
  .action((opts: { all?: boolean }) => rebaseCommand(ctx, { all: opts.all }));
```

**Step 2: Run the full test suite**

```bash
bun run test:docker
```

Expected: all existing tests still pass.

**Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): wire --all flag for sp rebase"
```

---

### Task 6: Doc tests for `sp rebase --all`

**Files:**

- Modify: `tests/commands/rebase.doc.test.ts`

**Step 1: Add doc tests**

Add a new `describe("sp rebase --all docs")` block:

```ts
describe("sp rebase --all docs", () => {
  docTest(
    "All branches already up to date",
    { section: "commands/rebase", order: 40 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.fetch();
      const feature = await repo.branch("feature");
      await git.run(["commit", "--allow-empty", "-m", "Add feature\n\nSpry-Commit-Id: bbb22222"], {
        cwd: repo.path,
      });

      // Register the branch by running sp rebase once (it will be up to date)
      await runSp(repo.path, "rebase");

      doc.prose(
        "When all tracked branches are already based on the latest trunk, `sp rebase --all` reports each one as up to date:",
      );

      const { command, result } = await runSp(repo.path, "rebase", "--all");
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("already up to date");
    },
  );

  docTest(
    "Rebasing multiple branches",
    { section: "commands/rebase", order: 50 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.fetch();

      // Create feature-one and register it
      const featureOne = await repo.branch("feature-one");
      await git.run(["commit", "--allow-empty", "-m", "Add feature one\n\nSpry-Commit-Id: ccc33333"], {
        cwd: repo.path,
      });
      await runSp(repo.path, "rebase"); // registers feature-one

      // Create feature-two and register it
      const featureTwo = await repo.branch("feature-two");
      await git.run(["commit", "--allow-empty", "-m", "Add feature two\n\nSpry-Commit-Id: ddd44444"], {
        cwd: repo.path,
      });
      await runSp(repo.path, "rebase"); // registers feature-two

      // Advance main on remote (different file — no conflict)
      await repo.checkout(repo.defaultBranch);
      await git.run(["commit", "--allow-empty", "-m", "Bump dependencies"], { cwd: repo.path });
      await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
      await repo.checkout(featureTwo);

      doc.prose(
        "When multiple tracked branches are behind trunk, `sp rebase --all` rebases each one — no checkout required:",
      );

      const { command, result } = await runSp(repo.path, "rebase", "--all");
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("feature-one");
      expect(result.stdout).toContain("feature-two");
    },
  );
});
```

Note: check how `createRunner` calls work — `runSp(repo.path, "rebase", "--all")` may need to pass args differently. Look at how other tests call `runSp` with multiple args and match that pattern.

**Step 2: Run doc tests**

```bash
bun run test:docker -- tests/commands/rebase.doc.test.ts
```

Expected: pass.

**Step 3: Commit**

```bash
git add tests/commands/rebase.doc.test.ts
git commit -m "docs(rebase): add doc tests for sp rebase --all"
```

---

### Task 7: Update changelog

**Files:**

- Modify: `CHANGELOG.md`

Add an entry under the current unreleased section:

```markdown
- `sp rebase --all`: rebases all tracked branches onto trunk in one command. Branches are automatically tracked whenever `sp sync`, `sp group`, or `sp rebase` is run. Branches that no longer exist are removed from the tracking list. Tracking metadata is stored locally in `refs/spry/local/tracked-branches` and is never pushed to the remote.
```

**Commit:**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): add sp rebase --all entry"
```
