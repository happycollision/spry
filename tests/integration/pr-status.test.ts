import { test, expect, beforeAll, beforeEach, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { createGitHubFixture, type GitHubFixture } from "../helpers/github-fixture.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { SKIP_GITHUB_TESTS, SKIP_CI_TESTS, runSync } from "./helpers.ts";
import { getPRChecksStatus, getPRReviewStatus, getPRCommentStatus } from "../../src/github/pr.ts";

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: PR checks status", () => {
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
    "returns 'passing' for PR with passing CI checks",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/checks-pass-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `checks-pass-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Add file that will pass CI"`.quiet();

      // Run taspr sync --open to create the PR
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find the PR number
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;
      const pr = prs.find((p) => p.title.includes("Add file that will pass CI"));
      if (!pr) throw new Error("PR not found");

      // Wait for CI to complete
      await github.waitForCI(pr.number, { timeout: 180000 });

      // Check the status using our function
      const status = await getPRChecksStatus(pr.number, `${github.owner}/${github.repo}`);
      expect(status).toBe("passing");
    },
    { timeout: 200000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "returns 'failing' for PR with failing CI checks",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit that will fail CI
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/checks-fail-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `checks-fail-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "[FAIL_CI] Add file that will fail CI"`.quiet();

      // Run taspr sync --open to create the PR
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find the PR number
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;
      const pr = prs.find((p) => p.title.includes("FAIL_CI"));
      if (!pr) throw new Error("PR not found");

      // Wait for CI to complete (and fail)
      await github.waitForCI(pr.number, { timeout: 180000 });

      // Check the status using our function
      const status = await getPRChecksStatus(pr.number, `${github.owner}/${github.repo}`);
      expect(status).toBe("failing");
    },
    { timeout: 200000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "returns 'pending' for PR with running CI checks",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a commit with [CI_SLOW_TEST] marker - CI will take 30+ seconds
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/checks-pending-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `checks-pending-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "[CI_SLOW_TEST] Add file with slow CI"`.quiet();

      // Run taspr sync --open to create the PR
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find the PR number
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;
      const pr = prs.find((p) => p.title.includes("CI_SLOW_TEST"));
      if (!pr) throw new Error("PR not found");

      // Wait for CI to start (but not complete)
      await github.waitForCIToStart(pr.number);

      // Check the status using our function - should be pending
      const status = await getPRChecksStatus(pr.number, `${github.owner}/${github.repo}`);
      expect(status).toBe("pending");
    },
    { timeout: 120000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "returns 'none' for PR with no CI checks configured",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch that removes the CI workflow
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/no-ci-${uniqueId}`.quiet();

      // Delete the CI workflow file
      await $`git -C ${localDir} rm .github/workflows/ci.yml`.quiet();
      await $`git -C ${localDir} commit -m "Remove CI workflow for testing"`.quiet();

      // Push the branch and create PR manually (not using taspr sync since we need the workflow deleted)
      await $`git -C ${localDir} push origin feature/no-ci-${uniqueId}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${github.owner}/${github.repo} --head feature/no-ci-${uniqueId} --title "Remove CI workflow" --body "Testing no CI"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Wait a moment for GitHub to process the PR
      await Bun.sleep(5000);

      // Check the status - should be "none" since there's no CI workflow
      const status = await getPRChecksStatus(prNumber, `${github.owner}/${github.repo}`);
      expect(status).toBe("none");
    },
    { timeout: 120000 },
  );
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: PR review status", () => {
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
    "returns 'none' for PR with no review requirements",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit (remove CI workflow for faster testing)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/review-none-${uniqueId}`.quiet();
      await $`git -C ${localDir} rm .github/workflows/ci.yml`.quiet();
      await Bun.write(join(localDir, `review-none-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Add file for review test"`.quiet();

      // Push and create PR
      await $`git -C ${localDir} push origin feature/review-none-${uniqueId}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${github.owner}/${github.repo} --head feature/review-none-${uniqueId} --title "Test PR for review status" --body "Testing review status"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Wait a moment for GitHub to process the PR
      await Bun.sleep(2000);

      // Check the review status - should be "none" since no review requirements are set
      const status = await getPRReviewStatus(prNumber, `${github.owner}/${github.repo}`);
      expect(status).toBe("none");
    },
    { timeout: 60000 },
  );

  // Note: This test is skipped because GitHub doesn't allow you to approve your own PR.
  // The getPRReviewStatus function is still tested via unit tests for determineReviewDecision.
  // To manually test this, create a PR and have another user approve it.
  test.skip(
    "returns 'approved' after PR is approved",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit (remove CI workflow for faster testing)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/review-approved-${uniqueId}`.quiet();
      await $`git -C ${localDir} rm .github/workflows/ci.yml`.quiet();
      await Bun.write(join(localDir, `review-approved-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Add file for approval test"`.quiet();

      // Push and create PR
      await $`git -C ${localDir} push origin feature/review-approved-${uniqueId}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${github.owner}/${github.repo} --head feature/review-approved-${uniqueId} --title "Test PR for approval" --body "Testing approval"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Approve the PR using gh
      await $`gh pr review ${prNumber} --repo ${github.owner}/${github.repo} --approve --body "LGTM"`.quiet();

      // Wait a moment for GitHub to process the review
      await Bun.sleep(2000);

      // Check the review status - should be "approved"
      const status = await getPRReviewStatus(prNumber, `${github.owner}/${github.repo}`);
      expect(status).toBe("approved");
    },
    { timeout: 60000 },
  );

  // Note: This test is skipped because GitHub doesn't allow you to request changes on your own PR.
  // The getPRReviewStatus function is still tested via unit tests for determineReviewDecision.
  // To manually test this, create a PR and have another user request changes.
  test.skip(
    "returns 'changes_requested' after changes are requested",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit (remove CI workflow for faster testing)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/review-changes-${uniqueId}`.quiet();
      await $`git -C ${localDir} rm .github/workflows/ci.yml`.quiet();
      await Bun.write(join(localDir, `review-changes-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Add file for changes requested test"`.quiet();

      // Push and create PR
      await $`git -C ${localDir} push origin feature/review-changes-${uniqueId}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${github.owner}/${github.repo} --head feature/review-changes-${uniqueId} --title "Test PR for changes requested" --body "Testing changes requested"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Request changes on the PR using gh
      await $`gh pr review ${prNumber} --repo ${github.owner}/${github.repo} --request-changes --body "Please fix this"`.quiet();

      // Wait a moment for GitHub to process the review
      await Bun.sleep(2000);

      // Check the review status - should be "changes_requested"
      const status = await getPRReviewStatus(prNumber, `${github.owner}/${github.repo}`);
      expect(status).toBe("changes_requested");
    },
    { timeout: 60000 },
  );

  test(
    "returns 'review_required' when branch protection requires reviews",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Enable branch protection requiring reviews
      await github.enableBranchProtection("main", {
        requirePullRequestReviews: true,
        requiredApprovingReviewCount: 1,
      });

      try {
        // Create a feature branch with a commit (remove CI workflow for faster testing)
        const uniqueId = Date.now().toString(36);
        await $`git -C ${localDir} checkout -b feature/review-required-${uniqueId}`.quiet();
        await $`git -C ${localDir} rm .github/workflows/ci.yml`.quiet();
        await Bun.write(join(localDir, `review-required-${uniqueId}.txt`), "test content\n");
        await $`git -C ${localDir} add .`.quiet();
        await $`git -C ${localDir} commit -m "Add file for review required test"`.quiet();

        // Push and create PR
        await $`git -C ${localDir} push origin feature/review-required-${uniqueId}`.quiet();
        const prCreateResult =
          await $`gh pr create --repo ${github.owner}/${github.repo} --head feature/review-required-${uniqueId} --title "Test PR for review required" --body "Testing review required"`.text();
        const prUrl = prCreateResult.trim();
        const prMatch = prUrl.match(/\/pull\/(\d+)$/);
        if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
        const prNumber = parseInt(prMatch[1], 10);

        // Wait a moment for GitHub to process the PR
        await Bun.sleep(2000);

        // Check the review status - should be "review_required" since branch protection requires it
        const status = await getPRReviewStatus(prNumber, `${github.owner}/${github.repo}`);
        expect(status).toBe("review_required");
      } finally {
        // Always disable branch protection
        await github.disableBranchProtection("main");
      }
    },
    { timeout: 60000 },
  );
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: PR comment status", () => {
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
    "returns zero counts for PR with no review threads",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit (remove CI workflow for faster testing)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/no-comments-${uniqueId}`.quiet();
      await $`git -C ${localDir} rm .github/workflows/ci.yml`.quiet();
      await Bun.write(join(localDir, `no-comments-${uniqueId}.txt`), "test content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Add file for no comments test"`.quiet();

      // Push and create PR
      await $`git -C ${localDir} push origin feature/no-comments-${uniqueId}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${github.owner}/${github.repo} --head feature/no-comments-${uniqueId} --title "Test PR with no comments" --body "Testing no comments"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Wait a moment for GitHub to process the PR
      await Bun.sleep(2000);

      // Check the comment status - should have 0 total and 0 resolved
      const status = await getPRCommentStatus(prNumber, `${github.owner}/${github.repo}`);
      expect(status).toEqual({ total: 0, resolved: 0 });
    },
    { timeout: 60000 },
  );

  test(
    "returns correct counts for PR with unresolved review thread",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit (remove CI workflow for faster testing)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/with-comment-${uniqueId}`.quiet();
      await $`git -C ${localDir} rm .github/workflows/ci.yml`.quiet();
      await Bun.write(
        join(localDir, `with-comment-${uniqueId}.txt`),
        "test content line 1\ntest content line 2\n",
      );
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Add file for comment thread test"`.quiet();

      // Push and create PR
      await $`git -C ${localDir} push origin feature/with-comment-${uniqueId}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${github.owner}/${github.repo} --head feature/with-comment-${uniqueId} --title "Test PR with comment thread" --body "Testing comment threads"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Wait a moment for GitHub to process the PR
      await Bun.sleep(2000);

      // Add a review comment on a specific line using GraphQL
      // First, get the commit SHA for the PR head
      const prDetails =
        await $`gh pr view ${prNumber} --repo ${github.owner}/${github.repo} --json headRefOid`.text();
      const { headRefOid } = JSON.parse(prDetails);

      // Get the PR node ID first
      const prNodeResult =
        await $`gh api graphql -f query='query { repository(owner: "${github.owner}", name: "${github.repo}") { pullRequest(number: ${prNumber}) { id } } }'`.text();
      const prNodeId = JSON.parse(prNodeResult).data.repository.pullRequest.id;

      // Add review comment using GraphQL
      await $`gh api graphql -f query='mutation {
        addPullRequestReview(input: {
          pullRequestId: "${prNodeId}",
          event: COMMENT,
          threads: [{
            path: "with-comment-${uniqueId}.txt",
            line: 1,
            body: "This is a test review comment"
          }],
          commitOID: "${headRefOid}"
        }) {
          pullRequestReview { id }
        }
      }'`.quiet();

      // Wait for GitHub to process the comment
      await Bun.sleep(2000);

      // Check the comment status - should have 1 total and 0 resolved
      const status = await getPRCommentStatus(prNumber, `${github.owner}/${github.repo}`);
      expect(status.total).toBe(1);
      expect(status.resolved).toBe(0);
    },
    { timeout: 60000 },
  );
});
