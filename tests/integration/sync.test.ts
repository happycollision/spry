import { test, expect, beforeAll, beforeEach, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { createGitHubFixture, type GitHubFixture } from "../helpers/github-fixture.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
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
    "creates PR for a single commit stack",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit
      await $`git -C ${localDir} checkout -b feature/test-pr`.quiet();
      await Bun.write(join(localDir, "test-file.txt"), "test content\n");
      await $`git -C ${localDir} add test-file.txt`.quiet();
      await $`git -C ${localDir} commit -m "Add test file"`.quiet();

      // Run taspr sync --open
      const result = await runSync(localDir, { open: true });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created");

      // Verify PR was created
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList);
      expect(prs.length).toBeGreaterThanOrEqual(1);
      expect(prs.some((pr: { title: string }) => pr.title.includes("Add test file"))).toBe(true);
    },
    { timeout: 60000 },
  );

  test(
    "opens PRs for commits already pushed to remote",
    async () => {
      // This tests the scenario where:
      // 1. User creates commits
      // 2. User runs `taspr sync` (pushes branches, but no PRs)
      // 3. User runs `taspr sync --open` (should open PRs even though remote is up-to-date)

      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create first commit
      await $`git -C ${localDir} checkout -b feature/stacked-no-pr`.quiet();
      await Bun.write(join(localDir, "first-file.txt"), "first content\n");
      await $`git -C ${localDir} add first-file.txt`.quiet();
      await $`git -C ${localDir} commit -m "First commit in stack"`.quiet();

      // Create second commit
      await Bun.write(join(localDir, "second-file.txt"), "second content\n");
      await $`git -C ${localDir} add second-file.txt`.quiet();
      await $`git -C ${localDir} commit -m "Second commit in stack"`.quiet();

      // Run taspr sync WITHOUT --open (just push branches)
      const syncResult = await runSync(localDir, { open: false });
      expect(syncResult.exitCode).toBe(0);

      // Verify no PRs were created yet
      const prListBefore =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prsBefore = JSON.parse(prListBefore);
      const relevantPrsBefore = prsBefore.filter(
        (pr: { title: string }) =>
          pr.title.includes("First commit") || pr.title.includes("Second commit"),
      );
      expect(relevantPrsBefore.length).toBe(0);

      // Now run taspr sync WITH --open
      const openResult = await runSync(localDir, { open: true });
      expect(openResult.exitCode).toBe(0);

      // Verify PRs were created
      const prListAfter =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prsAfter = JSON.parse(prListAfter);
      const relevantPrsAfter = prsAfter.filter(
        (pr: { title: string }) =>
          pr.title.includes("First commit") || pr.title.includes("Second commit"),
      );
      expect(relevantPrsAfter.length).toBe(2);
    },
    { timeout: 90000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "CI passes for normal commits",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a normal commit (no FAIL_CI marker)
      await $`git -C ${localDir} checkout -b feature/ci-pass-test`.quiet();
      await Bun.write(join(localDir, "ci-test.txt"), "this should pass CI\n");
      await $`git -C ${localDir} add ci-test.txt`.quiet();
      await $`git -C ${localDir} commit -m "Add file that should pass CI"`.quiet();

      // Run taspr sync --open
      const result = await runSync(localDir, { open: true });
      expect(result.exitCode).toBe(0);

      // Find PR by title since taspr uses its own branch naming
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;
      const pr = prs.find((p) => p.title.includes("Add file that should pass CI"));
      if (!pr) throw new Error("PR not found");
      const prNumber = pr.number;

      // Wait for CI to complete
      const ciStatus = await github.waitForCI(prNumber, { timeout: 180000 });
      expect(ciStatus.state).toBe("success");
    },
    { timeout: 200000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "CI fails for commits with [FAIL_CI] marker",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a FAIL_CI commit
      await $`git -C ${localDir} checkout -b feature/ci-fail-test`.quiet();
      await Bun.write(join(localDir, "fail-ci-test.txt"), "this should fail CI\n");
      await $`git -C ${localDir} add fail-ci-test.txt`.quiet();
      await $`git -C ${localDir} commit -m "[FAIL_CI] Add file that should fail CI"`.quiet();

      // Run taspr sync --open
      const result = await runSync(localDir, { open: true });
      expect(result.exitCode).toBe(0);

      // Find PR by title since taspr uses its own branch naming
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;
      const pr = prs.find((p) => p.title.includes("FAIL_CI"));
      if (!pr) throw new Error("PR not found");
      const prNumber = pr.number;

      // Wait for CI to complete
      const ciStatus = await github.waitForCI(prNumber, { timeout: 180000 });
      expect(ciStatus.state).toBe("failure");
    },
    { timeout: 200000 },
  );
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: sync cleanup", () => {
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

  test.skipIf(SKIP_CI_TESTS)(
    "detects merged PRs and cleans up their remote branches when merged via GitHub UI",
    async () => {
      // This tests the scenario where:
      // 1. User creates a stack with multiple commits
      // 2. User syncs to create PRs
      // 3. Someone merges a PR via GitHub UI (not taspr land)
      // 4. User runs sync again - should detect merged PR and clean up orphaned branch

      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with 2 commits
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/cleanup-test-${uniqueId}`.quiet();

      // First commit
      await Bun.write(join(localDir, `cleanup-1-${uniqueId}.txt`), "first commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "First commit for cleanup test"`.quiet();

      // Second commit
      await Bun.write(join(localDir, `cleanup-2-${uniqueId}.txt`), "second commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Second commit for cleanup test"`.quiet();

      // Run taspr sync --open to create PRs
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Get PRs
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title,headRefName`.text();
      const prs = JSON.parse(prList) as Array<{
        number: number;
        title: string;
        headRefName: string;
      }>;
      const firstPr = prs.find((p) => p.title.includes("First commit for cleanup test"));
      const secondPr = prs.find((p) => p.title.includes("Second commit for cleanup test"));
      if (!firstPr || !secondPr) throw new Error("PRs not found");

      // Wait for CI on the first PR
      await github.waitForCI(firstPr.number, { timeout: 180000 });

      // Merge the first PR via GitHub API (simulating GitHub UI merge)
      // Note: deleteBranch: false to leave the branch orphaned
      await github.mergePR(firstPr.number, { deleteBranch: false });

      // Verify first PR is merged but branch still exists
      const firstStatus =
        await $`gh pr view ${firstPr.number} --repo ${github.owner}/${github.repo} --json state`.text();
      expect(JSON.parse(firstStatus).state).toBe("MERGED");

      // Verify the branch still exists (orphaned)
      const branchCheck =
        await $`gh api repos/${github.owner}/${github.repo}/branches/${firstPr.headRefName}`.nothrow();
      expect(branchCheck.exitCode).toBe(0); // Branch should still exist

      // Now run sync again - it should detect the merged PR and clean up the orphaned branch
      const syncResult2 = await runSync(localDir, { open: false });

      expect(syncResult2.exitCode).toBe(0);
      expect(syncResult2.stdout).toContain("Cleaned up");
      expect(syncResult2.stdout).toContain(`#${firstPr.number}`);

      // Verify the orphaned branch was deleted
      // Poll for eventual consistency
      let branchGone = false;
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(500);
        const afterCheck =
          await $`gh api repos/${github.owner}/${github.repo}/branches/${firstPr.headRefName}`.nothrow();
        if (afterCheck.exitCode !== 0) {
          branchGone = true;
          break;
        }
      }
      expect(branchGone).toBe(true);

      // The second PR should still be tracked (not cleaned up)
      const secondStatus =
        await $`gh pr view ${secondPr.number} --repo ${github.owner}/${github.repo} --json state`.text();
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
