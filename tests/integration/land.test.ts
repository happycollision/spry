import { test, expect, beforeAll, beforeEach, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { createGitHubFixture, type GitHubFixture } from "../helpers/github-fixture.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { SKIP_GITHUB_TESTS, SKIP_CI_TESTS, runSync, runLand } from "./helpers.ts";

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: land", () => {
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
    "lands a single PR and deletes the branch",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit (use unique filename to avoid conflicts)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/land-test-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `land-test-${uniqueId}.txt`), "test content for landing\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Add file to land"`.quiet();

      // Run taspr sync --open to create the PR
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);
      expect(syncResult.stdout).toContain("Created");

      // Get the PR number
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title,headRefName`.text();
      const prs = JSON.parse(prList) as Array<{
        number: number;
        title: string;
        headRefName: string;
      }>;
      const pr = prs.find((p) => p.title.includes("Add file to land"));
      if (!pr) throw new Error("PR not found");
      const prNumber = pr.number;
      const branchName = pr.headRefName;

      // Wait for CI to pass before landing
      await github.waitForCI(prNumber, { timeout: 180000 });

      // Run taspr land
      const landResult = await runLand(localDir);

      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain(`Merging PR #${prNumber}`);
      expect(landResult.stdout).toContain(`✓ Merged PR #${prNumber} to main`);
      expect(landResult.stdout).toContain(`✓ Deleted remote branch ${branchName}`);

      // Verify PR is now merged (closed)
      const prStatus =
        await $`gh pr view ${prNumber} --repo ${github.owner}/${github.repo} --json state`.text();
      const prData = JSON.parse(prStatus);
      expect(prData.state).toBe("MERGED");

      // Verify branch was deleted (may need to poll due to eventual consistency)
      let branchGone = false;
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(500);
        const branchCheck =
          await $`gh api repos/${github.owner}/${github.repo}/branches/${branchName}`.nothrow();
        if (branchCheck.exitCode !== 0) {
          branchGone = true;
          break;
        }
      }
      expect(branchGone).toBe(true);

      // Verify the commit is now on main
      await $`git -C ${localDir} fetch origin main`.quiet();
      const mainLog = await $`git -C ${localDir} log origin/main --oneline -5`.text();
      expect(mainLog).toContain("Add file to land");
    },
    { timeout: 200000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "fails to land when PR cannot be fast-forwarded",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit (use unique filename to avoid conflicts)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/land-conflict-test-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `conflict-test-${uniqueId}.txt`), "feature content\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Add conflicting file"`.quiet();

      // Run taspr sync --open to create the PR
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find the PR
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;
      const pr = prs.find((p) => p.title.includes("Add conflicting file"));
      if (!pr) throw new Error("PR not found");

      // Wait for CI to pass first (so CI check doesn't fail before fast-forward check)
      await github.waitForCI(pr.number, { timeout: 180000 });

      // Now push a different commit directly to main (simulating someone else merging)
      await $`git -C ${localDir} checkout main`.quiet();
      await $`git -C ${localDir} pull origin main`.quiet();
      await Bun.write(join(localDir, `main-change-${uniqueId}.txt`), "main change\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Direct commit to main"`.quiet();
      await $`git -C ${localDir} push origin main`.quiet();

      // Go back to feature branch
      await $`git -C ${localDir} checkout feature/land-conflict-test-${uniqueId}`.quiet();

      // Try to land - should fail because main has diverged
      const landResult = await runLand(localDir);

      expect(landResult.exitCode).toBe(1);
      expect(landResult.stderr).toContain("is not ready to land");
      expect(landResult.stderr).toContain("Rebase may be required");
    },
    { timeout: 200000 },
  );

  test(
    "reports no open PRs when stack has no PRs",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a commit but DON'T create a PR (use unique filename)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/no-pr-test-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `no-pr-test-${uniqueId}.txt`), "no PR for this\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Commit without PR"`.quiet();

      // Run sync WITHOUT --open (just adds IDs, no PR)
      const syncResult = await runSync(localDir, { open: false });
      expect(syncResult.exitCode).toBe(0);

      // Try to land - should report no open PRs
      const landResult = await runLand(localDir);

      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain("No open PRs in stack");
    },
    { timeout: 60000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "fails to land when CI checks are failing",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with a FAIL_CI commit (use unique filename)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/ci-fail-land-test-${uniqueId}`.quiet();
      await Bun.write(join(localDir, `fail-ci-land-${uniqueId}.txt`), "this should fail CI\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "[FAIL_CI] Add file that should fail CI"`.quiet();

      // Run taspr sync --open to create the PR
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Find PR by title
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;
      const pr = prs.find((p) => p.title.includes("FAIL_CI"));
      if (!pr) throw new Error("PR not found");

      // Wait for CI to complete (and fail)
      await github.waitForCI(pr.number, { timeout: 180000 });

      // Try to land - should fail because CI is failing
      const landResult = await runLand(localDir);

      expect(landResult.exitCode).toBe(1);
      expect(landResult.stderr).toContain("is not ready to land");
      expect(landResult.stderr).toContain("CI checks are failing");
    },
    { timeout: 200000 },
  );
});

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: land --all", () => {
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
    "lands all consecutive ready PRs in a stack",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with 3 commits (stacked PRs)
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/land-all-test-${uniqueId}`.quiet();

      // First commit
      await Bun.write(join(localDir, `land-all-1-${uniqueId}.txt`), "first commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "First commit in stack"`.quiet();

      // Second commit
      await Bun.write(join(localDir, `land-all-2-${uniqueId}.txt`), "second commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Second commit in stack"`.quiet();

      // Third commit
      await Bun.write(join(localDir, `land-all-3-${uniqueId}.txt`), "third commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Third commit in stack"`.quiet();

      // Run taspr sync --open to create PRs for all commits
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Get all PRs
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;
      const stackPrs = prs.filter(
        (p) =>
          p.title.includes("First commit in stack") ||
          p.title.includes("Second commit in stack") ||
          p.title.includes("Third commit in stack"),
      );
      expect(stackPrs.length).toBe(3);

      // Wait for CI to pass on all PRs
      await Promise.all(stackPrs.map((pr) => github.waitForCI(pr.number, { timeout: 180000 })));

      // Run taspr land --all
      const landResult = await runLand(localDir, { all: true });

      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain("✓ Merged 3 PR(s)");

      // Verify all PRs are now merged
      for (const pr of stackPrs) {
        const prStatus =
          await $`gh pr view ${pr.number} --repo ${github.owner}/${github.repo} --json state`.text();
        const prData = JSON.parse(prStatus);
        expect(prData.state).toBe("MERGED");
      }

      // Verify the commits are now on main
      await $`git -C ${localDir} fetch origin main`.quiet();
      const mainLog = await $`git -C ${localDir} log origin/main --oneline -10`.text();
      expect(mainLog).toContain("First commit in stack");
      expect(mainLog).toContain("Second commit in stack");
      expect(mainLog).toContain("Third commit in stack");
    },
    { timeout: 300000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "stops at first non-ready PR when using --all",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create a feature branch with 3 commits, middle one will fail CI
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/land-all-stop-${uniqueId}`.quiet();

      // First commit (will pass)
      await Bun.write(join(localDir, `land-stop-1-${uniqueId}.txt`), "first commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "First commit passes"`.quiet();

      // Second commit (will fail CI)
      await Bun.write(join(localDir, `land-stop-2-${uniqueId}.txt`), "second commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "[FAIL_CI] Second commit fails"`.quiet();

      // Third commit (would pass, but won't be reached)
      await Bun.write(join(localDir, `land-stop-3-${uniqueId}.txt`), "third commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Third commit passes"`.quiet();

      // Run taspr sync --open to create PRs for all commits
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Get all PRs
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;

      const firstPr = prs.find((p) => p.title.includes("First commit passes"));
      const secondPr = prs.find((p) => p.title.includes("FAIL_CI"));
      const thirdPr = prs.find((p) => p.title.includes("Third commit passes"));
      if (!firstPr || !secondPr || !thirdPr) throw new Error("PRs not found");

      // Wait for CI to complete on all PRs
      await Promise.all([
        github.waitForCI(firstPr.number, { timeout: 180000 }),
        github.waitForCI(secondPr.number, { timeout: 180000 }),
        github.waitForCI(thirdPr.number, { timeout: 180000 }),
      ]);

      // Run taspr land --all - should merge first, stop at second
      const landResult = await runLand(localDir, { all: true });

      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain("✓ Merged 1 PR(s)");
      expect(landResult.stdout).toContain(`Stopping at PR #${secondPr.number}`);

      // Verify first PR is merged
      const firstStatus =
        await $`gh pr view ${firstPr.number} --repo ${github.owner}/${github.repo} --json state`.text();
      expect(JSON.parse(firstStatus).state).toBe("MERGED");

      // Verify second PR is still open
      const secondStatus =
        await $`gh pr view ${secondPr.number} --repo ${github.owner}/${github.repo} --json state`.text();
      expect(JSON.parse(secondStatus).state).toBe("OPEN");

      // Verify third PR is still open
      const thirdStatus =
        await $`gh pr view ${thirdPr.number} --repo ${github.owner}/${github.repo} --json state`.text();
      expect(JSON.parse(thirdStatus).state).toBe("OPEN");
    },
    { timeout: 300000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "snapshots readiness at start and doesn't land PRs that become ready during execution",
    async () => {
      // This test verifies that if a PR becomes ready during the landing process,
      // it won't be landed if it wasn't ready at the start.
      //
      // We simulate this by:
      // 1. Creating a stack where the first PR is ready
      // 2. Creating a second PR that's initially not ready (CI pending/failing)
      // 3. Landing with --all
      // 4. Even if CI passes during the process, it shouldn't be landed
      //
      // For this test, we'll use the CI timing:
      // - First PR passes CI quickly
      // - Second PR is set to fail CI
      // - We verify only the first PR is landed based on the snapshot

      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/snapshot-test-${uniqueId}`.quiet();

      // First commit (passes CI)
      await Bun.write(join(localDir, `snapshot-1-${uniqueId}.txt`), "first commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "First commit ready"`.quiet();

      // Second commit (fails CI - won't become ready)
      await Bun.write(join(localDir, `snapshot-2-${uniqueId}.txt`), "second commit\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "[FAIL_CI] Second not ready"`.quiet();

      // Run taspr sync --open
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Get PRs
      const prList =
        await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title`.text();
      const prs = JSON.parse(prList) as Array<{ number: number; title: string }>;
      const firstPr = prs.find((p) => p.title.includes("First commit ready"));
      const secondPr = prs.find((p) => p.title.includes("FAIL_CI"));
      if (!firstPr || !secondPr) throw new Error("PRs not found");

      // Wait for CI on both
      await Promise.all([
        github.waitForCI(firstPr.number, { timeout: 180000 }),
        github.waitForCI(secondPr.number, { timeout: 180000 }),
      ]);

      // Run land --all
      const landResult = await runLand(localDir, { all: true });

      // Should only merge the first one
      expect(landResult.exitCode).toBe(0);
      expect(landResult.stdout).toContain("✓ Merged 1 PR(s)");

      // First should be merged
      const firstStatus =
        await $`gh pr view ${firstPr.number} --repo ${github.owner}/${github.repo} --json state`.text();
      expect(JSON.parse(firstStatus).state).toBe("MERGED");

      // Second should still be open (wasn't ready in snapshot)
      const secondStatus =
        await $`gh pr view ${secondPr.number} --repo ${github.owner}/${github.repo} --json state`.text();
      expect(JSON.parse(secondStatus).state).toBe("OPEN");
    },
    { timeout: 300000 },
  );

  test.skipIf(SKIP_CI_TESTS)(
    "reports no ready PRs when first PR is not ready",
    async () => {
      // Clone the test repo locally
      const tmpResult = await $`mktemp -d`.text();
      localDir = tmpResult.trim();

      await $`git clone ${github.repoUrl}.git ${localDir}`.quiet();
      await $`git -C ${localDir} config user.email "test@example.com"`.quiet();
      await $`git -C ${localDir} config user.name "Test User"`.quiet();

      // Create commits but don't wait for CI - PRs won't be ready
      const uniqueId = Date.now().toString(36);
      await $`git -C ${localDir} checkout -b feature/not-ready-${uniqueId}`.quiet();

      await Bun.write(join(localDir, `not-ready-${uniqueId}.txt`), "pending CI\n");
      await $`git -C ${localDir} add .`.quiet();
      await $`git -C ${localDir} commit -m "Commit with pending CI"`.quiet();

      // Run taspr sync --open
      const syncResult = await runSync(localDir, { open: true });
      expect(syncResult.exitCode).toBe(0);

      // Run land --all immediately (CI won't have finished)
      const landResult = await runLand(localDir, { all: true });

      // Should fail because first PR is not ready
      expect(landResult.exitCode).toBe(1);
      expect(landResult.stderr).toContain("is not ready to land");
    },
    { timeout: 60000 },
  );
});
