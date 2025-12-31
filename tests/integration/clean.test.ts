import { test, expect, beforeAll, beforeEach, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { createGitHubFixture, type GitHubFixture } from "../helpers/github-fixture.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { SKIP_GITHUB_TESTS, SKIP_CI_TESTS, runSync, runClean } from "./helpers.ts";

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: clean command", () => {
  let github: GitHubFixture;
  let localDir: string | null = null;

  beforeAll(async () => {
    github = await createGitHubFixture();
  });

  beforeEach(async () => {
    await github.reset();
  });

  afterEach(async () => {
    await github.reset();
    if (localDir) {
      await rm(localDir, { recursive: true, force: true });
      localDir = null;
    }
  });

  test(
    "reports no orphaned branches when none exist",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Run clean without any orphaned branches
      const result = await runClean(localDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No orphaned branches found");
    },
    { timeout: 60000 },
  );

  test(
    "--dry-run shows orphaned branches without deleting",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/clean-dry-run-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `dry-run-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Test commit for dry run"`.quiet();

      // Run taspr sync --open to create a PR
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find the PR and get its branch name
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title,headRefName`.text();
      const prs = JSON.parse(prList) as Array<{
        number: number;
        title: string;
        headRefName: string;
      }>;
      const pr = prs.find((p) => p.title.includes("Test commit for dry run"));
      if (!pr) throw new Error("PR not found");

      // Merge the PR via GitHub API WITHOUT deleting the branch (creates orphan)
      await github.mergePR(pr.number, { deleteBranch: false });

      // Verify branch still exists (orphaned)
      const branchCheck =
        await $`gh api repos/${github.owner}/${github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchCheck.exitCode).toBe(0);

      // Fetch the latest to get the merged branch info locally
      await $`git -C ${localDir} fetch origin`.quiet();

      // Run clean with --dry-run
      const cleanResult = await runClean(localDir, { dryRun: true });

      expect(cleanResult.exitCode).toBe(0);
      expect(cleanResult.stdout).toContain("Found");
      expect(cleanResult.stdout).toContain("merged branch");
      expect(cleanResult.stdout).toContain(pr.headRefName);
      expect(cleanResult.stdout).toContain("Run without --dry-run");

      // Verify branch was NOT deleted
      const branchCheckAfter =
        await $`gh api repos/${github.owner}/${github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchCheckAfter.exitCode).toBe(0);
    },
    { timeout: 120000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "deletes orphaned branches from merged PRs",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/clean-delete-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `delete-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Test commit for clean deletion"`.quiet();

      // Run taspr sync --open to create a PR
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find the PR and get its branch name
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title,headRefName`.text();
      const prs = JSON.parse(prList) as Array<{
        number: number;
        title: string;
        headRefName: string;
      }>;
      const pr = prs.find((p) => p.title.includes("Test commit for clean deletion"));
      if (!pr) throw new Error("PR not found");

      // Wait for CI to complete
      await github.waitForCI(pr.number, { timeout: 180000 });

      // Merge the PR via GitHub API WITHOUT deleting the branch (creates orphan)
      await github.mergePR(pr.number, { deleteBranch: false });

      // Verify branch still exists (orphaned)
      const branchCheck =
        await $`gh api repos/${github.owner}/${github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchCheck.exitCode).toBe(0);

      // Fetch the latest
      await $`git -C ${localDir} fetch origin`.quiet();

      // Run clean (without --dry-run)
      const cleanResult = await runClean(localDir);

      expect(cleanResult.exitCode).toBe(0);
      expect(cleanResult.stdout).toContain("Deleted");
      expect(cleanResult.stdout).toContain("orphaned branch");

      // Poll until branch is deleted (GitHub API is eventually consistent)
      let branchGone = false;
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(500);
        const afterCheck =
          await $`gh api repos/${github.owner}/${github.repo}/branches/${pr.headRefName}`.nothrow();
        if (afterCheck.exitCode !== 0) {
          branchGone = true;
          break;
        }
      }
      expect(branchGone).toBe(true);
    },
    { timeout: 300000 },
  );

  test(
    "detects multiple orphaned branches",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      const uniqueId = Date.now().toString(36);

      // Create first commit
      await $`git -C ${localDir} checkout -b feature/clean-multi-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `multi-1-${uniqueId}.txt`), "first content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "First commit for multi-clean test"`.quiet();

      // Create second commit
      await Bun.write(join(localDir, `multi-2-${uniqueId}.txt`), "second content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Second commit for multi-clean test"`.quiet();

      // Run taspr sync --open to create PRs
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find the PRs
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title,headRefName`.text();
      const prs = JSON.parse(prList) as Array<{
        number: number;
        title: string;
        headRefName: string;
      }>;
      const firstPr = prs.find((p) => p.title.includes("First commit for multi-clean test"));
      const secondPr = prs.find((p) => p.title.includes("Second commit for multi-clean test"));
      if (!firstPr || !secondPr) throw new Error("PRs not found");

      // Merge both PRs WITHOUT deleting branches (creates orphans)
      // Note: Merging in order since second depends on first
      await github.mergePR(firstPr.number, { deleteBranch: false });

      // Wait a bit for GitHub to process
      await Bun.sleep(2000);

      // Retarget and merge second PR
      await $`gh pr edit ${secondPr.number} --repo ${github.owner}/${github.repo} --base main`.quiet();
      await github.mergePR(secondPr.number, { deleteBranch: false });

      // Fetch the latest
      await $`git -C ${localDir} fetch origin`.quiet();

      // Run clean with --dry-run to see both branches
      const cleanResult = await runClean(localDir, { dryRun: true });

      expect(cleanResult.exitCode).toBe(0);
      expect(cleanResult.stdout).toContain("Found 2 merged branch");
      expect(cleanResult.stdout).toContain(firstPr.headRefName);
      expect(cleanResult.stdout).toContain(secondPr.headRefName);
    },
    { timeout: 120000 },
  );

  test(
    "detects orphaned branches when commit is amended and pushed to main directly",
    async () => {
      // This tests the scenario where:
      // 1. User creates a commit with taspr sync --open (creates branch with Taspr-Commit-Id)
      // 2. User amends the commit locally (SHA changes, but trailer preserved)
      // 3. User pushes the amended commit directly to main (bypassing the PR)
      // 4. The PR branch is now behind main (different SHA), but has the same Taspr-Commit-Id
      // 5. taspr clean should detect the branch as orphaned via commit-id trailer search

      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/amended-test-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `amended-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Test commit for amended scenario"`.quiet();

      // Run taspr sync --open to create a PR (this adds the Taspr-Commit-Id trailer)
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find the PR and get its branch name + commit ID
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title,headRefName`.text();
      const prs = JSON.parse(prList) as Array<{
        number: number;
        title: string;
        headRefName: string;
      }>;
      const pr = prs.find((p) => p.title.includes("Test commit for amended scenario"));
      if (!pr) throw new Error("PR not found");

      // Get the Taspr-Commit-Id from the current commit
      const commitIdMatch = pr.headRefName.match(/\/([^/]+)$/);
      const commitId = commitIdMatch?.[1];
      if (!commitId) throw new Error("Could not extract commit ID from branch name");

      // Now simulate the scenario: amend the commit (changes SHA) and push directly to main
      // First, go back to main and create an amended version of the commit
      await $`git -C ${localDir} checkout main`.quiet();
      await $`git -C ${localDir} pull origin main`.quiet();

      // Cherry-pick the commit and amend it (this preserves the trailer but changes the SHA)
      const featureBranchSha = (
        await $`git -C ${localDir} rev-parse origin/${pr.headRefName}`.text()
      ).trim();
      await $`git -C ${localDir} cherry-pick ${featureBranchSha}`.quiet();

      // Amend the commit message (this changes the SHA while preserving the trailer)
      await $`git -C ${localDir} commit --amend -m "Amended: Test commit for amended scenario

Taspr-Commit-Id: ${commitId}"`.quiet();

      // Push the amended commit directly to main
      await $`git -C ${localDir} push origin main`.quiet();

      // Verify the PR branch still exists but is now behind main
      const branchCheck =
        await $`gh api repos/${github.owner}/${github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchCheck.exitCode).toBe(0);

      // Verify the branch SHA is NOT an ancestor of main (different commit)
      await $`git -C ${localDir} fetch origin`.quiet();
      const isAncestor =
        await $`git -C ${localDir} merge-base --is-ancestor origin/${pr.headRefName} origin/main`
          .quiet()
          .nothrow();
      expect(isAncestor.exitCode).not.toBe(0); // Should NOT be an ancestor

      // Run clean with --dry-run - should detect via commit-id trailer
      const cleanResult = await runClean(localDir, { dryRun: true });

      expect(cleanResult.exitCode).toBe(0);
      expect(cleanResult.stdout).toContain("commit-id");
      expect(cleanResult.stdout).toContain("requires --force");
      expect(cleanResult.stdout).toContain(pr.headRefName);

      // Run clean WITHOUT --force - should skip this branch
      const cleanNoForce = await runClean(localDir);
      expect(cleanNoForce.exitCode).toBe(0);
      expect(cleanNoForce.stdout).toContain("Skipped");
      expect(cleanNoForce.stdout).toContain("--force");

      // Verify branch was NOT deleted
      const branchStillExists =
        await $`gh api repos/${github.owner}/${github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchStillExists.exitCode).toBe(0);

      // Run clean WITH --force - should delete the branch
      const cleanWithForce = await runClean(localDir, { force: true });
      expect(cleanWithForce.exitCode).toBe(0);
      expect(cleanWithForce.stdout).toContain("Deleted");
      expect(cleanWithForce.stdout).toContain("forced");

      // Poll until branch is deleted (GitHub API is eventually consistent)
      let branchGone = false;
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(500);
        const afterCheck =
          await $`gh api repos/${github.owner}/${github.repo}/branches/${pr.headRefName}`.nothrow();
        if (afterCheck.exitCode !== 0) {
          branchGone = true;
          break;
        }
      }
      expect(branchGone).toBe(true);
    },
    { timeout: 120000 },
  );
});
