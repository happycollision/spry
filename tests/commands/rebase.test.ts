import { describe, test, expect, afterAll } from "bun:test";
import { rebaseCommand } from "../../src/commands/rebase.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import { captureLogs, trapExit } from "../lib/capture.ts";
import type { SpryContext, TestRepo } from "../lib/index.ts";
import { registerBranch, loadTrackedBranches } from "../../src/git/tracked-branches.ts";

const repos: TestRepo[] = [];

// afterAll, not afterEach: under --concurrent a per-test cleanup hook would delete
// repos out from under still-running sibling tests.
afterAll(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

function makeCtx(repo: TestRepo): SpryContext {
  const git = createRealGitRunner();
  return {
    git: { run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }) },
    gh: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
  };
}

async function makeConfiguredRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
  return repo;
}

describe("sp rebase", () => {
  test("up to date: logs message without rebasing", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const featureBranch = await repo.branch("feature-utd");
    await repo.commit("my feature");
    // origin/main has NOT advanced — stack is up to date

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    try {
      await rebaseCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }

    expect(logs.out.join("\n")).toContain("Already up to date");
    expect(logs.err).toHaveLength(0);
    // Branch tip should be unchanged
    const git = createRealGitRunner();
    const branch = (
      await git.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.path })
    ).stdout.trim();
    expect(branch).toBe(featureBranch);
  });

  test("behind, no conflicts: rebases commits onto trunk", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const featureBranch = await repo.branch("feature-clean");
    await repo.commit("feature work");

    // Advance origin/main (different file — no conflict)
    await repo.checkout(repo.defaultBranch);
    await repo.commit("trunk advance");
    const git = createRealGitRunner();
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
    await repo.checkout(featureBranch);

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await rebaseCommand(ctx, { cwd: repo.path });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined(); // no exit
    expect(logs.out.join("\n")).toContain("Rebased 1 commit");
    expect(logs.err).toHaveLength(0);

    // Verify the branch was actually rebased: HEAD should now be ahead of origin/main
    const newBase = (
      await git.run(["merge-base", "HEAD", "origin/main"], { cwd: repo.path })
    ).stdout.trim();
    const trunkTip = (
      await git.run(["rev-parse", "origin/main"], { cwd: repo.path })
    ).stdout.trim();
    expect(newBase).toBe(trunkTip);
  });

  test("behind with conflict: prints conflict info and exits 1", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const featureBranch = await repo.branch("feature-conflict");
    // Feature adds shared.ts
    await repo.commitFiles({ "shared.ts": "feature version\n" }, "feature: add shared.ts");

    // Trunk also adds shared.ts with different content
    await repo.checkout(repo.defaultBranch);
    await repo.commitFiles({ "shared.ts": "trunk version\n" }, "trunk: add shared.ts");
    const git = createRealGitRunner();
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
    await repo.checkout(featureBranch);

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await rebaseCommand(ctx, { cwd: repo.path });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    const errText = logs.err.join("\n");
    expect(errText).toContain("conflict");
    // Working tree should be unchanged — no partial rebase
    const statusResult = await git.run(["status", "--porcelain"], { cwd: repo.path });
    expect(statusResult.stdout.trim()).toBe("");
  });

  test("registers current branch in tracked-branches ref", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const branchName = await repo.branch("tracked-test");
    await repo.commit("some work");

    const git = createRealGitRunner();
    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    try {
      await rebaseCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }

    const tracked = await loadTrackedBranches(git, { cwd: repo.path });
    expect(tracked).toContain(branchName);
  });

  test("detached HEAD: prints error and exits 1", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const git = createRealGitRunner();
    // Detach HEAD
    const sha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["checkout", sha], { cwd: repo.path });

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await rebaseCommand(ctx, { cwd: repo.path });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    expect(logs.err.join("\n").toLowerCase()).toContain("detached");
  });
});

