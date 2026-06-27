import { test, expect, describe, afterAll } from "bun:test";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import type { TestRepo } from "../../tests/lib/index.ts";
import {
  injectMissingIds,
  injectMissingIdsForBranch,
  rebaseOntoTrunk,
  getConflictInfo,
  formatConflictError,
} from "../../src/git/rebase.ts";
import type { ConflictInfo } from "../../src/git/rebase.ts";
import { getStackCommits, getFullSha } from "../../src/git/queries.ts";
import { parseTrailers } from "../../src/parse/trailers.ts";
import type { SpryConfig } from "../../src/git/config.ts";

const git = createRealGitRunner();

// --- Task 16: injectMissingIds ---

describe("injectMissingIds", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("injects IDs into 2 commits missing them", async () => {
    repo = await createRepo();
    // Set spry config
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });

    // Push main so we have origin/main
    await repo.fetch();

    await repo.branch("inject-test");
    await repo.commit("first feature commit");
    await repo.commit("second feature commit");

    const ref = "origin/main";
    const result = await injectMissingIds(git, ref, { cwd: repo.path });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.modifiedCount).toBe(2);
    expect(result.rebasePerformed).toBe(true);

    // Verify IDs were added
    const commits = await getStackCommits(git, ref, { cwd: repo.path });
    expect(commits.length).toBe(2);

    for (const commit of commits) {
      // `commit.body` is body-only; `parseTrailers` needs a full message
      // (subject + blank + body) for `interpret-trailers --parse` to
      // recognize trailers when the body is otherwise empty.
      const fullMessage = commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
      const trailers = await parseTrailers(fullMessage, git);
      expect(trailers["Spry-Commit-Id"]).toBeDefined();
      expect(trailers["Spry-Commit-Id"]).toMatch(/^[a-f0-9]{8}$/);
    }
  });

  test("returns modifiedCount=0 when all already have IDs", async () => {
    repo = await createRepo();
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await repo.fetch();

    await repo.branch("already-has-ids");
    await repo.commit("commit with id to inject");

    const ref = "origin/main";

    // First inject
    const first = await injectMissingIds(git, ref, { cwd: repo.path });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.modifiedCount).toBe(1);

    // Second inject should find nothing to do
    const second = await injectMissingIds(git, ref, { cwd: repo.path });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.modifiedCount).toBe(0);
    expect(second.rebasePerformed).toBe(false);
  });

  test("returns error for detached HEAD", async () => {
    repo = await createRepo();
    const sha = await getFullSha(git, "HEAD", { cwd: repo.path });
    await repo.checkout(sha);

    const result = await injectMissingIds(git, "origin/main", {
      cwd: repo.path,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("detached-head");
  });

  test("returns ok for empty stack", async () => {
    repo = await createRepo();
    await repo.fetch();

    const result = await injectMissingIds(git, "origin/main", {
      cwd: repo.path,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.modifiedCount).toBe(0);
    expect(result.rebasePerformed).toBe(false);
  });
});

describe("injectMissingIdsForBranch", () => {
  test("injects IDs into a non-current branch via ref update, leaving HEAD untouched", async () => {
    const repo = await createRepo();
    const git = createRealGitRunner();
    await repo.fetch();

    // Build feature-other with a commit that has NO Spry-Commit-Id
    const other = await repo.branch("feature-other");
    await repo.commit("needs an id");
    const otherTipBefore = (
      await git.run(["rev-parse", `refs/heads/${other}`], { cwd: repo.path })
    ).stdout.trim();

    // Move HEAD onto a different branch so feature-other is NOT current
    const current = await repo.branch("feature-current");
    const headBefore = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();

    const result = await injectMissingIdsForBranch(git, other, "origin/main", { cwd: repo.path });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modifiedCount).toBe(1);

    // feature-other ref moved (commit was rewritten)
    const otherTipAfter = (
      await git.run(["rev-parse", `refs/heads/${other}`], { cwd: repo.path })
    ).stdout.trim();
    expect(otherTipAfter).not.toBe(otherTipBefore);

    // The rewritten commit now carries a Spry-Commit-Id
    const msg = (
      await git.run(["log", "-1", "--format=%B", `refs/heads/${other}`], { cwd: repo.path })
    ).stdout;
    expect(msg).toContain("Spry-Commit-Id:");

    // HEAD and the working tree are untouched
    const headAfter = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    expect(headAfter).toBe(headBefore);
    const status = (await git.run(["status", "--porcelain"], { cwd: repo.path })).stdout.trim();
    expect(status).toBe("");
    await repo.cleanup();
  });

  test("returns modifiedCount=0 when the branch's commits all have IDs", async () => {
    const repo = await createRepo();
    const git = createRealGitRunner();
    await repo.fetch();
    const other = await repo.branch("feature-other");
    await repo.commit("already has id\n\nSpry-Commit-Id: aaa11111");
    await repo.branch("feature-current"); // move HEAD away

    const result = await injectMissingIdsForBranch(git, other, "origin/main", { cwd: repo.path });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modifiedCount).toBe(0);
    await repo.cleanup();
  });
});

