import { test, expect, beforeAll, beforeEach, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { createGitHubFixture, type GitHubFixture } from "../helpers/github-fixture.ts";
import { repoManager } from "../helpers/local-repo.ts";
import { SKIP_GITHUB_TESTS, SKIP_CI_TESTS, runSync } from "./helpers.ts";

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration", () => {
  let github: GitHubFixture;

  beforeAll(async () => {
    github = await createGitHubFixture();
  });

  beforeEach(async () => {
    // Reset to clean state before each test
    const report = await github.reset();
    if (report.prsClosed > 0 || report.branchesDeleted > 0) {
      console.log(
        `Reset: closed ${report.prsClosed} PRs, deleted ${report.branchesDeleted} branches`,
      );
    }
  });

  afterEach(async () => {
    // Clean up after each test
    await github.reset();
  });

  test("fixture can connect to test repository", async () => {
    expect(github.owner).toBeTruthy();
    expect(github.repo).toBe(process.env.TASPR_TEST_REPO_NAME || "taspr-check");
    expect(github.repoUrl).toContain("github.com");
  });

  test("reset cleans up branches and PRs", async () => {
    // Create a branch directly via API
    const sha = (
      await $`gh api repos/${github.owner}/${github.repo}/git/refs/heads/main --jq .object.sha`.text()
    ).trim();
    await $`gh api repos/${github.owner}/${github.repo}/git/refs -f ref=refs/heads/test-cleanup-branch -f sha=${sha}`.quiet();

    // Verify branch exists
    const branchCheck =
      await $`gh api repos/${github.owner}/${github.repo}/branches/test-cleanup-branch`.nothrow();
    expect(branchCheck.exitCode).toBe(0);

    // Reset should clean it up
    const report = await github.reset();
    expect(report.branchesDeleted).toBeGreaterThanOrEqual(1);

    // Poll until branch is gone (GitHub API is eventually consistent)
    let branchGone = false;
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(500);
      const afterCheck =
        await $`gh api repos/${github.owner}/${github.repo}/branches/test-cleanup-branch`.nothrow();
      if (afterCheck.exitCode !== 0) {
        branchGone = true;
        break;
      }
    }
    expect(branchGone).toBe(true);
  });
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: sync --open", () => {
  const repos = repoManager({ github: true });

  test(
    "skips PR creation for WIP commits",
    async () => {
      const repo = await repos.clone({ testName: "wip-skip" });
      await repo.branch("feature/wip-test");
      await repo.commit({ message: "WIP: work in progress" });

      const result = await runSync(repo.path, { open: true });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Skipped PR for 1 temporary commit");
      expect(result.stdout).toContain("WIP: work in progress");

      // Verify NO PR was created (search by uniqueId to isolate from other tests)
      const prs = await repo.findPRs(repo.uniqueId);
      expect(prs.length).toBe(0);
    },
    { timeout: 60000 },
  );

  test(
    "skips PR creation for fixup! commits",
    async () => {
      const repo = await repos.clone({ testName: "fixup-skip" });
      await repo.branch("feature/fixup-test");
      await repo.commit({ message: "fixup! original commit" });

      const result = await runSync(repo.path, { open: true });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Skipped PR for 1 temporary commit");
      expect(result.stdout).toContain("fixup! original commit");

      // Verify NO PR was created
      const prs = await repo.findPRs(repo.uniqueId);
      expect(prs.length).toBe(0);
    },
    { timeout: 60000 },
  );

  test(
    "creates PRs for non-temp commits while skipping temp commits in same stack",
    async () => {
      const repo = await repos.clone({ testName: "mixed-stack" });
      await repo.branch("feature/mixed-test");
      await repo.commit({ message: "Add feature A" }); // should get PR
      await repo.commit({ message: "WIP: still working on B" }); // should be skipped

      const result = await runSync(repo.path, { open: true });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created 1 PR");
      expect(result.stdout).toContain("Skipped PR for 1 temporary commit");

      // Verify only 1 PR was created (for the non-WIP commit)
      const prs = await repo.findPRs(repo.uniqueId);
      expect(prs.length).toBe(1);
    },
    { timeout: 60000 },
  );

  test(
    "creates PR for a single commit stack",
    async () => {
      const repo = await repos.clone({ testName: "single-pr" });
      await repo.branch("feature/test-pr");
      await repo.commit();

      const result = await runSync(repo.path, { open: true });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created");

      // Verify PR was created
      const prs = await repo.findPRs(repo.uniqueId);
      expect(prs.length).toBeGreaterThanOrEqual(1);
    },
    { timeout: 60000 },
  );

  test(
    "opens PRs for commits already pushed to remote",
    async () => {
      const repo = await repos.clone({ testName: "open-existing" });
      await repo.branch("feature/stacked-no-pr");
      await repo.commit();
      await repo.commit();

      // Run taspr sync WITHOUT --open (just push branches)
      const syncResult = await runSync(repo.path, { open: false });
      expect(syncResult.exitCode).toBe(0);

      // Verify no PRs were created yet (search by uniqueId to isolate from other tests)
      const prsBefore = await repo.findPRs(repo.uniqueId);
      expect(prsBefore.length).toBe(0);

      // Now run taspr sync WITH --open
      const openResult = await runSync(repo.path, { open: true });
      expect(openResult.exitCode).toBe(0);

      // Verify PRs were created
      const prsAfter = await repo.findPRs(repo.uniqueId);
      expect(prsAfter.length).toBe(2);
    },
    { timeout: 90000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "CI passes for normal commits",
    async () => {
      const repo = await repos.clone({ testName: "ci-pass" });
      await repo.branch("feature/ci-pass-test");
      await repo.commit();

      const result = await runSync(repo.path, { open: true });
      expect(result.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to complete
      const ciStatus = await repo.github.waitForCI(pr.number, { timeout: 180000 });
      expect(ciStatus.state).toBe("success");
    },
    { timeout: 200000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "CI fails for commits with [FAIL_CI] marker",
    async () => {
      const repo = await repos.clone({ testName: "sync-ci-fail" });
      await repo.branch("feature/ci-fail-test");
      await repo.commit({ message: "[FAIL_CI] trigger CI failure" });

      const result = await runSync(repo.path, { open: true });
      expect(result.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to complete
      const ciStatus = await repo.github.waitForCI(pr.number, { timeout: 180000 });
      expect(ciStatus.state).toBe("failure");
    },
    { timeout: 200000 },
  );
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: sync cleanup", () => {
  const repos = repoManager({ github: true });

  test.skipIf(SKIP_CI_TESTS)(
    "detects merged PRs and cleans up their remote branches when merged via GitHub UI",
    async () => {
      const repo = await repos.clone({ testName: "cleanup" });
      await repo.branch("feature/cleanup-test");
      await repo.commit();
      await repo.commit();

      // Run taspr sync --open to create PRs
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Get PRs (both will have uniqueId in title)
      const prs = await repo.findPRs(repo.uniqueId);
      expect(prs.length).toBe(2);
      const firstPr = prs[0];
      const secondPr = prs[1];
      if (!firstPr || !secondPr) throw new Error("Expected 2 PRs");

      // Wait for CI on the first PR
      await repo.github.waitForCI(firstPr.number, { timeout: 180000 });

      // Merge the first PR via GitHub API (simulating GitHub UI merge)
      // Note: deleteBranch: false to leave the branch orphaned
      await repo.github.mergePR(firstPr.number, { deleteBranch: false });

      // Verify first PR is merged but branch still exists
      const firstStatus =
        await $`gh pr view ${firstPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(firstStatus).state).toBe("MERGED");

      // Verify the branch still exists (orphaned)
      const branchCheck =
        await $`gh api repos/${repo.github.owner}/${repo.github.repo}/branches/${firstPr.headRefName}`.nothrow();
      expect(branchCheck.exitCode).toBe(0); // Branch should still exist

      // Now run sync again - it should detect the merged PR and clean up the orphaned branch
      const syncResult2 = await runSync(repo.path, { open: false });

      expect(syncResult2.exitCode).toBe(0);
      expect(syncResult2.stdout).toContain("Cleaned up");
      expect(syncResult2.stdout).toContain(`#${firstPr.number}`);

      // Verify the orphaned branch was deleted
      const branchGone = await repo.waitForBranchGone(firstPr.headRefName);
      expect(branchGone).toBe(true);

      // The second PR should still be tracked (not cleaned up)
      const secondStatus =
        await $`gh pr view ${secondPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(secondStatus).state).toBe("OPEN");
    },
    { timeout: 300000 },
  );
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: Branch Protection", () => {
  let github: GitHubFixture;

  beforeAll(async () => {
    github = await createGitHubFixture();
  });

  beforeEach(async () => {
    await github.reset();
    // Ensure branch protection is off at start
    await github.disableBranchProtection("main");
  });

  afterEach(async () => {
    // Always clean up branch protection
    await github.disableBranchProtection("main");
    await github.reset();
  });

  test("can enable and disable branch protection", async () => {
    // Enable protection
    await github.enableBranchProtection("main", {
      requireStatusChecks: true,
      requiredStatusChecks: ["check"],
    });

    // Verify enabled
    const status = await github.getBranchProtection("main");
    expect(status).not.toBeNull();
    expect(status?.enabled).toBe(true);
    expect(status?.requireStatusChecks).toBe(true);

    // Disable protection
    await github.disableBranchProtection("main");

    // Verify disabled
    const statusAfter = await github.getBranchProtection("main");
    expect(statusAfter).toBeNull();
  });

  test("can require PR reviews", async () => {
    await github.enableBranchProtection("main", {
      requirePullRequestReviews: true,
      requiredApprovingReviewCount: 1,
    });

    const status = await github.getBranchProtection("main");
    expect(status?.requirePullRequestReviews).toBe(true);
    expect(status?.requiredApprovingReviewCount).toBe(1);
  });
});
