import { test, expect, describe } from "bun:test";
import { createRealGitRunner, repoManager } from "../../tests/lib/index.ts";
import {
  getCurrentBranch,
  isDetachedHead,
  hasUncommittedChanges,
  getFullSha,
  getShortSha,
  getCommitMessage,
  getMergeBase,
  getStackCommits,
  getStackCommitsForBranch,
} from "../../src/git/queries.ts";
import { join } from "node:path";

const git = createRealGitRunner();
// Shared manager: repos are cleaned up in afterAll, which is safe under
// --concurrent (each test owns a local `const repo`).
const repos = repoManager();

// --- Task 5: getCurrentBranch, isDetachedHead ---

describe("getCurrentBranch", () => {
  test("returns default branch name on main", async () => {
    const repo = await repos.create();
    const branch = await getCurrentBranch(git, { cwd: repo.path });
    expect(branch).toBe(repo.defaultBranch);
  });

  test('returns "HEAD" in detached state', async () => {
    const repo = await repos.create();
    const sha = await repo.commit("detach me");
    await repo.checkout(sha);
    const branch = await getCurrentBranch(git, { cwd: repo.path });
    expect(branch).toBe("HEAD");
  });
});

describe("isDetachedHead", () => {
  test("returns false on a branch", async () => {
    const repo = await repos.create();
    expect(await isDetachedHead(git, { cwd: repo.path })).toBe(false);
  });

  test("returns true when detached", async () => {
    const repo = await repos.create();
    const sha = await repo.commit("detach");
    await repo.checkout(sha);
    expect(await isDetachedHead(git, { cwd: repo.path })).toBe(true);
  });
});

// --- Task 6: hasUncommittedChanges, getFullSha, getShortSha, getCommitMessage ---

describe("hasUncommittedChanges", () => {
  test("returns false for clean repo", async () => {
    const repo = await repos.create();
    expect(await hasUncommittedChanges(git, { cwd: repo.path })).toBe(false);
  });

  test("returns true after modifying a file", async () => {
    const repo = await repos.create();
    await Bun.write(join(repo.path, "dirty.txt"), "uncommitted\n");
    expect(await hasUncommittedChanges(git, { cwd: repo.path })).toBe(true);
  });
});

describe("getFullSha", () => {
  test("returns 40-char hex for HEAD", async () => {
    const repo = await repos.create();
    const sha = await getFullSha(git, "HEAD", { cwd: repo.path });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns 40-char hex for branch name", async () => {
    const repo = await repos.create();
    const sha = await getFullSha(git, repo.defaultBranch, { cwd: repo.path });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("getShortSha", () => {
  test("returns short hex between 4 and 12 chars", async () => {
    const repo = await repos.create();
    const sha = await getShortSha(git, "HEAD", { cwd: repo.path });
    expect(sha.length).toBeGreaterThanOrEqual(4);
    expect(sha.length).toBeLessThanOrEqual(12);
    expect(sha).toMatch(/^[0-9a-f]+$/);
  });
});

describe("getCommitMessage", () => {
  test("returns commit message", async () => {
    const repo = await repos.create();
    const sha = await repo.commit("test message");
    const msg = await getCommitMessage(git, sha, { cwd: repo.path });
    expect(msg).toContain("test message");
  });

  test("preserves multi-line messages", async () => {
    const repo = await repos.create();
    const { $ } = await import("bun");
    await $`git commit --allow-empty -m ${"Subject line\n\nBody paragraph"}`.cwd(repo.path).quiet();
    const msg = await getCommitMessage(git, "HEAD", { cwd: repo.path });
    expect(msg).toBe("Subject line\n\nBody paragraph");
  });
});

// --- Task 7: getMergeBase, getStackCommits, getStackCommitsForBranch ---

describe("getMergeBase", () => {
  test("returns 40-char SHA when branch has commits ahead of trunk", async () => {
    const repo = await repos.create();
    await repo.fetch();
    await repo.branch("feature");
    await repo.commit("ahead");
    const base = await getMergeBase(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    expect(base).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("getStackCommits", () => {
  test("returns [] when no commits ahead", async () => {
    const repo = await repos.create();
    await repo.fetch();
    const commits = await getStackCommits(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    expect(commits).toEqual([]);
  });

  test("returns commits in oldest-first order", async () => {
    const repo = await repos.create();
    await repo.fetch();
    await repo.branch("stack");
    await repo.commit("first");
    await repo.commit("second");
    await repo.commit("third");
    const commits = await getStackCommits(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    expect(commits).toHaveLength(3);
    expect(commits[0]?.subject).toContain("first");
    expect(commits[1]?.subject).toContain("second");
    expect(commits[2]?.subject).toContain("third");
  });

  test("populates hash, subject, body", async () => {
    const repo = await repos.create();
    await repo.fetch();
    await repo.branch("detailed");
    const { $ } = await import("bun");
    await $`git commit --allow-empty -m ${"My subject\n\nMy body text"}`.cwd(repo.path).quiet();
    const commits = await getStackCommits(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0]?.subject).toBe("My subject");
    expect(commits[0]?.body).toContain("My body text");
    expect(commits[0]?.trailers).toEqual({});
  });
});

describe("getStackCommitsForBranch", () => {
  test("returns commits for a specific branch", async () => {
    const repo = await repos.create();
    await repo.fetch();
    const branchName = await repo.branch("remote-query");
    await repo.commit("branch commit");
    await repo.checkout(repo.defaultBranch);

    const commits = await getStackCommitsForBranch(
      git,
      branchName,
      `origin/${repo.defaultBranch}`,
      { cwd: repo.path },
    );
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toContain("branch commit");
  });

  test("returns [] for branch at trunk", async () => {
    const repo = await repos.create();
    await repo.fetch();
    const branchName = await repo.branch("at-trunk");
    // No new commits — branch is at same point as trunk
    const commits = await getStackCommitsForBranch(
      git,
      branchName,
      `origin/${repo.defaultBranch}`,
      { cwd: repo.path },
    );
    expect(commits).toEqual([]);
  });
});
