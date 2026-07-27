import { test, expect, describe, afterAll } from "bun:test";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import type { TestRepo } from "../../tests/lib/index.ts";
import {
  fetchRemote,
  syncFetchRefspecs,
  isStackBehindTrunk,
  isStackBehindTrunkForBranch,
} from "../../src/git/behind.ts";

const git = createRealGitRunner();

const repos: TestRepo[] = [];
// afterAll, not afterEach: under --concurrent a per-test cleanup hook would delete
// repos out from under still-running sibling tests.
afterAll(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

describe("fetchRemote", () => {
  test("fetches from the remote and returns ok:true", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const result = await fetchRemote(git, "origin", { cwd: repo.path });
    expect(result.ok).toBe(true);
  });

  test("returns ok:false when remote does not exist", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const result = await fetchRemote(git, "no-such-remote", { cwd: repo.path });
    expect(result.ok).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("narrowed refspecs update only trunk + the spry prefix, not other branches", async () => {
    const repo = await createRepo();
    repos.push(repo);
    await repo.fetch();

    // Push two remote branches: one under the spry prefix (should be fetched)
    // and one unrelated `feature/*` (should NOT be, under the narrowed fetch).
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/aaa11111`], { cwd: repo.path });
    await git.run(["push", "origin", `${head}:refs/heads/feature/unrelated`], { cwd: repo.path });
    // Drop any remote-tracking refs a prior bare fetch created, so the assertion
    // reflects only what the narrowed fetch pulls.
    await git.run(["remote", "prune", "origin"], { cwd: repo.path });
    await git.run(["update-ref", "-d", "refs/remotes/origin/feature/unrelated"], {
      cwd: repo.path,
    });
    await git.run(["update-ref", "-d", "refs/remotes/origin/spry/test/aaa11111"], {
      cwd: repo.path,
    });

    const result = await fetchRemote(git, "origin", {
      cwd: repo.path,
      refspecs: syncFetchRefspecs("origin", "main", "spry/test"),
    });
    expect(result.ok).toBe(true);

    // Trunk + the spry-prefixed branch are now tracked...
    const trunk = await git.run(["rev-parse", "--verify", "refs/remotes/origin/main"], {
      cwd: repo.path,
    });
    expect(trunk.exitCode).toBe(0);
    const spryRef = await git.run(
      ["rev-parse", "--verify", "refs/remotes/origin/spry/test/aaa11111"],
      { cwd: repo.path },
    );
    expect(spryRef.exitCode).toBe(0);

    // ...but the unrelated feature branch was not pulled.
    const unrelated = await git.run(
      ["rev-parse", "--verify", "refs/remotes/origin/feature/unrelated"],
      { cwd: repo.path },
    );
    expect(unrelated.exitCode).not.toBe(0);
  });
});

describe("syncFetchRefspecs", () => {
  test("builds force refspecs for trunk and the branch prefix", () => {
    expect(syncFetchRefspecs("origin", "main", "spry/test")).toEqual([
      "+refs/heads/main:refs/remotes/origin/main",
      "+refs/heads/spry/test/*:refs/remotes/origin/spry/test/*",
    ]);
  });

  test("honors non-default remote and trunk names", () => {
    expect(syncFetchRefspecs("upstream", "trunk", "sp/dev")).toEqual([
      "+refs/heads/trunk:refs/remotes/upstream/trunk",
      "+refs/heads/sp/dev/*:refs/remotes/upstream/sp/dev/*",
    ]);
  });
});

describe("isStackBehindTrunk", () => {
  test("returns false when stack is up to date with trunk", async () => {
    const repo = await createRepo();
    repos.push(repo);
    await repo.fetch();

    await repo.branch("feature-uptodate");
    await repo.commit("feature commit");

    const behind = await isStackBehindTrunk(git, "origin/main", { cwd: repo.path });
    expect(behind).toBe(false);
  });

  test("returns true when trunk has advanced past stack base", async () => {
    const repo = await createRepo();
    repos.push(repo);
    await repo.fetch();

    const featureBranch = await repo.branch("feature-behind");
    await repo.commit("feature commit");

    // Advance origin/main: check out main, commit, push, check out feature again
    await repo.checkout(repo.defaultBranch);
    await repo.commit("trunk advances");
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
    await repo.checkout(featureBranch);
    await repo.fetch();

    const behind = await isStackBehindTrunk(git, "origin/main", { cwd: repo.path });
    expect(behind).toBe(true);
  });
});

describe("isStackBehindTrunkForBranch", () => {
  test("returns false when branch merge-base equals trunk tip", async () => {
    const repo = await createRepo();
    repos.push(repo);

    await repo.fetch();
    const branch = await repo.branch("feature");
    await repo.commit("feature work");
    // origin/main has NOT advanced — branch is up to date

    const behind = await isStackBehindTrunkForBranch(git, branch, "origin/main", {
      cwd: repo.path,
    });
    expect(behind).toBe(false);
  });

  test("returns true when trunk has new commits", async () => {
    const repo = await createRepo();
    repos.push(repo);

    await repo.fetch();
    const branch = await repo.branch("feature");
    await repo.commit("feature work");

    // Advance origin/main
    await repo.checkout(repo.defaultBranch);
    await repo.commit("trunk advance");
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
    await repo.checkout(branch);
    await git.run(["fetch", "origin"], { cwd: repo.path });

    const behind = await isStackBehindTrunkForBranch(git, branch, "origin/main", {
      cwd: repo.path,
    });
    expect(behind).toBe(true);
  });
});
