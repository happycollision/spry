import { test, expect, describe, afterAll } from "bun:test";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import type { TestRepo } from "../../tests/lib/index.ts";
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

// --- Task 5: getCurrentBranch, isDetachedHead ---

describe("getCurrentBranch", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns default branch name on main", async () => {
    repo = await createRepo();
    const branch = await getCurrentBranch(git, { cwd: repo.path });
    expect(branch).toBe(repo.defaultBranch);
  });

  test('returns "HEAD" in detached state', async () => {
    repo = await createRepo();
    const sha = await repo.commit("detach me");
    await repo.checkout(sha);
    const branch = await getCurrentBranch(git, { cwd: repo.path });
    expect(branch).toBe("HEAD");
  });
});

describe("isDetachedHead", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns false on a branch", async () => {
    repo = await createRepo();
    expect(await isDetachedHead(git, { cwd: repo.path })).toBe(false);
  });

  test("returns true when detached", async () => {
    repo = await createRepo();
    const sha = await repo.commit("detach");
    await repo.checkout(sha);
    expect(await isDetachedHead(git, { cwd: repo.path })).toBe(true);
  });
});

// --- Task 6: hasUncommittedChanges, getFullSha, getShortSha, getCommitMessage ---

describe("hasUncommittedChanges", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns false for clean repo", async () => {
    repo = await createRepo();
    expect(await hasUncommittedChanges(git, { cwd: repo.path })).toBe(false);
  });

  test("returns true after modifying a file", async () => {
    repo = await createRepo();
    await Bun.write(join(repo.path, "dirty.txt"), "uncommitted\n");
    expect(await hasUncommittedChanges(git, { cwd: repo.path })).toBe(true);
  });
});

describe("getFullSha", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns 40-char hex for HEAD", async () => {
    repo = await createRepo();
    const sha = await getFullSha(git, "HEAD", { cwd: repo.path });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns 40-char hex for branch name", async () => {
    repo = await createRepo();
    const sha = await getFullSha(git, repo.defaultBranch, { cwd: repo.path });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("getShortSha", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns short hex between 4 and 12 chars", async () => {
    repo = await createRepo();
    const sha = await getShortSha(git, "HEAD", { cwd: repo.path });
    expect(sha.length).toBeGreaterThanOrEqual(4);
    expect(sha.length).toBeLessThanOrEqual(12);
    expect(sha).toMatch(/^[0-9a-f]+$/);
  });
});

describe("getCommitMessage", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns commit message", async () => {
    repo = await createRepo();
    const sha = await repo.commit("test message");
    const msg = await getCommitMessage(git, sha, { cwd: repo.path });
    // repo.commit appends [uniqueId]
    expect(msg).toContain("test message");
  });

  test("preserves multi-line messages", async () => {
    repo = await createRepo();
    const { $ } = await import("bun");
    await $`git commit --allow-empty -m ${"Subject line\n\nBody paragraph"}`.cwd(repo.path).quiet();
    const msg = await getCommitMessage(git, "HEAD", { cwd: repo.path });
    expect(msg).toBe("Subject line\n\nBody paragraph");
  });
});

// --- Task 7: getMergeBase, getStackCommits, getStackCommitsForBranch ---

describe("getMergeBase", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns 40-char SHA when branch has commits ahead of trunk", async () => {
    repo = await createRepo();
    await repo.fetch();
    const branchName = await repo.branch("feature");
    await repo.commit("ahead");
    const base = await getMergeBase(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    expect(base).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("getStackCommits", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns [] when no commits ahead", async () => {
    repo = await createRepo();
    await repo.fetch();
    const commits = await getStackCommits(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    expect(commits).toEqual([]);
  });

  test("returns commits in oldest-first order", async () => {
    repo = await createRepo();
    await repo.fetch();
    const branchName = await repo.branch("stack");
    await repo.commit("first");
    await repo.commit("second");
    await repo.commit("third");
    const commits = await getStackCommits(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    expect(commits).toHaveLength(3);
    expect(commits[0]!.subject).toContain("first");
    expect(commits[1]!.subject).toContain("second");
    expect(commits[2]!.subject).toContain("third");
  });

  test("populates hash, subject, body", async () => {
    repo = await createRepo();
    await repo.fetch();
    const branchName = await repo.branch("detailed");
    const { $ } = await import("bun");
    await $`git commit --allow-empty -m ${"My subject\n\nMy body text"}`.cwd(repo.path).quiet();
    const commits = await getStackCommits(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0]!.subject).toBe("My subject");
    expect(commits[0]!.body).toContain("My body text");
    expect(commits[0]!.trailers).toEqual({});
  });
});

describe("getStackCommitsForBranch", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns commits for a specific branch", async () => {
    repo = await createRepo();
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
    expect(commits[0]!.subject).toContain("branch commit");
  });

  test("returns [] for branch at trunk", async () => {
    repo = await createRepo();
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
