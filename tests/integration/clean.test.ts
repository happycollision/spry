import { expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { SKIP_GITHUB_TESTS, SKIP_CI_TESTS, runSync, runClean, runSpry } from "./helpers.ts";

const { test } = createStoryTest("clean.test.ts");

describe("Clean command", () => {
  test("Clean command help text", async (story) => {
    story.narrate("The clean command should display help text with usage information.");

    const result = await runSpry(process.cwd(), "clean", ["--help"]);
    story.log(result);
    expect(result.stderr).toBeEmpty();
    expect(result.stdout).toContain("Usage:");
  });
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: clean command", () => {
  const repos = repoManager({ github: true });

  test(
    "No orphaned branches",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When there are no merged PRs with leftover branches, sp clean reports nothing to clean up.",
      );

      const repo = await repos.clone({ testName: "no-orphans" });

      // Run clean without any orphaned branches
      const result = await runClean(repo.path);
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No orphaned branches found");
    },
    { timeout: 60000 },
  );

  test(
    "Dry run preview",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "The --dry-run flag lets you preview which branches would be cleaned up without actually deleting them.",
      );

      const repo = await repos.clone({ testName: "dry-run" });
      await repo.branch("feature/clean-dry-run");
      await repo.commit();

      // Run sp sync --open to create a PR
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Merge the PR via GitHub API WITHOUT deleting the branch (creates orphan)
      await repo.github.mergePR(pr.number, { deleteBranch: false });

      // Verify branch still exists (orphaned)
      const branchCheck =
        await $`gh api repos/${repo.github.owner}/${repo.github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchCheck.exitCode).toBe(0);

      // Fetch the latest to get the merged branch info locally
      await repo.fetch();

      // Run clean with --dry-run
      story.narrate("After merging the PR but leaving the branch, run clean with --dry-run:");
      const cleanResult = await runClean(repo.path, { dryRun: true });
      story.log(cleanResult);

      expect(cleanResult.exitCode).toBe(0);
      expect(cleanResult.stdout).toContain("Found");
      expect(cleanResult.stdout).toContain("merged branch");
      expect(cleanResult.stdout).toContain(pr.headRefName);
      expect(cleanResult.stdout).toContain("Run without --dry-run");

      // Verify branch was NOT deleted
      const branchCheckAfter =
        await $`gh api repos/${repo.github.owner}/${repo.github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchCheckAfter.exitCode).toBe(0);
    },
    { timeout: 120000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "Deleting orphaned branches",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When a PR is merged but the branch wasn't deleted, sp clean removes the orphaned remote branch.",
      );

      const repo = await repos.clone({ testName: "delete" });
      await repo.branch("feature/clean-delete");
      await repo.commit();

      // Run sp sync --open to create a PR
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to complete
      await repo.github.waitForCI(pr.number, { timeout: 180000 });

      // Merge the PR via GitHub API WITHOUT deleting the branch (creates orphan)
      await repo.github.mergePR(pr.number, { deleteBranch: false });

      // Verify branch still exists (orphaned)
      const branchCheck =
        await $`gh api repos/${repo.github.owner}/${repo.github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchCheck.exitCode).toBe(0);

      // Fetch the latest
      await repo.fetch();

      // Run clean (without --dry-run)
      story.narrate("After merging and leaving the branch orphaned, run clean:");
      const cleanResult = await runClean(repo.path);
      story.log(cleanResult);

      expect(cleanResult.exitCode).toBe(0);
      expect(cleanResult.stdout).toContain("Deleted");
      expect(cleanResult.stdout).toContain("orphaned branch");

      // Poll until branch is deleted (GitHub API is eventually consistent)
      const branchGone = await repo.waitForBranchGone(pr.headRefName);
      expect(branchGone).toBe(true);
    },
    { timeout: 300000 },
  );

  test(
    "Multiple orphaned branches",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When multiple PRs are merged with branches left behind, sp clean detects all of them.",
      );

      const repo = await repos.clone({ testName: "multi" });
      await repo.branch("feature/clean-multi");
      await repo.commit();
      await repo.commit();

      // Run sp sync --open to create PRs
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find the PRs (both will have the uniqueId in the title) and sort by PR number
      // Lower PR numbers = bottom of stack (created first)
      const prs = (await repo.findPRs(repo.uniqueId)).sort((a, b) => a.number - b.number);
      expect(prs.length).toBe(2);
      const firstPr = prs[0];
      const secondPr = prs[1];
      if (!firstPr || !secondPr) throw new Error("Expected 2 PRs");

      // Merge both PRs WITHOUT deleting branches (creates orphans)
      // Note: Merging in order since second depends on first
      await repo.github.mergePR(firstPr.number, { deleteBranch: false });

      // Wait a bit for GitHub to process
      await Bun.sleep(2000);

      // Retarget and merge second PR
      await $`gh pr edit ${secondPr.number} --repo ${repo.github.owner}/${repo.github.repo} --base main`.quiet();
      await repo.github.mergePR(secondPr.number, { deleteBranch: false });

      // Fetch the latest
      await repo.fetch();

      // Run clean with --dry-run to see both branches
      story.narrate("After merging both PRs with branches left behind:");
      const cleanResult = await runClean(repo.path, { dryRun: true });
      story.log(cleanResult);

      expect(cleanResult.exitCode).toBe(0);
      expect(cleanResult.stdout).toContain("Found 2 merged branch");
      expect(cleanResult.stdout).toContain(firstPr.headRefName);
      expect(cleanResult.stdout).toContain(secondPr.headRefName);
    },
    { timeout: 120000 },
  );

  test(
    "Amended commit detection via trailer",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When a commit is amended and pushed directly to main (bypassing the PR), " +
          "sp clean can still detect the orphaned branch via the Spry-Commit-Id trailer.",
      );

      // This tests the scenario where:
      // 1. User creates a commit with sp sync --open (creates branch with Spry-Commit-Id)
      // 2. User amends the commit locally (SHA changes, but trailer preserved)
      // 3. User pushes the amended commit directly to main (bypassing the PR)
      // 4. The PR branch is now behind main (different SHA), but has the same Spry-Commit-Id
      // 5. sp clean should detect the branch as orphaned via commit-id trailer search

      const repo = await repos.clone({ testName: "amended" });
      await repo.branch("feature/amended-test");
      await repo.commit();

      // Run sp sync --open to create a PR (this adds the Spry-Commit-Id trailer)
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Get the Spry-Commit-Id from the current commit
      const commitIdMatch = pr.headRefName.match(/\/([^/]+)$/);
      const commitId = commitIdMatch?.[1];
      if (!commitId) throw new Error("Could not extract commit ID from branch name");

      // Now simulate the scenario: amend the commit (changes SHA) and push directly to main
      // First, go back to main and create an amended version of the commit
      await repo.checkout("main");
      await $`git -C ${repo.path} pull origin main`.quiet();

      // Cherry-pick the commit and amend it (this preserves the trailer but changes the SHA)
      const featureBranchSha = (
        await $`git -C ${repo.path} rev-parse origin/${pr.headRefName}`.text()
      ).trim();
      await $`git -C ${repo.path} cherry-pick ${featureBranchSha}`.quiet();

      // Amend the commit message (this changes the SHA while preserving the trailer)
      await $`git -C ${repo.path} commit --amend -m "Amended commit [${repo.uniqueId}]

