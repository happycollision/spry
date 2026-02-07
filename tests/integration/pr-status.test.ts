import { expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { withGitHubSnapshots } from "../helpers/snapshot-compose.ts";
import { getGitHubService } from "../../src/github/service.ts";
import { isGitHubIntegrationEnabled } from "../../src/github/service.ts";

const base = createStoryTest(import.meta.file);
const { test } = withGitHubSnapshots(base);

describe("GitHub Integration: PR checks status", () => {
  const repos = repoManager({ github: true });

  test(
    "CI checks passing",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate("After CI passes on a PR, getPRChecksStatus returns 'passing'.");

      const repo = await repos.clone({ testName: "checks-pass" });
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;
      const branchName = await repo.branch("feature/checks-pass");

      if (isGitHubIntegrationEnabled()) {
        await repo.commit();
        await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      }

      const { number: prNumber } = await service.createPR({
        title: `Checks pass [${repo.uniqueId}]`,
        head: branchName,
        base: "main",
        body: "Testing CI checks passing",
        repo: repoSlug,
      });

      if (isGitHubIntegrationEnabled()) {
        await repo.github.waitForCI(prNumber, { timeout: 180000 });
      }

      const status = await service.getPRChecksStatus(prNumber, repoSlug);
      story.narrate(`PR #${prNumber} checks status: ${status}`);
      expect(status).toBe("passing");
    },
    { timeout: 200000 },
  );

  test(
    "CI checks failing",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate("When CI fails on a PR, getPRChecksStatus returns 'failing'.");

      const repo = await repos.clone({ testName: "checks-fail" });
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;
      const branchName = await repo.branch("feature/checks-fail");

      if (isGitHubIntegrationEnabled()) {
        await repo.commit({ message: "[FAIL_CI] trigger CI failure" });
        await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      }

      const { number: prNumber } = await service.createPR({
        title: `Checks fail [${repo.uniqueId}]`,
        head: branchName,
        base: "main",
        body: "Testing CI checks failing",
        repo: repoSlug,
      });

      if (isGitHubIntegrationEnabled()) {
        await repo.github.waitForCI(prNumber, { timeout: 180000 });
      }

      const status = await service.getPRChecksStatus(prNumber, repoSlug);
      story.narrate(`PR #${prNumber} checks status: ${status}`);
      expect(status).toBe("failing");
    },
    { timeout: 200000 },
  );

  test(
    "CI checks pending",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate("While CI is still running on a PR, getPRChecksStatus returns 'pending'.");

      const repo = await repos.clone({ testName: "checks-pending" });
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;
      const branchName = await repo.branch("feature/checks-pending");

      if (isGitHubIntegrationEnabled()) {
        await repo.commit({ message: "[CI_SLOW_TEST] slow commit" });
        await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      }

      const { number: prNumber } = await service.createPR({
        title: `Checks pending [${repo.uniqueId}]`,
        head: branchName,
        base: "main",
        body: "Testing CI checks pending",
        repo: repoSlug,
      });

      if (isGitHubIntegrationEnabled()) {
        await repo.github.waitForCIToStart(prNumber);
      }

      const status = await service.getPRChecksStatus(prNumber, repoSlug);
      story.narrate(`PR #${prNumber} checks status: ${status}`);
      expect(status).toBe("pending");
    },
    { timeout: 120000 },
  );

  test.noStory(
    "returns 'none' for PR with no CI checks configured",
    async () => {
      const repo = await repos.clone({ testName: "no-ci" });
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;
      const branchName = await repo.branch("feature/no-ci");

      if (isGitHubIntegrationEnabled()) {
        await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
        await $`git -C ${repo.path} commit -m "Remove CI workflow for testing"`.quiet();
        await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      }

      const { number: prNumber } = await service.createPR({
        title: "Remove CI workflow",
        head: branchName,
        base: "main",
        body: "Testing no CI",
        repo: repoSlug,
      });

      if (isGitHubIntegrationEnabled()) {
        await Bun.sleep(5000);
      }

      const status = await service.getPRChecksStatus(prNumber, repoSlug);
      expect(status).toBe("none");
    },
    { timeout: 120000 },
  );
});

