import { test, expect, beforeAll, beforeEach, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { createGitHubFixture, type GitHubFixture } from "../helpers/github-fixture.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { SKIP_GITHUB_TESTS, SKIP_CI_TESTS, runSync } from "./helpers.ts";
import { getPRChecksStatus } from "../../src/github/pr.ts";

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
      if (!prMatch) throw new Error("Failed to parse PR URL");
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
