import { test, expect, describe, afterAll } from "bun:test";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import type { TestRepo } from "../../tests/lib/index.ts";
import { join } from "node:path";
import {
  getTree,
  getParent,
  getParents,
  getAuthorEnv,
  getAuthorAndCommitterEnv,
  createCommit,
  mergeTree,
  updateRef,
  resetToCommit,
  rewriteCommitChain,
  rebasePlumbing,
  finalizeRewrite,
} from "../../src/git/plumbing.ts";
import { getFullSha, getCommitMessage } from "../../src/git/queries.ts";

const git = createRealGitRunner();

// --- Task 8: getTree, getParent, getParents ---

describe("getTree", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns 40-char hex SHA from HEAD", async () => {
    repo = await createRepo();
    const tree = await getTree(git, "HEAD", { cwd: repo.path });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns 40-char hex SHA from specific commit", async () => {
    repo = await createRepo();
    const sha = await repo.commit("for tree test");
    const tree = await getTree(git, sha, { cwd: repo.path });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("getParent", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns parent SHA different from child", async () => {
    repo = await createRepo();
    const child = await repo.commit("child commit");
    const parent = await getParent(git, child, { cwd: repo.path });
    expect(parent).toMatch(/^[0-9a-f]{40}$/);
    expect(parent).not.toBe(child);
  });
});

describe("getParents", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns single parent for normal commit", async () => {
    repo = await createRepo();
    const sha = await repo.commit("normal commit");
    const parents = await getParents(git, sha, { cwd: repo.path });
    expect(parents).toHaveLength(1);
    expect(parents[0]).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns empty array for root commit", async () => {
    repo = await createRepo();
    const result = await git.run(
      ["rev-list", "--max-parents=0", "HEAD"],
      { cwd: repo.path },
    );
    const root = result.stdout.trim();
    const parents = await getParents(git, root, { cwd: repo.path });
    expect(parents).toEqual([]);
  });
});

// --- Task 9: getAuthorEnv, getAuthorAndCommitterEnv, createCommit ---

describe("getAuthorEnv", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns name, email, and date", async () => {
    repo = await createRepo();
    await repo.commit("author test");
    const env = await getAuthorEnv(git, "HEAD", { cwd: repo.path });
    expect(env.GIT_AUTHOR_NAME).toBe("Test User");
    expect(env.GIT_AUTHOR_EMAIL).toBe("test@example.com");
    expect(env.GIT_AUTHOR_DATE).toBeDefined();
    expect((env.GIT_AUTHOR_DATE ?? "").length).toBeGreaterThan(0);
  });
});

describe("getAuthorAndCommitterEnv", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns all 6 fields", async () => {
    repo = await createRepo();
    await repo.commit("committer test");
    const env = await getAuthorAndCommitterEnv(git, "HEAD", { cwd: repo.path });
    expect(env.GIT_AUTHOR_NAME).toBe("Test User");
    expect(env.GIT_AUTHOR_EMAIL).toBe("test@example.com");
    expect(env.GIT_AUTHOR_DATE).toBeDefined();
    expect(env.GIT_COMMITTER_NAME).toBe("Test User");
    expect(env.GIT_COMMITTER_EMAIL).toBe("test@example.com");
    expect(env.GIT_COMMITTER_DATE).toBeDefined();
  });
});

describe("createCommit", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("creates new commit with correct message", async () => {
    repo = await createRepo();
    const parentSha = await getFullSha(git, "HEAD", { cwd: repo.path });
    const tree = await getTree(git, "HEAD", { cwd: repo.path });
    const env = await getAuthorAndCommitterEnv(git, "HEAD", { cwd: repo.path });

    const newSha = await createCommit(
      git,
      tree,
      [parentSha],
      "plumbing commit message",
      env,
      { cwd: repo.path },
    );

    expect(newSha).toMatch(/^[0-9a-f]{40}$/);
    expect(newSha).not.toBe(parentSha);

    const msg = await getCommitMessage(git, newSha, { cwd: repo.path });
    expect(msg).toBe("plumbing commit message");
  });
});

// --- Task 10: mergeTree, updateRef, resetToCommit ---

