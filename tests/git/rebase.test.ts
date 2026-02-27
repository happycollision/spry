import { test, expect, describe, afterAll } from "bun:test";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import type { TestRepo } from "../../tests/lib/index.ts";
import {
  injectMissingIds,
  rebaseOntoTrunk,
  getConflictInfo,
  formatConflictError,
} from "../../src/git/rebase.ts";
import type { ConflictInfo } from "../../src/git/rebase.ts";
import { getStackCommits, getFullSha } from "../../src/git/queries.ts";
import { parseTrailers } from "../../src/parse/trailers.ts";
import type { SpryConfig } from "../../src/git/config.ts";
import { trunkRef } from "../../src/git/config.ts";

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

    const branchName = await repo.branch("inject-test");
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
      const trailers = await parseTrailers(commit.body, git);
      expect(trailers["Spry-Commit-Id"]).toBeDefined();
      expect(trailers["Spry-Commit-Id"]).toMatch(/^[a-f0-9]{8}$/);
    }
  });

  test("returns modifiedCount=0 when all already have IDs", async () => {
    repo = await createRepo();
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await repo.fetch();

    const branchName = await repo.branch("already-has-ids");
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

// --- Task 17: rebaseOntoTrunk ---

describe("rebaseOntoTrunk", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("rebases stack onto updated trunk", async () => {
    repo = await createRepo();
    const config: SpryConfig = { trunk: "main", remote: "origin" };

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
    const config: SpryConfig = { trunk: "main", remote: "origin" };
    await repo.fetch();

    const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commitCount).toBe(0);
    expect(result.newTip).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns error for detached HEAD", async () => {
    repo = await createRepo();
    const config: SpryConfig = { trunk: "main", remote: "origin" };
    const sha = await getFullSha(git, "HEAD", { cwd: repo.path });
    await repo.checkout(sha);

    const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("detached-head");
  });

  test("detects conflict", async () => {
    repo = await createRepo();
    const config: SpryConfig = { trunk: "main", remote: "origin" };

    // Create shared file on main
    await repo.commitFiles({ "shared.txt": "base content" }, "add shared");
    await git.run(["push", "origin", "main"], { cwd: repo.path });

    // Branch off
    const branchName = await repo.branch("conflict-rebase");
    await repo.commitFiles(
      { "shared.txt": "feature version" },
      "modify shared on feature",
    );

    // Go back to main, modify same file, push
    await repo.checkout(repo.defaultBranch);
    await repo.commitFiles(
      { "shared.txt": "main version" },
      "modify shared on main",
    );
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
