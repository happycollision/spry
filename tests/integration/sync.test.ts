import { expect, beforeAll, beforeEach, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { createGitHubFixture, type GitHubFixture } from "../helpers/github-fixture.ts";
import { repoManager } from "../helpers/local-repo.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { SKIP_GITHUB_TESTS, SKIP_CI_TESTS, runSync } from "./helpers.ts";

const { test } = createStoryTest("sync.test.ts");

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

  test.noStory("fixture can connect to test repository", async () => {
    expect(github.owner).toBeTruthy();
    expect(github.repo).toBe(process.env.SPRY_TEST_REPO_NAME || "spry-check");
    expect(github.repoUrl).toContain("github.com");
  });

  test.noStory("reset cleans up branches and PRs", async () => {
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
    "Skipping WIP commits",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "If you have a commit prefixed with 'WIP:', sp will push branches but skip opening a PR for it.",
      );

      const repo = await repos.clone({ testName: "wip-skip" });
      await repo.branch("feature/wip-test");
      await repo.commit({ message: "WIP: work in progress" });

      const result = await runSync(repo.path, { open: true });
      story.log(result);

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
    "Skipping fixup! commits",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "Commits prefixed with 'fixup!' are meant to be squashed later, so sp skips opening PRs for them.",
      );

      const repo = await repos.clone({ testName: "fixup-skip" });
      await repo.branch("feature/fixup-test");
      await repo.commit({ message: "fixup! original commit" });

      const result = await runSync(repo.path, { open: true });
      story.log(result);

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
    "Mixed stack with temp commits",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When a stack has both regular and temporary commits, sp creates PRs for the regular commits and skips the temporary ones.",
      );

      const repo = await repos.clone({ testName: "mixed-stack" });
      await repo.branch("feature/mixed-test");
      await repo.commit({ message: "Add feature A" }); // should get PR
      await repo.commit({ message: "WIP: still working on B" }); // should be skipped

      const result = await runSync(repo.path, { open: true });
      story.log(result);

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
    "Single commit PR creation",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate("A feature branch with a single commit gets one PR created.");

      const repo = await repos.clone({ testName: "single-pr" });
      await repo.branch("feature/test-pr");
      await repo.commit();

      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created");

      // Verify PR was created
      const prs = await repo.findPRs(repo.uniqueId);
      expect(prs.length).toBeGreaterThanOrEqual(1);
    },
    { timeout: 60000 },
  );

  test(
    "Opening PRs for existing branches",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "If branches were previously pushed without --open, running sync --open later will create PRs for them.",
      );

      const repo = await repos.clone({ testName: "open-existing" });
      await repo.branch("feature/stacked-no-pr");
      await repo.commit();
      await repo.commit();

      // Run sp sync WITHOUT --open (just push branches)
      const syncResult = await runSync(repo.path, { open: false });
      story.narrate("First, sync without --open to just push branches:");
      story.log(syncResult);
      expect(syncResult.exitCode).toBe(0);

      // Verify no PRs were created yet (search by uniqueId to isolate from other tests)
      const prsBefore = await repo.findPRs(repo.uniqueId);
      expect(prsBefore.length).toBe(0);

      // Now run sp sync WITH --open
      story.narrate("Then, sync with --open to create PRs:");
      const openResult = await runSync(repo.path, { open: true });
      story.log(openResult);

      expect(openResult.exitCode).toBe(0);

      // Verify PRs were created
      const prsAfter = await repo.findPRs(repo.uniqueId);
      expect(prsAfter.length).toBe(2);
    },
    { timeout: 90000 },
  );

  test.noStory.skipIf(SKIP_CI_TESTS)(
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

  test.noStory.skipIf(SKIP_CI_TESTS)(
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

  test.noStory.skipIf(SKIP_CI_TESTS)(
    "detects merged PRs and cleans up their remote branches when merged via GitHub UI",
    async () => {
      const repo = await repos.clone({ testName: "cleanup" });
      await repo.branch("feature/cleanup-test");
      await repo.commit();
      await repo.commit();

      // Run sp sync --open to create PRs
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

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: PR Body Generation", () => {
  const repos = repoManager({ github: true });

  /** Helper to get PR body via gh CLI */
  async function getPRBody(
    github: { owner: string; repo: string },
    prNumber: number,
  ): Promise<string> {
    const result =
      await $`gh pr view ${prNumber} --repo ${github.owner}/${github.repo} --json body`.text();
    return JSON.parse(result).body || "";
  }

  test(
    "PR body from commit message",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate("When creating a PR, sp generates a body with the commit message content.");

      const repo = await repos.clone({ testName: "pr-body-basic" });
      await repo.branch("feature/body-test");
      // Use default commit (with auto-generated title containing uniqueId) but add body via commitFiles
      await repo.commitFiles(
        { "feature.txt": "New feature content" },
        {
          message: `Add feature [${repo.uniqueId}]\n\nThis is a detailed description of the feature.`,
        },
      );

      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);
      const body = await getPRBody(repo.github, pr.number);

      // Body should contain spry markers
      expect(body).toContain("<!-- spry:body:begin -->");
      expect(body).toContain("<!-- spry:body:end -->");
      // Body should contain the commit description
      expect(body).toContain("This is a detailed description of the feature.");
      // Footer should be present
      expect(body).toContain("<!-- spry:footer:begin -->");
      expect(body).toContain("Spry");
    },
    { timeout: 60000 },
  );

  test(
    "Stack links in PR body",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When a stack has multiple PRs, each PR body contains links to all PRs in the stack.",
      );

      const repo = await repos.clone({ testName: "pr-body-stack" });
      await repo.branch("feature/stack-links-test");
      await repo.commit({ message: "First commit in stack" });
      await repo.commit({ message: "Second commit in stack" });

      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created 2 PR");

      const prs = await repo.findPRs(repo.uniqueId);
      expect(prs.length).toBe(2);

      // Check first PR body has stack links
      const firstPR = prs.find((p) => p.title.includes("First commit"));
      if (!firstPR) throw new Error("First PR not found");

      const body = await getPRBody(repo.github, firstPR.number);

      // Should have stack links section
      expect(body).toContain("<!-- spry:stack-links:begin -->");
      expect(body).toContain("<!-- spry:stack-links:end -->");
      expect(body).toContain("**Stack**");
      expect(body).toContain("← this PR");
    },
    { timeout: 90000 },
  );

  test(
    "Group PR with commit list",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When multiple commits are grouped, the PR body lists all commit subjects as bullet points. " +
          "Using --allow-untitled-pr since this group has no stored title.",
      );

      const repo = await repos.clone({ testName: "pr-body-group" });
      await repo.branch("feature/group-body-test");

      // Create grouped commits - the group ID needs to match pattern and commit messages get uniqueId appended
      const groupId = `group-${repo.uniqueId}`;
      await repo.commit({
        message: `Start feature X [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });
      await repo.commit({
        message: `Continue feature X [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });
      await repo.commit({
        message: `Complete feature X [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });

      // Use --allow-untitled-pr since this group has no stored title
      const result = await runSync(repo.path, { open: true, allowUntitledPr: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created 1 PR");

      const pr = await repo.findPR(repo.uniqueId);
      const body = await getPRBody(repo.github, pr.number);

      // Body should list all commit subjects
      expect(body).toContain("- Start feature X");
      expect(body).toContain("- Continue feature X");
      expect(body).toContain("- Complete feature X");
    },
    { timeout: 60000 },
  );

  test(
    "Untitled group PR error",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When a group has no stored title and --allow-untitled-pr is not set, sync fails with a helpful error.",
      );

      const repo = await repos.clone({ testName: "pr-body-untitled-fail" });
      await repo.branch("feature/untitled-group-test");

      // Create grouped commits without a stored title
      const groupId = `group-${repo.uniqueId}`;
      await repo.commit({
        message: `First commit [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });
      await repo.commit({
        message: `Second commit [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });

      // Without --allow-untitled-pr, this should fail
      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("has no stored title");
      expect(result.stderr).toContain("sp group");
      expect(result.stderr).toContain("--allow-untitled-pr");
    },
    { timeout: 60000 },
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

  test.noStory("can enable and disable branch protection", async () => {
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

  test.noStory("can require PR reviews", async () => {
    await github.enableBranchProtection("main", {
      requirePullRequestReviews: true,
      requiredApprovingReviewCount: 1,
    });

    const status = await github.getBranchProtection("main");
    expect(status?.requirePullRequestReviews).toBe(true);
    expect(status?.requiredApprovingReviewCount).toBe(1);
  });
});