describe("mergeTree", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("clean merge with non-overlapping files", async () => {
    repo = await createRepo();
    // Base commit is initial commit (HEAD after createRepo)
    const base = await getFullSha(git, "HEAD", { cwd: repo.path });

    // Create branch A with file A
    const branchA = await repo.branch("merge-a");
    const shaA = await repo.commitFiles({ "file-a.txt": "content A" }, "add file A");

    // Go back to base, create branch B with file B
    await repo.checkout(repo.defaultBranch);
    const branchB = await repo.branch("merge-b");
    const shaB = await repo.commitFiles({ "file-b.txt": "content B" }, "add file B");

    const result = await mergeTree(git, base, shaA, shaB, { cwd: repo.path });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tree).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("conflict with overlapping changes", async () => {
    repo = await createRepo();
    // Create base with shared file
    const baseSha = await repo.commitFiles(
      { "shared.txt": "base content" },
      "base",
    );

    // Branch A modifies shared file
    const branchA = await repo.branch("conflict-a");
    const shaA = await repo.commitFiles(
      { "shared.txt": "version A" },
      "modify A",
    );

    // Back to base, branch B modifies same file differently
    await repo.checkout(repo.defaultBranch);
    const branchB = await repo.branch("conflict-b");
    const shaB = await repo.commitFiles(
      { "shared.txt": "version B" },
      "modify B",
    );

    const result = await mergeTree(git, baseSha, shaA, shaB, {
      cwd: repo.path,
    });
    expect(result.ok).toBe(false);
  });
});

describe("updateRef", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("updates branch ref to new SHA", async () => {
    repo = await createRepo();
    const sha1 = await repo.commit("first");
    const sha2 = await repo.commit("second");

    // Create a new commit via plumbing
    const tree = await getTree(git, sha2, { cwd: repo.path });
    const env = await getAuthorAndCommitterEnv(git, sha2, { cwd: repo.path });
    const newSha = await createCommit(
      git,
      tree,
      [sha2],
      "ref update test",
      env,
      { cwd: repo.path },
    );

    await updateRef(
      git,
      `refs/heads/${repo.defaultBranch}`,
      newSha,
      sha2,
      { cwd: repo.path },
    );

    const currentSha = await getFullSha(git, repo.defaultBranch, {
      cwd: repo.path,
    });
    expect(currentSha).toBe(newSha);
  });
});

describe("resetToCommit", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("resets working directory to earlier commit", async () => {
    repo = await createRepo();
    const earlyCommit = await getFullSha(git, "HEAD", { cwd: repo.path });

    // Add a file on a new commit
    const branchName = await repo.branch("reset-test");
    await repo.commitFiles({ "new-file.txt": "hello" }, "add new file");

    // Verify file exists
    expect(await Bun.file(join(repo.path, "new-file.txt")).exists()).toBe(true);

    // Reset to earlier commit
    await resetToCommit(git, earlyCommit, { cwd: repo.path });

    // File should be gone
    expect(await Bun.file(join(repo.path, "new-file.txt")).exists()).toBe(false);
  });
});

// --- Task 11: rewriteCommitChain ---

