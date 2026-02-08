import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";
import { repoManager } from "../helpers/local-repo.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { runClean, runSpry } from "./helpers.ts";
import type { LocalRepo } from "../../src/scenario/core.ts";

const { test: storyTest } = createStoryTest("clean.test.ts");

describe("Clean command", () => {
  storyTest("Clean command help text", async (story) => {
    story.narrate("The clean command should display help text with usage information.");

    const result = await runSpry(process.cwd(), "clean", ["--help"]);
    story.log(result);
    expect(result.stderr).toBeEmpty();
    expect(result.stdout).toContain("Usage:");
  });
});

// ============================================================================
// Local-only clean tests (no GitHub, no network)
// Uses bare repo fixtures with spry-pattern branches
// ============================================================================

/**
 * Set git config so sp clean works without GitHub API calls.
 */
async function setupCleanConfig(repoPath: string): Promise<void> {
  await $`git -C ${repoPath} config spry.username testuser`.quiet();
  await $`git -C ${repoPath} config spry.defaultBranch main`.quiet();
}

/**
 * Create a spry-pattern branch on origin with a Spry-Commit-Id trailer.
 * Returns the commit SHA.
 */
async function createSpryBranch(repo: LocalRepo, commitId: string): Promise<string> {
  const branchName = `spry/testuser/${commitId}`;

  await $`git -C ${repo.path} checkout -b ${branchName}`.quiet();
  await Bun.write(join(repo.path, `${commitId}.txt`), `Content for ${commitId}\n`);
  await $`git -C ${repo.path} add .`.quiet();
  await $`git -C ${repo.path} commit -m ${"commit for " + commitId + "\n\nSpry-Commit-Id: " + commitId}`.quiet();
  await $`git -C ${repo.path} push origin ${branchName}`.quiet();

  const sha = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();
  await $`git -C ${repo.path} checkout main`.quiet();
  return sha;
}

/**
 * Fast-forward merge a SHA into main and push to origin.
 */
async function mergeToMain(repo: LocalRepo, sha: string): Promise<void> {
  await $`git -C ${repo.path} checkout main`.quiet();
  await $`git -C ${repo.path} merge --ff-only ${sha}`.quiet();
  await $`git -C ${repo.path} push origin main`.quiet();
}

describe("clean: local-only tests", () => {
  const repos = repoManager();

  test("no orphaned branches when none exist", async () => {
    const repo = await repos.create();
    await setupCleanConfig(repo.path);

    const result = await runClean(repo.path);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No orphaned branches found");
  });

  test("dry-run lists merged branches without deleting", async () => {
    const repo = await repos.create();
    await setupCleanConfig(repo.path);

    const sha = await createSpryBranch(repo, "abc12345");
    await mergeToMain(repo, sha);

    const result = await runClean(repo.path, { dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Found");
    expect(result.stdout).toContain("merged branch");
    expect(result.stdout).toContain("spry/testuser/abc12345");
    expect(result.stdout).toContain("Run without --dry-run");

    // Verify branch was NOT deleted
    const branches = (await $`git -C ${repo.path} branch -r --list "origin/spry/*"`.text()).trim();
    expect(branches).toContain("spry/testuser/abc12345");
  });

  test("deletes orphaned branches that are merged", async () => {
    const repo = await repos.create();
    await setupCleanConfig(repo.path);

    const sha = await createSpryBranch(repo, "def67890");
    await mergeToMain(repo, sha);

    const result = await runClean(repo.path);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Deleted");
    expect(result.stdout).toContain("orphaned branch");

    // Verify branch was actually deleted from origin
    await $`git -C ${repo.path} fetch origin --prune`.quiet();
    const branches = (await $`git -C ${repo.path} branch -r --list "origin/spry/*"`.text()).trim();
    expect(branches).toBe("");
  });

  test("detects multiple orphaned branches", async () => {
    const repo = await repos.create();
    await setupCleanConfig(repo.path);

    // Create first branch and merge to main
    const sha1 = await createSpryBranch(repo, "first111");
    await mergeToMain(repo, sha1);

    // Create second branch from updated main and merge
    const sha2 = await createSpryBranch(repo, "second22");
    await mergeToMain(repo, sha2);

    const result = await runClean(repo.path, { dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Found 2 merged branch");
    expect(result.stdout).toContain("spry/testuser/first111");
    expect(result.stdout).toContain("spry/testuser/second22");
  });

  test("detects amended commits via Spry-Commit-Id trailer", async () => {
    const repo = await repos.create();
    await setupCleanConfig(repo.path);

    const commitId = "amend123";
    const branchSha = await createSpryBranch(repo, commitId);

    // Cherry-pick the commit to main, amend it (different SHA, same trailer)
    await $`git -C ${repo.path} checkout main`.quiet();
    await $`git -C ${repo.path} cherry-pick ${branchSha}`.quiet();
    await $`git -C ${repo.path} commit --amend -m ${"Amended commit\n\nSpry-Commit-Id: " + commitId}`.quiet();
    await $`git -C ${repo.path} push origin main`.quiet();

    // Verify the branch SHA is NOT an ancestor of main (different commit)
    await $`git -C ${repo.path} fetch origin`.quiet();
    const isAncestor =
      await $`git -C ${repo.path} merge-base --is-ancestor origin/spry/testuser/${commitId} origin/main`
        .quiet()
        .nothrow();
    expect(isAncestor.exitCode).not.toBe(0);

    // Without --unsafe: should hint about commit-id matches
    const cleanNoUnsafe = await runClean(repo.path);
    expect(cleanNoUnsafe.exitCode).toBe(0);
    expect(cleanNoUnsafe.stdout).toContain("commit-id");
    expect(cleanNoUnsafe.stdout).toContain("--unsafe");

    // With --unsafe (implies dry-run): should list the branch
    const unsafeResult = await runClean(repo.path, { unsafe: true });
    expect(unsafeResult.exitCode).toBe(0);
    expect(unsafeResult.stdout).toContain(`spry/testuser/${commitId}`);
    expect(unsafeResult.stdout).toContain("unsafe");

    // With --unsafe --force: should delete
    const forceResult = await runClean(repo.path, { unsafe: true, force: true });
    expect(forceResult.exitCode).toBe(0);
    expect(forceResult.stdout).toContain("Deleted");
    expect(forceResult.stdout).toContain("unsafe");

    // Verify branch was deleted
    await $`git -C ${repo.path} fetch origin --prune`.quiet();
    const branches = (await $`git -C ${repo.path} branch -r --list "origin/spry/*"`.text()).trim();
    expect(branches).toBe("");
  });
});
