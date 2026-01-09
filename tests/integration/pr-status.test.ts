import { test, expect, describe, afterAll } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { createStory } from "../helpers/story.ts";
import { SKIP_GITHUB_TESTS, SKIP_CI_TESTS, runSync } from "./helpers.ts";
import { getPRChecksStatus, getPRReviewStatus, getPRCommentStatus } from "../../src/github/pr.ts";

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: PR checks status", () => {
  const repos = repoManager({ github: true });
  const story = createStory("pr-status.test.ts");

  afterAll(async () => {
    await story.flush();
  });

  test.skipIf(SKIP_CI_TESTS)(
    "returns 'passing' for PR with passing CI checks",
    async () => {
      story.begin("returns 'passing' for PR with passing CI checks", repos.uniqueId);
      story.narrate("After CI passes on a PR, getPRChecksStatus returns 'passing'.");

      const repo = await repos.clone({ testName: "checks-pass" });
      await repo.branch("feature/checks-pass");
      await repo.commit();

      const syncResult = await runSync(repo.path, { open: true });
      story.log(syncResult);
      story.end();
      expect(syncResult.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to complete
      await repo.github.waitForCI(pr.number, { timeout: 180000 });

      // Check the status using our function
      const status = await getPRChecksStatus(pr.number, `${repo.github.owner}/${repo.github.repo}`);
      expect(status).toBe("passing");
    },
    { timeout: 200000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "returns 'failing' for PR with failing CI checks",
    async () => {
      story.begin("returns 'failing' for PR with failing CI checks", repos.uniqueId);
      story.narrate("When CI fails on a PR, getPRChecksStatus returns 'failing'.");

      const repo = await repos.clone({ testName: "checks-fail" });
      await repo.branch("feature/checks-fail");
      await repo.commit({ message: "[FAIL_CI] trigger CI failure" });

      const syncResult = await runSync(repo.path, { open: true });
      story.log(syncResult);
      story.end();
      expect(syncResult.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to complete (and fail)
      await repo.github.waitForCI(pr.number, { timeout: 180000 });

      // Check the status using our function
      const status = await getPRChecksStatus(pr.number, `${repo.github.owner}/${repo.github.repo}`);
      expect(status).toBe("failing");
    },
    { timeout: 200000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "returns 'pending' for PR with running CI checks",
    async () => {
      story.begin("returns 'pending' for PR with running CI checks", repos.uniqueId);
      story.narrate("While CI is still running on a PR, getPRChecksStatus returns 'pending'.");

      const repo = await repos.clone({ testName: "checks-pending" });
      await repo.branch("feature/checks-pending");
      await repo.commit({ message: "[CI_SLOW_TEST] slow commit" });

      const syncResult = await runSync(repo.path, { open: true });
      story.log(syncResult);
      story.end();
      expect(syncResult.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to start (but not complete)
      await repo.github.waitForCIToStart(pr.number);

      // Check the status using our function - should be pending
      const status = await getPRChecksStatus(pr.number, `${repo.github.owner}/${repo.github.repo}`);
      expect(status).toBe("pending");
    },
    { timeout: 120000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "returns 'none' for PR with no CI checks configured",
    async () => {
      const repo = await repos.clone({ testName: "no-ci" });
      const branchName = await repo.branch("feature/no-ci");

      // Delete the CI workflow file
      await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
      await $`git -C ${repo.path} commit -m "Remove CI workflow for testing"`.quiet();

      // Push the branch and create PR manually (not using sp sync since we need the workflow deleted)
      await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${repo.github.owner}/${repo.github.repo} --head ${branchName} --title "Remove CI workflow" --body "Testing no CI"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Wait a moment for GitHub to process the PR
      await Bun.sleep(5000);

      // Check the status - should be "none" since there's no CI workflow
      const status = await getPRChecksStatus(prNumber, `${repo.github.owner}/${repo.github.repo}`);
      expect(status).toBe("none");
    },
    { timeout: 120000 },
  );
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: PR review status", () => {
  const repos = repoManager({ github: true });

  test(
    "returns 'none' for PR with no review requirements",
    async () => {
      const repo = await repos.clone({ testName: "review-none" });
      const branchName = await repo.branch("feature/review-none");

      // Remove CI workflow for faster testing
      await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
      await repo.commit();

      // Push and create PR
      await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${repo.github.owner}/${repo.github.repo} --head ${branchName} --title "Test PR for review status" --body "Testing review status"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Wait a moment for GitHub to process the PR
      await Bun.sleep(2000);

      // Check the review status - should be "none" since no review requirements are set
      const status = await getPRReviewStatus(prNumber, `${repo.github.owner}/${repo.github.repo}`);
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
      const repo = await repos.clone({ testName: "review-approved" });
      const branchName = await repo.branch("feature/review-approved");

      // Remove CI workflow for faster testing
      await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
      await repo.commit();

      // Push and create PR
      await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${repo.github.owner}/${repo.github.repo} --head ${branchName} --title "Test PR for approval" --body "Testing approval"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Approve the PR using gh
      await $`gh pr review ${prNumber} --repo ${repo.github.owner}/${repo.github.repo} --approve --body "LGTM"`.quiet();

      // Wait a moment for GitHub to process the review
      await Bun.sleep(2000);

      // Check the review status - should be "approved"
      const status = await getPRReviewStatus(prNumber, `${repo.github.owner}/${repo.github.repo}`);
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
      const repo = await repos.clone({ testName: "review-changes" });
      const branchName = await repo.branch("feature/review-changes");

      // Remove CI workflow for faster testing
      await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
      await repo.commit();

      // Push and create PR
      await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${repo.github.owner}/${repo.github.repo} --head ${branchName} --title "Test PR for changes requested" --body "Testing changes requested"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Request changes on the PR using gh
      await $`gh pr review ${prNumber} --repo ${repo.github.owner}/${repo.github.repo} --request-changes --body "Please fix this"`.quiet();

      // Wait a moment for GitHub to process the review
      await Bun.sleep(2000);

      // Check the review status - should be "changes_requested"
      const status = await getPRReviewStatus(prNumber, `${repo.github.owner}/${repo.github.repo}`);
      expect(status).toBe("changes_requested");
    },
    { timeout: 60000 },
  );

  test(
    "returns 'review_required' when branch protection requires reviews",
    async () => {
      const repo = await repos.clone({ testName: "review-required" });

      // Enable branch protection requiring reviews
      await repo.github.enableBranchProtection("main", {
        requirePullRequestReviews: true,
        requiredApprovingReviewCount: 1,
      });

      try {
        const branchName = await repo.branch("feature/review-required");

        // Remove CI workflow for faster testing
        await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
        await repo.commit();

        // Push and create PR
        await $`git -C ${repo.path} push origin ${branchName}`.quiet();
        const prCreateResult =
          await $`gh pr create --repo ${repo.github.owner}/${repo.github.repo} --head ${branchName} --title "Test PR for review required" --body "Testing review required"`.text();
        const prUrl = prCreateResult.trim();
        const prMatch = prUrl.match(/\/pull\/(\d+)$/);
        if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
        const prNumber = parseInt(prMatch[1], 10);

        // Wait a moment for GitHub to process the PR
        await Bun.sleep(2000);

        // Check the review status - should be "review_required" since branch protection requires it
        const status = await getPRReviewStatus(
          prNumber,
          `${repo.github.owner}/${repo.github.repo}`,
        );
        expect(status).toBe("review_required");
      } finally {
        // Always disable branch protection
        await repo.github.disableBranchProtection("main");
      }
    },
    { timeout: 60000 },
  );
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: PR comment status", () => {
  const repos = repoManager({ github: true });

  test(
    "returns zero counts for PR with no review threads",
    async () => {
      const repo = await repos.clone({ testName: "no-comments" });
      const branchName = await repo.branch("feature/no-comments");

      // Remove CI workflow for faster testing
      await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
      await repo.commit();

      // Push and create PR
      await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${repo.github.owner}/${repo.github.repo} --head ${branchName} --title "Test PR with no comments" --body "Testing no comments"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Wait a moment for GitHub to process the PR
      await Bun.sleep(2000);

      // Check the comment status - should have 0 total and 0 resolved
      const status = await getPRCommentStatus(prNumber, `${repo.github.owner}/${repo.github.repo}`);
      expect(status).toEqual({ total: 0, resolved: 0 });
    },
    { timeout: 60000 },
  );

  test(
    "returns correct counts for PR with unresolved review thread",
    async () => {
      const repo = await repos.clone({ testName: "with-comment" });
      const uniqueId = Date.now().toString(36);
      const branchName = await repo.branch("feature/with-comment");

      // Remove CI workflow for faster testing
      await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
      await repo.commitFiles({
        [`with-comment-${uniqueId}.txt`]: "test content line 1\ntest content line 2\n",
      });

      // Push and create PR
      await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      const prCreateResult =
        await $`gh pr create --repo ${repo.github.owner}/${repo.github.repo} --head ${branchName} --title "Test PR with comment thread" --body "Testing comment threads"`.text();
      const prUrl = prCreateResult.trim();
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      if (!prMatch?.[1]) throw new Error("Failed to parse PR URL");
      const prNumber = parseInt(prMatch[1], 10);

      // Wait a moment for GitHub to process the PR
      await Bun.sleep(2000);

      // Add a review comment on a specific line using GraphQL
      // First, get the commit SHA for the PR head
      const prDetails =
        await $`gh pr view ${prNumber} --repo ${repo.github.owner}/${repo.github.repo} --json headRefOid`.text();
      const { headRefOid } = JSON.parse(prDetails);

      // Get the PR node ID first
      const prNodeResult =
        await $`gh api graphql -f query='query { repository(owner: "${repo.github.owner}", name: "${repo.github.repo}") { pullRequest(number: ${prNumber}) { id } } }'`.text();
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
      const status = await getPRCommentStatus(prNumber, `${repo.github.owner}/${repo.github.repo}`);
      expect(status.total).toBe(1);
      expect(status.resolved).toBe(0);
    },
    { timeout: 60000 },
  );
});
