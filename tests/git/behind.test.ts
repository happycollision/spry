import { test, expect, describe, afterEach } from "bun:test";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import type { TestRepo } from "../../tests/lib/index.ts";
import { fetchRemote, isStackBehindTrunk } from "../../src/git/behind.ts";

const git = createRealGitRunner();

const repos: TestRepo[] = [];
afterEach(async () => {
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
