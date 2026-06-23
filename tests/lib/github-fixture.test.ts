import { test, expect } from "bun:test";
import { createGitHubFixture, verifyTestRepo } from "./github-fixture.ts";

// These tests drive real `gh` against the live spry-check test repo. They
// require gh auth + network, so they share the SPRY_RECORD gate with cassette
// recording (the one moment we're already online with gh auth) and skip
// entirely in the normal offline suite. Running them under SPRY_RECORD also
// verifies the fixture reset machinery that recording itself depends on.
const SKIP = !process.env.SPRY_RECORD;

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