Spry-Commit-Id: ${commitId}"`.quiet();

      // Push the amended commit directly to main
      await $`git -C ${repo.path} push origin main`.quiet();

      // Verify the PR branch still exists but is now behind main
      const branchCheck =
        await $`gh api repos/${repo.github.owner}/${repo.github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchCheck.exitCode).toBe(0);

      // Verify the branch SHA is NOT an ancestor of main (different commit)
      await repo.fetch();
      const isAncestor =
        await $`git -C ${repo.path} merge-base --is-ancestor origin/${pr.headRefName} origin/main`
          .quiet()
          .nothrow();
      expect(isAncestor.exitCode).not.toBe(0); // Should NOT be an ancestor

      // Run clean with --unsafe (implies --dry-run) - should detect via commit-id trailer
      story.narrate(
        "The branch SHA differs from main but shares the same Spry-Commit-Id. With --unsafe:",
      );
      const cleanResult = await runClean(repo.path, { unsafe: true });
      story.log(cleanResult);

      expect(cleanResult.exitCode).toBe(0);
      expect(cleanResult.stdout).toContain("commit-id");
      expect(cleanResult.stdout).toContain("unsafe");
      expect(cleanResult.stdout).toContain(pr.headRefName);

      // Run clean WITHOUT --unsafe - should not show this branch
      story.narrate("Without --unsafe, the branch is not listed:");
      const cleanNoUnsafe = await runClean(repo.path);
      story.log(cleanNoUnsafe);
      expect(cleanNoUnsafe.exitCode).toBe(0);
      // Should hint about additional branches found by commit-id
      expect(cleanNoUnsafe.stdout).toContain("commit-id");
      expect(cleanNoUnsafe.stdout).toContain("--unsafe");

      // Verify branch was NOT deleted
      const branchStillExists =
        await $`gh api repos/${repo.github.owner}/${repo.github.repo}/branches/${pr.headRefName}`.nothrow();
      expect(branchStillExists.exitCode).toBe(0);

      // Run clean WITH --unsafe --force - should delete the branch
      story.narrate("With --unsafe --force, the branch is deleted:");
      const cleanWithForce = await runClean(repo.path, { unsafe: true, force: true });
      story.log(cleanWithForce);

      expect(cleanWithForce.exitCode).toBe(0);
      expect(cleanWithForce.stdout).toContain("Deleted");
      expect(cleanWithForce.stdout).toContain("unsafe");

      // Poll until branch is deleted (GitHub API is eventually consistent)
      const branchGone = await repo.waitForBranchGone(pr.headRefName);
      expect(branchGone).toBe(true);
    },
    { timeout: 120000 },
  );
});
