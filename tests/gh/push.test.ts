import { describe, test, expect, afterEach } from "bun:test";
import { pushBranch, listRemoteBranches } from "../../src/gh/push.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];

afterEach(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  return repo;
}

describe("pushBranch", () => {
  test("pushes a commit to a new remote ref", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha = await repo.commit("Work");

    const result = await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    expect(result.ok).toBe(true);

    const ls = await git.run(["ls-remote", "--heads", "origin", "spry/test/aaa11111"], {
      cwd: repo.path,
    });
    expect(ls.stdout).toContain("spry/test/aaa11111");
  });

  test("force-with-lease succeeds when local has the latest remote tip", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha1 = await repo.commit("v1");
    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha: sha1,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    const sha2 = await repo.commit("v2");
    const result = await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha: sha2,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    expect(result.ok).toBe(true);
  });

  test("force-with-lease rejects when remote diverged", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha1 = await repo.commit("v1");
    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha: sha1,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });

    // Simulate someone else pushing — write directly to bare repo's ref
    const otherSha = (await git.run(["rev-parse", "HEAD~1"], { cwd: repo.path })).stdout.trim();
    await git.run(["update-ref", "refs/heads/spry/test/aaa11111", otherSha], {
      cwd: repo.originPath,
    });

    const sha2 = await repo.commit("v2");
    const result = await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha: sha2,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stale-ref");
    }
  });

  test("returns reason: 'rejected' for non-stale rejections (e.g. hook decline)", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha = await repo.commit("Work");

    // Install a pre-receive hook in the bare origin that always rejects
    const hookPath = `${repo.originPath}/hooks/pre-receive`;
    await Bun.write(hookPath, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
    // chmod via fs (Bun.write doesn't preserve exec bit)
    const { chmod } = await import("node:fs/promises");
    await chmod(hookPath, 0o755);

    const result = await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rejected");
      expect(result.stderr).toMatch(/hook|declined/i);
    }
  });
});

describe("listRemoteBranches", () => {
  test("returns only branches under the given prefix", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha = await repo.commit("Work");

    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "spry/test/bbb22222",
      forceWithLease: true,
    });
    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "other/zzz",
      forceWithLease: true,
    });

    const set = await listRemoteBranches(git, "origin", "spry/test", { cwd: repo.path });
    expect(set.has("spry/test/aaa11111")).toBe(true);
    expect(set.has("spry/test/bbb22222")).toBe(true);
    expect(set.has("other/zzz")).toBe(false);
  });

  test("returns empty set when no matching branches exist", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha = await repo.commit("Work");
    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "other/zzz",
      forceWithLease: true,
    });
    const set = await listRemoteBranches(git, "origin", "spry/nope", { cwd: repo.path });
    expect(set.size).toBe(0);
  });
});
