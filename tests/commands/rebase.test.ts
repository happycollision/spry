import { describe, test, expect, afterEach } from "bun:test";
import { rebaseCommand } from "../../src/commands/rebase.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { SpryContext, TestRepo } from "../lib/index.ts";
import { registerBranch, loadTrackedBranches } from "../../src/git/tracked-branches.ts";

const repos: TestRepo[] = [];

afterEach(async () => {
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

function captureLogs(): { restore: () => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  return {
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
    out,
    err,
  };
}

function trapExit(): { exitCode: number | undefined; restore: () => void } {
  const state: { exitCode: number | undefined } = { exitCode: undefined };
  const origExit = process.exit;
  // @ts-ignore
  process.exit = (code: number) => {
    state.exitCode = code;
    throw new Error("process.exit");
  };
  return {
    get exitCode() {
      return state.exitCode;
    },
    restore: () => {
      // @ts-ignore
      process.exit = origExit;
    },
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
    const logs = captureLogs();
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
    const logs = captureLogs();
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
    const logs = captureLogs();
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
    const logs = captureLogs();
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
    const logs = captureLogs();
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
