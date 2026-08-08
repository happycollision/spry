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

// --- Merge-aware stack walk (step 2) ---

// Build a stack: base -> c1 (plain) -> merge[c2,c3] -> c4 (plain), materialized
// with git plumbing, and return the SHAs. Deterministic dates/identity so it's
// stable. Uses the repo's default branch as base.
async function buildMergeStack(repoPath: string): Promise<{ mergeSha: string }> {
  const { $ } = await import("bun");
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "1700000000 +0000",
    GIT_COMMITTER_DATE: "1700000000 +0000",
    GIT_AUTHOR_NAME: "spry",
    GIT_AUTHOR_EMAIL: "spry@local",
    GIT_COMMITTER_NAME: "spry",
    GIT_COMMITTER_EMAIL: "spry@local",
  };
  // Linear c1..c4 on a stack branch.
  await $`git checkout -qb stack`.cwd(repoPath).env(env).quiet();
  for (const c of ["c1", "c2", "c3", "c4"]) {
    await $`git commit --allow-empty -m ${c}`.cwd(repoPath).env(env).quiet();
  }
  const rev = async (r: string) =>
    (await $`git rev-parse ${r}`.cwd(repoPath).env(env).quiet().text()).trim();
  const tree = async (r: string) =>
    (await $`git rev-parse ${r + "^{tree}"}`.cwd(repoPath).env(env).quiet().text()).trim();

  const c1 = await rev("stack~3");
  const c2 = await rev("stack~2");
  const c3 = await rev("stack~1");
  const c4 = await rev("stack");

  const commitTree = async (treeArg: string, msg: string, parents: string[]) => {
    const ps = parents.flatMap((p) => ["-p", p]);
    return (
      await $`git commit-tree ${treeArg} ${ps} -m ${msg}`.cwd(repoPath).env(env).quiet().text()
    ).trim();
  };

  const g2 = await commitTree(await tree(c2), "commit c2", [c1]);
  const g3 = await commitTree(await tree(c3), "commit c3", [g2]);
  const merge = await commitTree(await tree(c3), "Merge: group X", [c1, g3]);
  const p4 = await commitTree(await tree(c4), "commit c4", [merge]);
  // `stack` is the checked-out branch, so `branch -f` is refused; move it via a
  // hard reset to the synthesized tip instead.
  await $`git reset --hard ${p4}`.cwd(repoPath).env(env).quiet();
  return { mergeSha: merge };
}

describe("getStackCommits with a materialized merge", () => {
  test("first-parent walk yields the outer line: plain, merge, plain (members excluded)", async () => {
    const repo = await repos.create();
    await repo.fetch();
    await buildMergeStack(repo.path);

    const commits = await getStackCommits(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    // c1 is the original plain commit (subject "c1"); the merge sits above it;
    // c4 was re-rooted onto the merge (subject "commit c4"). Members c2/c3 are on
    // the second-parent side branch and must NOT appear in the first-parent walk.
    expect(commits.map((c) => c.subject)).toEqual(["c1", "Merge: group X", "commit c4"]);
    // The merge commit has two parents; the plain commits have one.
    const merge = commits.find((c) => c.subject === "Merge: group X");
    expect(merge?.parents?.length).toBe(2);
    const c1 = commits.find((c) => c.subject === "c1");
    expect(c1?.parents?.length).toBe(1);
  });

  test("a linear stack's first-parent walk is unchanged (regression)", async () => {
    const repo = await repos.create();
    await repo.fetch();
    await repo.branch("linear");
    await repo.commit("first");
    await repo.commit("second");
    const commits = await getStackCommits(git, `origin/${repo.defaultBranch}`, {
      cwd: repo.path,
    });
    expect(commits.map((c) => c.subject).map((s) => s.replace(/\s.*/, ""))).toEqual([
      "first",
      "second",
    ]);
    // parents populated, single-parent each.
    expect(commits.every((c) => (c.parents?.length ?? 0) === 1)).toBe(true);
  });
});

describe("getMergeMembers", () => {
  test("expands a merge commit's side-branch members oldest-first", async () => {
    const { getMergeMembers } = await import("../../src/git/queries.ts");
    const repo = await repos.create();
    await repo.fetch();
    const { mergeSha } = await buildMergeStack(repo.path);

    const members = await getMergeMembers(git, mergeSha, { cwd: repo.path });
    expect(members.map((m) => m.subject)).toEqual(["commit c2", "commit c3"]);
  });

  test("returns [] for a non-merge commit", async () => {
    const { getMergeMembers } = await import("../../src/git/queries.ts");
    const repo = await repos.create();
    await repo.fetch();
    await repo.branch("plain");
    const sha = await repo.commit("just one");
    const members = await getMergeMembers(git, sha, { cwd: repo.path });
    expect(members).toEqual([]);
  });
});
