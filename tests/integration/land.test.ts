/**
 * land command tests - the full story
 *
 * This file tells the complete story of the `sp land` command:
 * 1. Local CLI tests (no network) - basic behavior and validation
 * 2. GitHub integration tests - PR landing, retargeting
 * 3. CI-dependent tests - verifying CI requirements before landing
 *
 * Tests are organized to generate documentation that explains land from
 * simple to complex scenarios.
 */
import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import { withGitHubSnapshots } from "../helpers/snapshot-compose.ts";
import { SKIP_GITHUB_TESTS, SKIP_CI_TESTS, runSync, runLand } from "./helpers.ts";

// Create story-enabled test wrapper with GitHub snapshot support
const base = createStoryTest(import.meta.file);
const { test: storyTest } = withGitHubSnapshots(base);

// ============================================================================
// Part 1: Local CLI Tests (no network required)
// These tests run against local git repos only - fast and reliable
// ============================================================================

describe("land: local behavior", () => {
  const repos = repoManager();

  test("reports when stack is empty", async () => {
    const repo = await repos.create();
    await scenarios.emptyStack.setup(repo);

    const result = await runLand(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("requires GitHub for repos with commits (to check for PRs)", async () => {
    const repo = await repos.create();
    await scenarios.withSpryIds.setup(repo);

    const result = await runLand(repo.path);

    // Local repos can't check for PRs - GitHub is required
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires a GitHub repository");
  });

  test("handles validation error for split group", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    // Create a split group (non-contiguous commits with same Spry-Group)
    await repo.commit({
      message: "Group commit 1",
      trailers: {
        "Spry-Commit-Id": "id111111",
        "Spry-Group": "grp1",
        "Spry-Group-Title": "My Group",
      },
    });
    await repo.commit({
      message: "Interrupting commit",
      trailers: {
        "Spry-Commit-Id": "id222222",
      },
    });
    await repo.commit({
      message: "Group commit 2",
      trailers: {
        "Spry-Commit-Id": "id333333",
        "Spry-Group": "grp1",
        "Spry-Group-Title": "My Group",
      },
    });

    const result = await runLand(repo.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Split group");
  });
});

// ============================================================================
// Part 2: GitHub Integration Tests (requires GITHUB_INTEGRATION_TESTS=1)
// These tests interact with real GitHub API
// ============================================================================

describe("land: GitHub integration", () => {
  const repos = repoManager({ github: true });

  storyTest(
    "No open PRs to land",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "If you try to land a stack that has no open PRs, sp tells you there's nothing to land.",
      );

      const repo = await repos.clone({ testName: "no-pr" });
      await repo.branch("feature/no-pr-test");
      await repo.commit();

      // Run sync WITHOUT --open (just adds IDs, no PR)
      const syncResult = await runSync(repo.path, { open: false });
      expect(syncResult.exitCode).toBe(0);

      // Try to land - should report no open PRs
      const landResult = await runLand(repo.path);
      story.log(landResult);

      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain("No open PRs in stack");
    },
    { timeout: 60000 },
  );

  storyTest.skipIf(SKIP_CI_TESTS)(
    "Landing a single PR",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When you run `sp land` on a branch with an approved PR, it merges to main and cleans up the remote branch.",
      );

      const repo = await repos.clone({ testName: "land" });
      await repo.branch("feature/land-test");
      await repo.commit();

      // Run sp sync --open to create the PR
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);
      expect(syncResult.stdout).toContain("Created");

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to pass before landing
      await repo.github.waitForCI(pr.number, { timeout: 180000 });

      // Run sp land
      const landResult = await runLand(repo.path);
      story.log(landResult);

      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain(`Merging PR #${pr.number}`);
      expect(landResult.stdout).toContain(`✓ Merged PR #${pr.number} to main`);
      expect(landResult.stdout).toContain(`✓ Deleted remote branch ${pr.headRefName}`);

      // Verify PR is now merged (closed)
      const prStatus =
        await $`gh pr view ${pr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(prStatus).state).toBe("MERGED");

      // Verify branch was deleted
      const branchGone = await repo.waitForBranchGone(pr.headRefName);
      expect(branchGone).toBe(true);

      // Verify the commit is now on main
      await repo.fetch();
      const mainLog = await $`git -C ${repo.path} log origin/main --oneline -5`.text();
      expect(mainLog).toContain(repo.uniqueId);
    },
    { timeout: 200000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "retargets next PR to main after landing, preventing it from being closed",
    async () => {
      const repo = await repos.clone({ testName: "retarget" });
      await repo.branch("feature/retarget-test");
      await repo.commit();
      await repo.commit();
      await repo.commit();

      // Run sp sync --open to create PRs for all commits
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Get all PRs (all will have uniqueId in title) and sort by PR number
      // PRs are created in stack order, so lower PR numbers = bottom of stack
      const prs = (await repo.findPRs(repo.uniqueId)).sort((a, b) => a.number - b.number);
      expect(prs.length).toBe(3);
      const firstPr = prs[0];
      const secondPr = prs[1];
      const thirdPr = prs[2];
      if (!firstPr || !secondPr || !thirdPr) throw new Error("Expected 3 PRs");

      // Wait for CI to pass on all PRs
      await Promise.all([
        repo.github.waitForCI(firstPr.number, { timeout: 180000 }),
        repo.github.waitForCI(secondPr.number, { timeout: 180000 }),
        repo.github.waitForCI(thirdPr.number, { timeout: 180000 }),
      ]);

      // Step 1: Run sp land (lands just the first PR)
      const landResult1 = await runLand(repo.path);
      expect(landResult1.exitCode).toBe(0);
      expect(landResult1.stdout).toContain(`✓ Merged PR #${firstPr.number} to main`);
      expect(landResult1.stdout).toContain(`Retargeting PR #${secondPr.number} to main`);

      // Wait a few seconds for GitHub to process
      await Bun.sleep(5000);

      // Verify first PR is MERGED (not just closed)
      const firstStatus =
        await $`gh pr view ${firstPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(firstStatus).state).toBe("MERGED");

      // Verify second PR is still OPEN (not closed due to base branch deletion)
      const secondStatus =
        await $`gh pr view ${secondPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state,baseRefName`.text();
      const secondData = JSON.parse(secondStatus);
      expect(secondData.state).toBe("OPEN");
      expect(secondData.baseRefName).toBe("main"); // Should have been retargeted

      // Verify third PR is still OPEN
      const thirdStatus =
        await $`gh pr view ${thirdPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(thirdStatus).state).toBe("OPEN");

      // Step 2: Run sp land --all (should land remaining PRs)
      const landResult2 = await runLand(repo.path, { all: true });
      expect(landResult2.exitCode).toBe(0);
      expect(landResult2.stdout).toContain("✓ Merged 2 PR(s)");

      // Verify all PRs are MERGED (not CLOSED)
      const finalFirstStatus =
        await $`gh pr view ${firstPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(finalFirstStatus).state).toBe("MERGED");

      const finalSecondStatus =
        await $`gh pr view ${secondPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(finalSecondStatus).state).toBe("MERGED");

      const finalThirdStatus =
        await $`gh pr view ${thirdPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(finalThirdStatus).state).toBe("MERGED");
    },
    { timeout: 400000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "fails to land when PR cannot be fast-forwarded",
    async () => {
      const repo = await repos.clone({ testName: "conflict" });
      await repo.branch("feature/land-conflict-test");
      await repo.commit();

      // Run sp sync --open to create the PR
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to pass first (so CI check doesn't fail before fast-forward check)
      await repo.github.waitForCI(pr.number, { timeout: 180000 });

      // Now push a different commit directly to main (simulating someone else merging)
      await repo.checkout("main");
      await $`git -C ${repo.path} pull origin main`.quiet();
      await repo.commit();
      await $`git -C ${repo.path} push origin main`.quiet();

      // Go back to feature branch
      const branches = await $`git -C ${repo.path} branch`.text();
      const featureBranch = branches
        .split("\n")
        .find((b) => b.includes("feature/land-conflict-test"));
      if (featureBranch) {
        await repo.checkout(featureBranch.trim().replace("* ", ""));
      }

      // Try to land - should fail because main has diverged
      const landResult = await runLand(repo.path);

      expect(landResult.exitCode).toBe(1);
      expect(landResult.stderr).toContain("is not ready to land");
      expect(landResult.stderr).toContain("Rebase may be required");
    },
    { timeout: 200000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "fails to land when CI checks are failing",
    async () => {
      const repo = await repos.clone({ testName: "land-ci-fail" });
      await repo.branch("feature/ci-fail-land-test");
      await repo.commit({ message: "[FAIL_CI] trigger CI failure" });

      // Run sp sync --open to create the PR
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to complete (and fail)
      await repo.github.waitForCI(pr.number, { timeout: 180000 });

      // Try to land - should fail because CI is failing
      const landResult = await runLand(repo.path);

      expect(landResult.exitCode).toBe(1);
      expect(landResult.stderr).toContain("is not ready to land");
      expect(landResult.stderr).toContain("CI checks are failing");
    },
    { timeout: 200000 },
  );
});

// ============================================================================
// Part 3: CI-Dependent Tests - land --all (requires GITHUB_CI_TESTS=1)
// These tests verify batch landing behavior with CI requirements
// ============================================================================

describe.skipIf(SKIP_GITHUB_TESTS)("land --all: batch landing", () => {
  const repos = repoManager({ github: true });

  test.skipIf(SKIP_CI_TESTS)(
    "lands all consecutive ready PRs in a stack",
    async () => {
      const repo = await repos.clone({ testName: "land-all" });
      await repo.branch("feature/land-all-test");
      await repo.commit();
      await repo.commit();
      await repo.commit();

      // Run sp sync --open to create PRs for all commits
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Get all PRs (all will have uniqueId in title)
      const stackPrs = await repo.findPRs(repo.uniqueId);
      expect(stackPrs.length).toBe(3);

      // Wait for CI to pass on all PRs
      await Promise.all(
        stackPrs.map((pr) => repo.github.waitForCI(pr.number, { timeout: 180000 })),
      );

      // Run sp land --all
      const landResult = await runLand(repo.path, { all: true });

      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain("✓ Merged 3 PR(s)");

      // Verify all PRs are now merged
      for (const pr of stackPrs) {
        const prStatus =
          await $`gh pr view ${pr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
        expect(JSON.parse(prStatus).state).toBe("MERGED");
      }

      // Verify the commits are now on main
      await repo.fetch();
      const mainLog = await $`git -C ${repo.path} log origin/main --oneline -10`.text();
      expect(mainLog).toContain(repo.uniqueId);
    },
    { timeout: 300000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "stops at first non-ready PR when using --all",
    async () => {
      const repo = await repos.clone({ testName: "stop" });
      await repo.branch("feature/land-all-stop");
      await repo.commit({ message: "first-passes" });
      await repo.commit({ message: "[FAIL_CI] second-fails" });
      await repo.commit({ message: "third-passes" });

      // Run sp sync --open to create PRs for all commits
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Get all PRs by distinct message patterns
      const firstPr = await repo.findPR("first-passes");
      const secondPr = await repo.findPR("second-fails");
      const thirdPr = await repo.findPR("third-passes");

      // Wait for CI to complete on all PRs
      await Promise.all([
        repo.github.waitForCI(firstPr.number, { timeout: 180000 }),
        repo.github.waitForCI(secondPr.number, { timeout: 180000 }),
        repo.github.waitForCI(thirdPr.number, { timeout: 180000 }),
      ]);

      // Run sp land --all - should merge first, stop at second
      const landResult = await runLand(repo.path, { all: true });

      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain("✓ Merged 1 PR(s)");
      expect(landResult.stdout).toContain(`Stopping at PR #${secondPr.number}`);

      // Verify first PR is merged
      const firstStatus =
        await $`gh pr view ${firstPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(firstStatus).state).toBe("MERGED");

      // Verify second PR is still open
      const secondStatus =
        await $`gh pr view ${secondPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(secondStatus).state).toBe("OPEN");

      // Verify third PR is still open
      const thirdStatus =
        await $`gh pr view ${thirdPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(thirdStatus).state).toBe("OPEN");
    },
    { timeout: 300000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "snapshots readiness at start and doesn't land PRs that become ready during execution",
    async () => {
      const repo = await repos.clone({ testName: "snapshot" });
      await repo.branch("feature/snapshot-test");
      await repo.commit({ message: "first-ready" });
      await repo.commit({ message: "[FAIL_CI] second-not-ready" });

      // Run sp sync --open
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Get PRs by distinct message patterns
      const firstPr = await repo.findPR("first-ready");
      const secondPr = await repo.findPR("second-not-ready");

      // Wait for CI on both
      await Promise.all([
        repo.github.waitForCI(firstPr.number, { timeout: 180000 }),
        repo.github.waitForCI(secondPr.number, { timeout: 180000 }),
      ]);

      // Run land --all
      const landResult = await runLand(repo.path, { all: true });

      // Should only merge the first one
      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain("✓ Merged 1 PR(s)");

      // First should be merged
      const firstStatus =
        await $`gh pr view ${firstPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(firstStatus).state).toBe("MERGED");

      // Second should still be open (wasn't ready in snapshot)
      const secondStatus =
        await $`gh pr view ${secondPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
      expect(JSON.parse(secondStatus).state).toBe("OPEN");
    },
    { timeout: 300000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "reports no ready PRs when first PR is not ready",
    async () => {
      const repo = await repos.clone({ testName: "not-ready" });
      await repo.branch("feature/not-ready");
      await repo.commit({ message: "[CI_SLOW_TEST] slow commit" });

      // Run sp sync --open
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      const pr = await repo.findPR(repo.uniqueId);

      // Wait for CI to start (so we know checks are being reported)
      await repo.github.waitForCIToStart(pr.number);

      // Run land --all (CI should still be running due to slow marker)
      const landResult = await runLand(repo.path, { all: true });

      // Should fail because first PR is not ready (CI still pending)
      expect(landResult.exitCode).toBe(1);
      expect(landResult.stderr).toContain("is not ready to land");
      expect(landResult.stderr).toContain("CI checks are still running");
    },
    { timeout: 120000 },
  );
});
