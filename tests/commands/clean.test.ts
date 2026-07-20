import { describe, test, expect, afterAll } from "bun:test";
import { cleanCommand } from "../../src/commands/clean.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import { captureLogs, trapExit } from "../lib/capture.ts";
import type { SpryContext, TestRepo } from "../lib/index.ts";

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

/** Push the given SHA to `origin <prefix>/<name>` (a remote spry branch). */
async function pushSpryBranch(repo: TestRepo, name: string, sha: string): Promise<void> {
  const git = createRealGitRunner();
  await git.run(["push", "origin", `${sha}:refs/heads/spry/test/${name}`], { cwd: repo.path });
}

/** True if `origin spry/test/<name>` still exists on the remote. */
async function remoteSpryBranchExists(repo: TestRepo, name: string): Promise<boolean> {
  const git = createRealGitRunner();
  const result = await git.run(["ls-remote", "--heads", "origin", `spry/test/${name}`], {
    cwd: repo.path,
  });
  return result.stdout.trim() !== "";
}

describe("sp clean", () => {
  test("deletes a remote spry branch whose tip is an ancestor of trunk", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    // Advance main on the remote with a "landed" commit.
    await repo.commit("landed work");
    const landedSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", "main"], { cwd: repo.path });

    // The spry branch points at that landed commit → ancestor of origin/main.
    await pushSpryBranch(repo, "landed", landedSha);
    expect(await remoteSpryBranchExists(repo, "landed")).toBe(true);

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    try {
      await cleanCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }

    expect(logs.out.join("\n")).toContain("spry/test/landed");
    expect(logs.err).toHaveLength(0);
    expect(await remoteSpryBranchExists(repo, "landed")).toBe(false);
  });

  test("leaves a remote spry branch that is NOT an ancestor of trunk alone", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    // An unlanded commit that never reaches origin/main.
    await repo.branch("feature");
    await repo.commit("unlanded work");
    const unlandedSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await pushSpryBranch(repo, "unlanded", unlandedSha);
    expect(await remoteSpryBranchExists(repo, "unlanded")).toBe(true);

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    try {
      await cleanCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }

    expect(logs.out.join("\n")).toContain("No landed branches");
    expect(await remoteSpryBranchExists(repo, "unlanded")).toBe(true);
  });

  test("--dry-run lists landed branches but deletes nothing", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    await repo.commit("landed work");
    const landedSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", "main"], { cwd: repo.path });
    await pushSpryBranch(repo, "landed", landedSha);

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    try {
      await cleanCommand(ctx, { cwd: repo.path, dryRun: true });
    } finally {
      logs.restore();
    }

    expect(logs.out.join("\n")).toContain("spry/test/landed");
    expect(logs.out.join("\n").toLowerCase()).toContain("would delete");
    // Nothing actually removed.
    expect(await remoteSpryBranchExists(repo, "landed")).toBe(true);
  });

  test("stale tracking ref for an upstream-deleted branch is pruned, not a failure", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    // A landed commit pushed to main AND to a spry branch.
    await repo.commit("landed work");
    const landedSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", "main"], { cwd: repo.path });
    await pushSpryBranch(repo, "landed", landedSha);

    // Populate the local tracking ref, then delete the branch upstream behind
    // our back (simulating a teammate / prior clean). The stale tracking ref
    // refs/remotes/origin/spry/test/landed now points at a branch that is gone.
    await repo.fetch();
    await git.run(["push", "origin", "--delete", "spry/test/landed"], { cwd: repo.path });
    expect(await remoteSpryBranchExists(repo, "landed")).toBe(false);

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await cleanCommand(ctx, { cwd: repo.path });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    // Prune drops the stale ref, so clean finds nothing — no spurious failure.
    expect(trap.exitCode).toBeUndefined();
    expect(logs.err).toHaveLength(0);
  });

  test("genuine delete failure: warns, continues the sweep, exits 1", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    // Two landed branches: one delete will fail, the other will succeed.
    await repo.commit("landed work");
    const landedSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", "main"], { cwd: repo.path });
    await pushSpryBranch(repo, "bad", landedSha);
    await pushSpryBranch(repo, "good", landedSha);

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    const trap = trapExit();
    // Inject a delete fn: a non-benign failure for "bad", success for "good".
    const deleteBranch = async (branch: string) => {
      if (branch.endsWith("/bad")) {
        return { ok: false as const, stderr: "remote: Permission to repo denied" };
      }
      return { ok: true as const };
    };
    try {
      await cleanCommand(ctx, { cwd: repo.path, deleteBranch });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    const errText = logs.err.join("\n");
    expect(errText).toContain("spry/test/bad");
    expect(errText).toContain("Permission");
    // The sweep continued: the good branch was still deleted.
    expect(logs.out.join("\n")).toContain("Deleted spry/test/good");
  });

  test("no landed branches: reports clean and exits without error", async () => {
    const repo = await makeConfiguredRepo();
    await repo.fetch();

    const ctx = makeCtx(repo);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await cleanCommand(ctx, { cwd: repo.path });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    expect(logs.out.join("\n")).toContain("No landed branches");
    expect(logs.err).toHaveLength(0);
  });
});
