/**
 * Example test demonstrating the GitHub snapshot service.
 *
 * This test file shows how to use the snapshot service for GitHub integration tests.
 *
 * To record snapshots:
 *   GITHUB_INTEGRATION_TESTS=1 bun test tests/github/service.snapshot.test.ts
 *
 * To replay (fast mode):
 *   bun test tests/github/service.snapshot.test.ts
 *
 * Without snapshots recorded, tests will be skipped gracefully.
 */

import { describe, expect } from "bun:test";
import { $ } from "bun";
import { createStoryTest } from "../helpers/story-test.ts";
import { withGitHubSnapshots, isGitHubIntegrationEnabled } from "../helpers/snapshot-compose.ts";
import { repoManager } from "../helpers/local-repo.ts";
import { getGitHubService } from "../../src/github/service.ts";

// Compose story test + GitHub snapshot support
// Note: withGitHubSnapshots auto-detects test file from Bun.main
const base = createStoryTest(import.meta.file);
const { test } = withGitHubSnapshots(base);

describe("GitHub Service Snapshots", () => {
  const repos = repoManager({ github: true });

  test("gets username", async (story) => {
    story.strip(repos.uniqueId);
    story.narrate("Testing that getUsername returns the authenticated user.");

    const username = await getGitHubService().getUsername();

    expect(username).toBeTruthy();
    expect(typeof username).toBe("string");
    story.narrate(`Got username: ${username}`);
  });

  test("creates and finds PR", async (story) => {
    const repo = await repos.clone();
    const testId = repos.uniqueId;

    story.strip(testId);
    story.narrate("Creating a feature branch and PR, then finding it.");

    // Create a feature branch with a commit
    const branchName = await repo.branch("feature");
    await repo.commit({ message: "Add feature" });
    await $`git -C ${repo.path} push -u origin ${branchName}`.quiet();

    story.narrate(`Pushed branch ${branchName} to origin.`);

    // Create a PR using the service
    const service = getGitHubService();
    const pr = await service.createPR({
      title: `Test Feature ${testId}`,
      head: branchName,
      base: "main",
      body: `This is a test PR for ${testId}`,
    });

    expect(pr.number).toBeGreaterThan(0);
    expect(pr.url).toContain("/pull/");
    story.narrate(`Created PR #${pr.number}: ${pr.url}`);

    // Find the PR by branch
    const foundPR = await service.findPRByBranch(branchName);
    expect(foundPR).not.toBeNull();
    expect(foundPR!.number).toBe(pr.number);
    story.narrate(`Found PR by branch: #${foundPR!.number}`);

    // Get PR state
    const state = await service.getPRState(pr.number);
    expect(state).toBe("OPEN");
    story.narrate(`PR state: ${state}`);

    // Get PR body
    const body = await service.getPRBody(pr.number);
    expect(body).toContain(testId);
    story.narrate(`PR body contains test ID: ${body.includes(testId)}`);
  });

  test("finds PRs by multiple branches", async (story) => {
    const repo = await repos.clone();
    const testId = repos.uniqueId;

    story.strip(testId);
    story.narrate("Creating multiple branches and finding PRs for all at once.");

    // Create first branch and PR
    const branch1 = await repo.branch("feature-1");
    await repo.commit({ message: "Feature 1" });
    await $`git -C ${repo.path} push -u origin ${branch1}`.quiet();

    const service = getGitHubService();
    const pr1 = await service.createPR({
      title: `Feature 1 ${testId}`,
      head: branch1,
      base: "main",
    });
    story.narrate(`Created PR #${pr1.number} for ${branch1}`);

    // Go back to main and create second branch
    await repo.checkout("main");
    const branch2 = await repo.branch("feature-2");
    await repo.commit({ message: "Feature 2" });
    await $`git -C ${repo.path} push -u origin ${branch2}`.quiet();

    const pr2 = await service.createPR({
      title: `Feature 2 ${testId}`,
      head: branch2,
      base: "main",
    });
    story.narrate(`Created PR #${pr2.number} for ${branch2}`);

    // Find PRs by branches (single API call)
    const prsByBranch = await service.findPRsByBranches([branch1, branch2, "nonexistent-branch"]);

    expect(prsByBranch.get(branch1)?.number).toBe(pr1.number);
    expect(prsByBranch.get(branch2)?.number).toBe(pr2.number);
    expect(prsByBranch.get("nonexistent-branch")).toBeNull();

    story.narrate(
      `Found PRs: ${branch1}=#${prsByBranch.get(branch1)?.number}, ${branch2}=#${prsByBranch.get(branch2)?.number}`,
    );
  });

  // This test should skip gracefully if no snapshot is recorded
  test("handles missing snapshot gracefully", async (story) => {
    story.narrate("This test intentionally has no snapshot recorded to verify skip behavior.");
    story.narrate("If you see this, the test ran (in record mode or snapshot exists).");

    // In replay mode without snapshot, this will be skipped
    // In record mode, this will record and pass
    const username = await getGitHubService().getUsername();
    expect(username).toBeTruthy();
  });
});

// Show test mode info
if (isGitHubIntegrationEnabled()) {
  console.log("📝 RECORD MODE: Tests will call real GitHub API and record snapshots");
} else {
  console.log("▶️  REPLAY MODE: Tests will use recorded snapshots (or skip if missing)");
}