describe("rewriteCommitChain", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("rewrites message for single commit", async () => {
    repo = await createRepo();
    const sha = await repo.commit("original message");
    const rewrites = new Map<string, string>();
    rewrites.set(sha, "rewritten message");

    const result = await rewriteCommitChain(git, [sha], rewrites, {
      cwd: repo.path,
    });

    expect(result.newTip).toMatch(/^[0-9a-f]{40}$/);
    expect(result.newTip).not.toBe(sha);
    expect(result.mapping.size).toBe(1);

    const msg = await getCommitMessage(git, result.newTip, { cwd: repo.path });
    expect(msg).toBe("rewritten message");
  });

  test("rewrites only specified commits in 3-commit chain", async () => {
    repo = await createRepo();
    const sha1 = await repo.commit("first");
    const sha2 = await repo.commit("second");
    const sha3 = await repo.commit("third");

    // Only rewrite the middle commit
    const rewrites = new Map<string, string>();
    rewrites.set(sha2, "REWRITTEN second");

    const result = await rewriteCommitChain(
      git,
      [sha1, sha2, sha3],
      rewrites,
      { cwd: repo.path },
    );

    expect(result.mapping.size).toBe(3);

    // Check first commit kept its message
    const newSha1 = result.mapping.get(sha1) ?? "";
    const msg1 = await getCommitMessage(git, newSha1, {
      cwd: repo.path,
    });
    expect(msg1).toContain("first");

    // Check middle commit was rewritten
    const newSha2 = result.mapping.get(sha2) ?? "";
    const msg2 = await getCommitMessage(git, newSha2, {
      cwd: repo.path,
    });
    expect(msg2).toBe("REWRITTEN second");

    // Check third commit kept its message
    const newSha3 = result.mapping.get(sha3) ?? "";
    const msg3 = await getCommitMessage(git, newSha3, {
      cwd: repo.path,
    });
    expect(msg3).toContain("third");
  });

  test("preserves tree contents across rewrite", async () => {
    repo = await createRepo();
    const sha = await repo.commitFiles({ "keep.txt": "preserved" }, "keep tree");
    const treeBefore = await getTree(git, sha, { cwd: repo.path });

    const rewrites = new Map<string, string>();
    rewrites.set(sha, "new message, same tree");

    const result = await rewriteCommitChain(git, [sha], rewrites, {
      cwd: repo.path,
    });

    const treeAfter = await getTree(git, result.newTip, { cwd: repo.path });
    expect(treeAfter).toBe(treeBefore);
  });
});

// --- Task 12: rebasePlumbing, finalizeRewrite ---

describe("rebasePlumbing", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("rebases commits onto new base", async () => {
    repo = await createRepo();
    // Create a diverge point
    const base = await getFullSha(git, "HEAD", { cwd: repo.path });

    // Create work on main
    const mainWork = await repo.commitFiles(
      { "main-work.txt": "main content" },
      "main work",
    );
    await repo.checkout(repo.defaultBranch);
    const mainTip = await getFullSha(git, "HEAD", { cwd: repo.path });

    // Go back to base, branch off and add non-conflicting work
    await repo.checkout(base);
    const branchName = await repo.branch("rebase-src");
    const featureSha = await repo.commitFiles(
      { "feature.txt": "feature content" },
      "feature work",
    );

    const result = await rebasePlumbing(git, mainTip, [featureSha], {
      cwd: repo.path,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newTip).toMatch(/^[0-9a-f]{40}$/);
      expect(result.newTip).not.toBe(featureSha);
      expect(result.mapping.size).toBe(1);
    }
  });

  test("empty commits returns onto as newTip", async () => {
    repo = await createRepo();
    const onto = await getFullSha(git, "HEAD", { cwd: repo.path });

    const result = await rebasePlumbing(git, onto, [], { cwd: repo.path });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newTip).toBe(onto);
      expect(result.mapping.size).toBe(0);
    }
  });

  test("detects conflicts", async () => {
    repo = await createRepo();
    // Create base with shared file
    const baseSha = await repo.commitFiles(
      { "conflict.txt": "base content" },
      "conflict base",
    );

    // Main modifies it
    const mainSha = await repo.commitFiles(
      { "conflict.txt": "main version" },
      "main conflict",
    );
    const mainTip = await getFullSha(git, "HEAD", { cwd: repo.path });

    // Branch from base, modify same file
    await repo.checkout(baseSha);
    const branchName = await repo.branch("conflict-rebase");
    const featureSha = await repo.commitFiles(
      { "conflict.txt": "feature version" },
      "feature conflict",
    );

    const result = await rebasePlumbing(git, mainTip, [featureSha], {
      cwd: repo.path,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflictCommit).toBe(featureSha);
    }
  });
});

describe("finalizeRewrite", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("updates branch ref after message-only rewrite", async () => {
    repo = await createRepo();
    const branchName = await repo.branch("finalize-test");
    const sha = await repo.commit("original");
    const oldTip = await getFullSha(git, "HEAD", { cwd: repo.path });

    const rewrites = new Map<string, string>();
    rewrites.set(oldTip, "rewritten for finalize");

    const result = await rewriteCommitChain(git, [oldTip], rewrites, {
      cwd: repo.path,
    });

    await finalizeRewrite(git, branchName, oldTip, result.newTip, {
      cwd: repo.path,
    });

    const headSha = await getFullSha(git, "HEAD", { cwd: repo.path });
    expect(headSha).toBe(result.newTip);
  });
});