describe("sp rebase --all", () => {
  test("with no pre-existing tracked branches: registers current branch and reports up to date", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    await repo.branch("feature-notrack");
    await repo.commit("some work");

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
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
    // Should have registered and reported feature-notrack as up to date
    expect(logs.out.join("\n")).toContain("feature-notrack");
  });

  test("non-current branch behind: updates ref without touching working tree", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    // Create feature-other, register it
    const other = await repo.branch("feature-other");
    await repo.commitFiles({ "other.ts": "feature\n" }, "other work\n\nSpry-Commit-Id: aaa11111");
    const origTip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await registerBranch(git, other, { cwd: repo.path });

    // Advance main
    await repo.checkout(repo.defaultBranch);
    await repo.commit("trunk advance");
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });

    // Switch to a different branch (so feature-other is NOT current)
    const current = await repo.branch("feature-current");
    await repo.commit("current work");
    await registerBranch(git, current, { cwd: repo.path });

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
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

    // Working tree still on feature-current, clean
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
    const aliveBranch = await repo.branch("feature-alive");
    await repo.commit("some work");

    // Register a branch that doesn't actually exist
    await registerBranch(git, "ghost-branch", { cwd: repo.path });
    await registerBranch(git, aliveBranch, { cwd: repo.path });

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
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

    const tracked = await loadTrackedBranches(git, { cwd: repo.path });
    expect(tracked).not.toContain("ghost-branch");
    expect(tracked).toContain(aliveBranch);
  });

  test("conflict on one branch: reports error, continues to next branch, exits 1", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    // Create conflicting branch
    const conflict = await repo.branch("feature-conflict");
    await repo.commitFiles(
      { "shared.ts": "feature version\n" },
      "feature: add shared\n\nSpry-Commit-Id: bbb22222",
    );

    // Advance trunk with conflicting file
    await repo.checkout(repo.defaultBranch);
    await repo.commitFiles({ "shared.ts": "trunk version\n" }, "trunk: add shared");
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });

    // Create a clean branch too
    const clean = await repo.branch("feature-clean");
    await repo.commitFiles({ "clean.ts": "clean\n" }, "clean work\n\nSpry-Commit-Id: ccc33333");

    await registerBranch(git, conflict, { cwd: repo.path });
    await registerBranch(git, clean, { cwd: repo.path });

    await repo.checkout(clean);

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
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