// --- Task 17: rebaseOntoTrunk ---

describe("rebaseOntoTrunk", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("rebases stack onto updated trunk", async () => {
    repo = await createRepo();
    const config: SpryConfig = {
      trunk: "main",
      remote: "origin",
      branchPrefix: "spry/test",
      autoDeleteOnLand: false,
    };

    // Create a feature branch
    const branchName = await repo.branch("rebase-trunk");
    await repo.commit("feature work");

    // Go back to main, add a commit, push, fetch
    await repo.checkout(repo.defaultBranch);
    await repo.commit("trunk update");
    await git.run(["push", "origin", "main"], { cwd: repo.path });
    await repo.fetch();

    // Go back to feature branch
    await repo.checkout(branchName);

    const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commitCount).toBe(1);
    expect(result.newTip).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns ok with commitCount 0 for empty stack", async () => {
    repo = await createRepo();
    const config: SpryConfig = {
      trunk: "main",
      remote: "origin",
      branchPrefix: "spry/test",
      autoDeleteOnLand: false,
    };
    await repo.fetch();

    const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commitCount).toBe(0);
    expect(result.newTip).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns error for detached HEAD", async () => {
    repo = await createRepo();
    const config: SpryConfig = {
      trunk: "main",
      remote: "origin",
      branchPrefix: "spry/test",
      autoDeleteOnLand: false,
    };
    const sha = await getFullSha(git, "HEAD", { cwd: repo.path });
    await repo.checkout(sha);

    const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("detached-head");
  });

  test("detects conflict", async () => {
    repo = await createRepo();
    const config: SpryConfig = {
      trunk: "main",
      remote: "origin",
      branchPrefix: "spry/test",
      autoDeleteOnLand: false,
    };

    // Create shared file on main
    await repo.commitFiles({ "shared.txt": "base content" }, "add shared");
    await git.run(["push", "origin", "main"], { cwd: repo.path });

    // Branch off
    const branchName = await repo.branch("conflict-rebase");
    await repo.commitFiles({ "shared.txt": "feature version" }, "modify shared on feature");

    // Go back to main, modify same file, push
    await repo.checkout(repo.defaultBranch);
    await repo.commitFiles({ "shared.txt": "main version" }, "modify shared on main");
    await git.run(["push", "origin", "main"], { cwd: repo.path });
    await repo.fetch();

    // Go back to feature
    await repo.checkout(branchName);

    const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("conflict");
  });
});

// --- Task 18: getConflictInfo, formatConflictError ---

describe("getConflictInfo", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns null when not in rebase", async () => {
    repo = await createRepo();
    const result = await getConflictInfo(git, { cwd: repo.path });
    expect(result).toBeNull();
  });
});

describe("formatConflictError", () => {
  test("produces readable message with expected content", () => {
    const info: ConflictInfo = {
      files: ["src/main.ts", "src/util.ts"],
      currentCommit: "abc12345",
      currentSubject: "Fix the widget",
    };

    const message = formatConflictError(info);

    expect(message).toContain("abc12345");
    expect(message).toContain("Fix the widget");
    expect(message).toContain("src/main.ts");
    expect(message).toContain("src/util.ts");
    expect(message).toContain("rebase --continue");
    expect(message).toContain("rebase --abort");
  });
});
