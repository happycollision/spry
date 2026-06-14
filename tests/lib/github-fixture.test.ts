import { test, expect } from "bun:test";
import { createGitHubFixture, verifyTestRepo } from "./github-fixture.ts";

// These tests drive real `gh` against the live spry-check test repo. They
// require gh auth + network, so they are gated behind GITHUB_INTEGRATION_TESTS
// and skip entirely in the normal offline suite.
const SKIP = !process.env.GITHUB_INTEGRATION_TESTS;

test.skipIf(SKIP)("createGitHubFixture resolves the spry-check test repo", async () => {
  const fixture = await createGitHubFixture();

  expect(fixture.repo).toBe(process.env.SPRY_TEST_REPO_NAME || "spry-check");
  expect(fixture.owner.length).toBeGreaterThan(0);
  expect(fixture.repoUrl).toBe(`https://github.com/${fixture.owner}/${fixture.repo}`);
});

test.skipIf(SKIP)("verifyTestRepo passes against the real spry-check repo", async () => {
  const fixture = await createGitHubFixture();
  const isTestRepo = await verifyTestRepo(fixture.owner, fixture.repo);
  expect(isTestRepo).toBe(true);
});

test.skipIf(SKIP)("reset leaves zero open PRs", async () => {
  const fixture = await createGitHubFixture();

  const report = await fixture.reset();
  expect(report.errors).toEqual([]);

  // After reset, no PRs should be open.
  const remaining = await fixture.closeAllPRs();
  expect(remaining).toBe(0);
});