describe("sp rebase --all: local default branch", () => {
  // Push a new commit to origin/main and leave the local default branch one
  // commit behind it. Returns { originTip, localTip } where localTip is the
  // (older) tip local main now points at.
  async function makeDefaultBranchBehind(
    repo: TestRepo,
  ): Promise<{ originTip: string; localTip: string }> {
    const git = createRealGitRunner();
    const localTip = (
      await git.run(["rev-parse", repo.defaultBranch], { cwd: repo.path })
    ).stdout.trim();
    // Advance origin/main by one commit, then move local main back so it trails.
    await repo.commit("trunk advance");
    const originTip = (
      await git.run(["rev-parse", "HEAD"], { cwd: repo.path })
    ).stdout.trim();
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
    await git.run(["reset", "--hard", localTip], { cwd: repo.path });
    await repo.fetch();
    return { originTip, localTip };
  }

  test("checked-out default branch behind: fast-forwards ref and working tree", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const git = createRealGitRunner();
    const { originTip, localTip } = await makeDefaultBranchBehind(repo);

    // Sitting on main (checked out), behind origin/main.
    expect(await repo.currentBranch()).toBe(repo.defaultBranch);
    const beforeTip = (
      await git.run(["rev-parse", repo.defaultBranch], { cwd: repo.path })
    ).stdout.trim();
    expect(beforeTip).toBe(localTip);

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
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
    // Local main fast-forwarded to origin/main.
    const afterTip = (
      await git.run(["rev-parse", repo.defaultBranch], { cwd: repo.path })
    ).stdout.trim();
    expect(afterTip).toBe(originTip);
    // Working tree updated (still on main, clean).
    expect(await repo.currentBranch()).toBe(repo.defaultBranch);
    const status = await git.run(["status", "--porcelain"], { cwd: repo.path });
    expect(status.stdout.trim()).toBe("");
    // The default branch was not persisted into the tracked store.
    const tracked = await loadTrackedBranches(git, { cwd: repo.path });
    expect(tracked).not.toContain(repo.defaultBranch);
  });

  test("default branch behind while a different branch is checked out: fast-forwards ref only", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const git = createRealGitRunner();
    const { originTip } = await makeDefaultBranchBehind(repo);

    // Move onto a feature branch built off origin/main (already up to date), so
    // the ONLY branch that needs moving is the background default branch. This
    // isolates the updateRef fast-forward path (main is not the checked-out
    // branch, so its working tree stays put).
    const feature = await repo.branch("feature-elsewhere");
    await git.run(["reset", "--hard", "origin/main"], { cwd: repo.path });
    await repo.commitFiles(
      { "elsewhere.ts": "work\n" },
      "elsewhere\n\nSpry-Commit-Id: eee55555",
    );
    const featureTip = (
      await git.run(["rev-parse", "HEAD"], { cwd: repo.path })
    ).stdout.trim();

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
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
    // Local main fast-forwarded to origin/main via the updateRef path (main was
    // not the checked-out branch).
    const afterMain = (
      await git.run(["rev-parse", repo.defaultBranch], { cwd: repo.path })
    ).stdout.trim();
    expect(afterMain).toBe(originTip);
    expect(logs.out.join("\n")).toContain("Fast-forwarded");
    // Still on the feature branch, tip unchanged (it was already up to date),
    // working tree clean.
    expect(await repo.currentBranch()).toBe(feature);
    const afterHead = (
      await git.run(["rev-parse", "HEAD"], { cwd: repo.path })
    ).stdout.trim();
    expect(afterHead).toBe(featureTip);
    const status = await git.run(["status", "--porcelain"], { cwd: repo.path });
    expect(status.stdout.trim()).toBe("");
  });

  test("default branch already up to date: no ref change", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const git = createRealGitRunner();
    const beforeTip = (
      await git.run(["rev-parse", repo.defaultBranch], { cwd: repo.path })
    ).stdout.trim();

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
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
    expect(logs.out.join("\n")).toContain("up to date");
    const afterTip = (
      await git.run(["rev-parse", repo.defaultBranch], { cwd: repo.path })
    ).stdout.trim();
    expect(afterTip).toBe(beforeTip);
  });

  test("default branch behind and a stack branch behind: both handled in one run", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const git = createRealGitRunner();

    // Build a feature branch with a real stack commit off the current main.
    const feature = await repo.branch("feature-stack");
    await repo.commitFiles(
      { "stack.ts": "stack\n" },
      "stack work\n\nSpry-Commit-Id: fff66666",
    );
    const featureOrigTip = (
      await git.run(["rev-parse", "HEAD"], { cwd: repo.path })
    ).stdout.trim();
    await registerBranch(git, feature, { cwd: repo.path });

    // Advance origin/main (different file, no conflict) and leave local main behind.
    await repo.checkout(repo.defaultBranch);
    const localMainTip = (
      await git.run(["rev-parse", repo.defaultBranch], { cwd: repo.path })
    ).stdout.trim();
    await repo.commit("trunk advance");
    const originTip = (
      await git.run(["rev-parse", "HEAD"], { cwd: repo.path })
    ).stdout.trim();
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
    await git.run(["reset", "--hard", localMainTip], { cwd: repo.path });
    await repo.fetch();

    // Stay on main so the stack branch is a background rebase.
    const ctx = makeCtx(repo);
    const logs = await captureLogs();
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
    // Default branch fast-forwarded.
    const afterMain = (
      await git.run(["rev-parse", repo.defaultBranch], { cwd: repo.path })
    ).stdout.trim();
    expect(afterMain).toBe(originTip);
    // Stack branch rebased onto the new origin/main (ref moved, now based on trunk).
    const afterFeature = (
      await git.run(["rev-parse", `refs/heads/${feature}`], { cwd: repo.path })
    ).stdout.trim();
    expect(afterFeature).not.toBe(featureOrigTip);
    const featureBase = (
      await git.run(["merge-base", `refs/heads/${feature}`, "origin/main"], { cwd: repo.path })
    ).stdout.trim();
    expect(featureBase).toBe(originTip);
  });

  test("bare sp rebase on the default branch: unchanged no-op", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();
    const git = createRealGitRunner();
    const { localTip } = await makeDefaultBranchBehind(repo);

    // Bare rebase (no --all), sitting on main behind origin/main.
    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await rebaseCommand(ctx, { cwd: repo.path });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    // Local main is NOT moved by bare rebase — still at the old tip.
    const afterTip = (
      await git.run(["rev-parse", repo.defaultBranch], { cwd: repo.path })
    ).stdout.trim();
    expect(afterTip).toBe(localTip);
  });
});