describe("GitHub Integration: PR review status", () => {
  const repos = repoManager({ github: true });

  test.noStory(
    "returns 'none' for PR with no review requirements",
    async () => {
      const repo = await repos.clone({ testName: "review-none" });
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;
      const branchName = await repo.branch("feature/review-none");

      if (isGitHubIntegrationEnabled()) {
        await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
        await repo.commit();
        await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      }

      const { number: prNumber } = await service.createPR({
        title: "Test PR for review status",
        head: branchName,
        base: "main",
        body: "Testing review status",
        repo: repoSlug,
      });

      if (isGitHubIntegrationEnabled()) {
        await Bun.sleep(2000);
      }

      const status = await service.getPRReviewStatus(prNumber, repoSlug);
      expect(status).toBe("none");
    },
    { timeout: 60000 },
  );

  // Note: This test is skipped because GitHub doesn't allow you to approve your own PR.
  // The getPRReviewStatus function is still tested via unit tests for determineReviewDecision.
  // To manually test this, create a PR and have another user approve it.
  test.noStory.skip(
    "returns 'approved' after PR is approved",
    async () => {
      const repo = await repos.clone({ testName: "review-approved" });
      const branchName = await repo.branch("feature/review-approved");

      await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
      await repo.commit();

      await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;
      const { number: prNumber } = await service.createPR({
        title: "Test PR for approval",
        head: branchName,
        base: "main",
        body: "Testing approval",
        repo: repoSlug,
      });

      await $`gh pr review ${prNumber} --repo ${repoSlug} --approve --body "LGTM"`.quiet();

      await Bun.sleep(2000);

      const status = await service.getPRReviewStatus(prNumber, repoSlug);
      expect(status).toBe("approved");
    },
    { timeout: 60000 },
  );

  // Note: This test is skipped because GitHub doesn't allow you to request changes on your own PR.
  // The getPRReviewStatus function is still tested via unit tests for determineReviewDecision.
  // To manually test this, create a PR and have another user request changes.
  test.noStory.skip(
    "returns 'changes_requested' after changes are requested",
    async () => {
      const repo = await repos.clone({ testName: "review-changes" });
      const branchName = await repo.branch("feature/review-changes");

      await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
      await repo.commit();

      await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;
      const { number: prNumber } = await service.createPR({
        title: "Test PR for changes requested",
        head: branchName,
        base: "main",
        body: "Testing changes requested",
        repo: repoSlug,
      });

      await $`gh pr review ${prNumber} --repo ${repoSlug} --request-changes --body "Please fix this"`.quiet();

      await Bun.sleep(2000);

      const status = await service.getPRReviewStatus(prNumber, repoSlug);
      expect(status).toBe("changes_requested");
    },
    { timeout: 60000 },
  );

  test.noStory(
    "returns 'review_required' when branch protection requires reviews",
    async () => {
      const repo = await repos.clone({ testName: "review-required" });
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;

      if (isGitHubIntegrationEnabled()) {
        await repo.github.enableBranchProtection("main", {
          requirePullRequestReviews: true,
          requiredApprovingReviewCount: 1,
        });
      }

      try {
        const branchName = await repo.branch("feature/review-required");

        if (isGitHubIntegrationEnabled()) {
          await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
          await repo.commit();
          await $`git -C ${repo.path} push origin ${branchName}`.quiet();
        }

        const { number: prNumber } = await service.createPR({
          title: "Test PR for review required",
          head: branchName,
          base: "main",
          body: "Testing review required",
          repo: repoSlug,
        });

        if (isGitHubIntegrationEnabled()) {
          await Bun.sleep(2000);
        }

        const status = await service.getPRReviewStatus(prNumber, repoSlug);
        expect(status).toBe("review_required");
      } finally {
        if (isGitHubIntegrationEnabled()) {
          await repo.github.disableBranchProtection("main");
        }
      }
    },
    { timeout: 60000 },
  );
});

describe("GitHub Integration: PR comment status", () => {
  const repos = repoManager({ github: true });

  test.noStory(
    "returns zero counts for PR with no review threads",
    async () => {
      const repo = await repos.clone({ testName: "no-comments" });
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;
      const branchName = await repo.branch("feature/no-comments");

      if (isGitHubIntegrationEnabled()) {
        await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
        await repo.commit();
        await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      }

      const { number: prNumber } = await service.createPR({
        title: "Test PR with no comments",
        head: branchName,
        base: "main",
        body: "Testing no comments",
        repo: repoSlug,
      });

      if (isGitHubIntegrationEnabled()) {
        await Bun.sleep(2000);
      }

      const status = await service.getPRCommentStatus(prNumber, repoSlug);
      expect(status).toEqual({ total: 0, resolved: 0 });
    },
    { timeout: 60000 },
  );

  test.noStory(
    "returns correct counts for PR with unresolved review thread",
    async () => {
      const repo = await repos.clone({ testName: "with-comment" });
      const service = getGitHubService();
      const repoSlug = `${repo.github.owner}/${repo.github.repo}`;
      const branchName = await repo.branch("feature/with-comment");

      if (isGitHubIntegrationEnabled()) {
        const uniqueId = Date.now().toString(36);
        await $`git -C ${repo.path} rm .github/workflows/ci.yml`.quiet();
        await repo.commitFiles({
          [`with-comment-${uniqueId}.txt`]: "test content line 1\ntest content line 2\n",
        });
        await $`git -C ${repo.path} push origin ${branchName}`.quiet();
      }

      const { number: prNumber } = await service.createPR({
        title: "Test PR with comment thread",
        head: branchName,
        base: "main",
        body: "Testing comment threads",
        repo: repoSlug,
      });

      if (isGitHubIntegrationEnabled()) {
        await Bun.sleep(2000);

        // Add a review comment on a specific line using GraphQL
        const prDetails =
          await $`gh pr view ${prNumber} --repo ${repoSlug} --json headRefOid`.text();
        const { headRefOid } = JSON.parse(prDetails);

        const prNodeResult =
          await $`gh api graphql -f query='query { repository(owner: "${repo.github.owner}", name: "${repo.github.repo}") { pullRequest(number: ${prNumber}) { id } } }'`.text();
        const prNodeId = JSON.parse(prNodeResult).data.repository.pullRequest.id;

        // Find the filename that was committed
        const diffResult = await $`gh pr diff ${prNumber} --repo ${repoSlug} --name-only`.text();
        const commentFile = diffResult
          .trim()
          .split("\n")
          .find((f) => f.startsWith("with-comment-"));

        await $`gh api graphql -f query='mutation {
          addPullRequestReview(input: {
            pullRequestId: "${prNodeId}",
            event: COMMENT,
            threads: [{
              path: "${commentFile}",
              line: 1,
              body: "This is a test review comment"
            }],
            commitOID: "${headRefOid}"
          }) {
            pullRequestReview { id }
          }
        }'`.quiet();

        await Bun.sleep(2000);
      }

      const status = await service.getPRCommentStatus(prNumber, repoSlug);
      expect(status.total).toBe(1);
      expect(status.resolved).toBe(0);
    },
    { timeout: 60000 },
  );
});
