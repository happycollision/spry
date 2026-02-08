/**
 * sync command tests - the full story
 *
 * This file tells the complete story of the `sp sync` command:
 * 1. Local CLI tests (no network) - basic behavior
 * 2. GitHub integration tests - PR creation, WIP handling, body generation
 * 3. CI-dependent tests - verifying CI passes/fails as expected
 *
 * Tests are organized to generate documentation that explains sync from
 * simple to complex scenarios.
 */
import { test, expect, describe, beforeAll, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";
import { repoManager } from "../helpers/local-repo.ts";
import { createGitHubFixture, type GitHubFixture } from "../helpers/github-fixture.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { getStackCommitsWithTrailers } from "../../src/git/commands.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import { withGitHubSnapshots } from "../helpers/snapshot-compose.ts";
import { isGitHubIntegrationEnabled } from "../../src/github/service.ts";
import { SKIP_GITHUB_TESTS, runSync, runSpry } from "./helpers.ts";

// Create story-enabled test wrapper with GitHub snapshot support
const base = createStoryTest(import.meta.file);
const { test: storyTest } = withGitHubSnapshots(base);

// ============================================================================
// Part 1: Local CLI Tests (no network required)
// These tests run against local git repos only - fast and reliable
// ============================================================================

describe("sync: local behavior", () => {
  const repos = repoManager();

  test("adds IDs to commits that don't have them", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    await repo.commit();
    await repo.commit();

    // Run sync
    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Adding IDs to 2 commit(s)");
    expect(result.stdout).toContain("Added Spry-Commit-Id to 2 commit(s)");

    // Verify commits now have IDs
    const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
    expect(commits[0]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
    expect(commits[1]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
  });

  test("reports when all commits already have IDs", async () => {
    const repo = await repos.create();
    await scenarios.withSpryIds.setup(repo);

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All commits have Spry-Commit-Id");
  });

  test("reports when stack is empty", async () => {
    const repo = await repos.create();
    await scenarios.emptyStack.setup(repo);

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("blocks on dirty working tree with staged changes", async () => {
    const repo = await repos.create();
    await repo.branch("feature");
    await repo.commit();

    // Stage a change
    await Bun.write(join(repo.path, "dirty.ts"), "// dirty");
    await $`git -C ${repo.path} add dirty.ts`.quiet();

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot sync with uncommitted changes");
    expect(result.stderr).toContain("staged changes");
  });

  test("blocks on dirty working tree with unstaged changes", async () => {
    const repo = await repos.create();
    await repo.branch("feature");
    await repo.commit();

    // Modify tracked file
    await Bun.write(join(repo.path, "README.md"), "# Modified");

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot sync with uncommitted changes");
    expect(result.stderr).toContain("unstaged changes");
  });

  test("output is clean with no extraneous noise", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    await repo.commit();

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);

    // Split output into lines for easier assertion
    const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");

    // Should have exactly these lines (in order):
    // 1. "Adding IDs to 1 commit(s)..."
    // 2. "✓ Added Spry-Commit-Id to 1 commit(s)"
    // 3. "✓ 1 commit(s) ready (use --open to create PRs)"
    // Note: Branches are NOT pushed until --open is used (no remote clutter)
    expect(lines).toEqual([
      "Adding IDs to 1 commit(s)...",
      "✓ Added Spry-Commit-Id to 1 commit(s)",
      "✓ 1 commit(s) ready (use --open to create PRs)",
    ]);

    // Should NOT contain any of these noise patterns
    expect(result.stdout).not.toContain("Executing:");
    expect(result.stdout).not.toContain("lint-staged");
    expect(result.stdout).not.toContain("remote:");
    expect(result.stdout).not.toContain("HEAD branch:");
    expect(result.stdout).not.toContain("Fetch URL:");
    expect(result.stdout).not.toContain("detached HEAD");
    expect(result.stdout).not.toContain("Successfully rebased");

    // stderr should be empty
    expect(result.stderr).toBe("");
  });

  test("blocks when mid-rebase conflict is detected", async () => {
    const repo = await repos.create();

    // Create a file that will conflict
    const conflictFile = "conflict.txt";
    await Bun.write(join(repo.path, conflictFile), "Original content\n");
    await $`git -C ${repo.path} add .`.quiet();
    await $`git -C ${repo.path} commit -m "Add conflict file"`.quiet();
    await $`git -C ${repo.path} push origin main`.quiet();

    // Create feature branch and modify the file
    await repo.branch("feature");
    await Bun.write(join(repo.path, conflictFile), "Feature content\n");
    await $`git -C ${repo.path} add .`.quiet();
    await $`git -C ${repo.path} commit -m "Feature change"`.quiet();

    // Update main with conflicting change
    await repo.updateOriginMain("Main change", { [conflictFile]: "Main content\n" });

    // Fetch and attempt rebase (will conflict)
    await repo.fetch();
    await $`git -C ${repo.path} rebase origin/main`.quiet().nothrow();

    // Now try to run sync - should detect the conflict
    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Rebase conflict");
    expect(result.stderr).toContain(conflictFile);
    expect(result.stderr).toContain("git add");
    expect(result.stderr).toContain("git rebase --continue");

    // Clean up
    await $`git -C ${repo.path} rebase --abort`.quiet().nothrow();
  });

  test("warns about conflicts instead of rebasing when rebase would conflict", async () => {
    const repo = await repos.create();

    // Create a file that will conflict
    const conflictFile = "conflict.txt";
    await Bun.write(join(repo.path, conflictFile), "Original content\n");
    await $`git -C ${repo.path} add .`.quiet();
    await $`git -C ${repo.path} commit -m "Add conflict file"`.quiet();
    await $`git -C ${repo.path} push origin main`.quiet();

    // Create feature branch and modify the file
    await repo.branch("feature");
    await Bun.write(join(repo.path, conflictFile), "Feature content\n");
    await $`git -C ${repo.path} add .`.quiet();
    await $`git -C ${repo.path} commit -m "Feature change"`.quiet();

    // Update main with conflicting change (but don't rebase yet!)
    await repo.updateOriginMain("Main change", { [conflictFile]: "Main content\n" });

    // Run sync - should warn about conflicts but NOT start a rebase
    const result = await runSync(repo.path);

    // Should succeed (exit 0) - we just warned, didn't fail
    expect(result.exitCode).toBe(0);

    // Should warn about the conflict
    expect(result.stdout).toContain("would cause conflicts");
    expect(result.stdout).toContain(conflictFile);
    expect(result.stdout).toContain("git rebase origin/main");

    // Should NOT be in a rebase state
    const rebaseInProgress = await $`git -C ${repo.path} rev-parse --git-path rebase-merge`
      .text()
      .then((p) => Bun.file(join(repo.path, p.trim())).exists());
    expect(rebaseInProgress).toBe(false);

    // Verify we're still on the feature branch with our commit intact
    const currentBranch = await repo.currentBranch();
    expect(currentBranch).toContain("feature");
  });

  test("does not push branches without --open flag", async () => {
    const repo = await repos.create();

    // Create initial feature branch with a commit that has an ID
    await repo.branch("feature");
    await repo.commit({ trailers: { "Spry-Commit-Id": "nopush01" } });

    // Run sync without --open
    const result = await runSync(repo.path);
    expect(result.exitCode).toBe(0);

    // Should indicate commit is ready, NOT that it was pushed
    expect(result.stdout).toContain("1 commit(s) ready (use --open to create PRs)");
    expect(result.stdout).not.toContain("Pushed");

    // Verify the remote branch does NOT exist
    const remoteBranches = (
      await $`git -C ${repo.path} ls-remote origin 'refs/heads/spry/*/nopush01'`.text()
    ).trim();
    expect(remoteBranches).toBe("");
  });

  test("rebases onto origin/main even when local main has diverged", async () => {
    const repo = await repos.create();

    // Create feature branch with a commit
    const featureBranch = await repo.branch("feature");
    await repo.commit({ message: "Feature commit" });

    // Go back to main and add a local commit (simulating user working on main)
    await repo.checkout("main");
    await repo.commit({ message: "Local main commit" });

    // Also add a commit to origin/main (so local main has diverged)
    await repo.updateOriginMain("Remote main commit");

    // Go back to feature branch
    await repo.checkout(featureBranch);

    // Run sync - should warn about local main but still rebase onto origin/main
    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    // Should warn about local main being diverged
    expect(result.stdout).toContain("local commit(s)");
    // Should still rebase the feature branch onto origin/main
    expect(result.stdout).toContain("Rebased");

    // Verify feature branch is now on top of origin/main (ancestry check)
    const mergeBase = (await $`git -C ${repo.path} merge-base HEAD origin/main`.text()).trim();
    const originMain = (await $`git -C ${repo.path} rev-parse origin/main`.text()).trim();
    expect(mergeBase).toBe(originMain);
  });

  test("fast-forwards local main when syncing from feature branch", async () => {
    const repo = await repos.create();

    // Create feature branch with commits
    await repo.branch("feature");
    await repo.commit({ message: "Feature commit" });

    // Update origin/main (simulates another developer pushing)
    await repo.updateOriginMain("Remote commit on main");
    await repo.fetch();

    // Verify local main is behind origin/main before sync
    const localMainBefore = (await $`git -C ${repo.path} rev-parse main`.text()).trim();
    const originMainBefore = (await $`git -C ${repo.path} rev-parse origin/main`.text()).trim();
    expect(localMainBefore).not.toBe(originMainBefore);

    // Run sync from feature branch
    const result = await runSync(repo.path);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Fast-forwarded local main");

    // Verify local main was fast-forwarded to origin/main
    const localMainAfter = (await $`git -C ${repo.path} rev-parse main`.text()).trim();
    const originMainAfter = (await $`git -C ${repo.path} rev-parse origin/main`.text()).trim();
    expect(localMainAfter).toBe(originMainAfter);

    // Verify feature branch is on top of origin/main
    const mergeBase = (await $`git -C ${repo.path} merge-base HEAD origin/main`.text()).trim();
    expect(mergeBase).toBe(originMainAfter);
  });

  test("skips fast-forward when on the main branch (would dirty worktree)", async () => {
    const repo = await repos.create();

    // Stay on main (don't create a feature branch)
    // Add a commit to origin/main so local is behind
    await repo.updateOriginMain("Remote commit");
    await repo.fetch();

    // Get SHAs before sync to verify fast-forward was skipped
    const localMainBefore = (await $`git -C ${repo.path} rev-parse main`.text()).trim();
    const remoteSha = (await $`git -C ${repo.path} rev-parse origin/main`.text()).trim();
    expect(localMainBefore).not.toBe(remoteSha); // Confirm local is behind

    // Run sync while on main with no commits in stack
    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    // When on main with no stack commits, we shouldn't try to fast-forward
    // because that would desync the worktree
    expect(result.stdout).toContain("No commits in stack");

    // Verify fast-forward was NOT performed (local main still behind)
    const localMainAfter = (await $`git -C ${repo.path} rev-parse main`.text()).trim();
    expect(localMainAfter).toBe(localMainBefore);
    expect(localMainAfter).not.toBe(remoteSha);
  });

  test("works with non-origin remote name (upstream)", async () => {
    // Create repo with 'upstream' as the remote name instead of 'origin'
    const repo = await repos.create({ remoteName: "upstream" });

    // Create feature branch with commits
    await repo.branch("feature");
    await repo.commit({ message: "First commit" });
    await repo.commit({ message: "Second commit" });

    // Run sync - should auto-detect the single remote
    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Adding IDs to 2 commit(s)");
    expect(result.stdout).toContain("Added Spry-Commit-Id to 2 commit(s)");

    // Verify the remote was auto-detected and persisted to config
    const configuredRemote = (await $`git -C ${repo.path} config --get spry.remote`.text()).trim();
    expect(configuredRemote).toBe("upstream");
  });
});

// ============================================================================
// Part 2: GitHub Integration Tests (requires GITHUB_INTEGRATION_TESTS=1)
// These tests interact with real GitHub API
// ============================================================================

describe.skipIf(SKIP_GITHUB_TESTS)("sync: GitHub fixture setup", () => {
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
    expect(github.repo).toBe(process.env.SPRY_TEST_REPO_NAME || "spry-check");
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

describe("sync --open: PR creation", () => {
  const repos = repoManager({ github: true });

  storyTest(
    "Skipping WIP commits",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "If you have a commit prefixed with 'WIP:', sp will push branches but skip opening a PR for it.",
      );

      const repo = await repos.clone({ testName: "wip-skip" });
      await repo.branch("feature/wip-test");
      await repo.commit({ message: "WIP: work in progress" });

      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Skipped PR for 1 temporary commit");
      expect(result.stdout).toContain("WIP: work in progress");

      // Verify NO PR was created (search by uniqueId to isolate from other tests)
      if (isGitHubIntegrationEnabled()) {
        const prs = await repo.findPRs(repo.uniqueId);
        expect(prs.length).toBe(0);
      }
    },
    { timeout: 60000 },
  );

  storyTest(
    "Skipping fixup! commits",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "Commits prefixed with 'fixup!' are meant to be squashed later, so sp skips opening PRs for them.",
      );

      const repo = await repos.clone({ testName: "fixup-skip" });
      await repo.branch("feature/fixup-test");
      await repo.commit({ message: "fixup! original commit" });

      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Skipped PR for 1 temporary commit");
      expect(result.stdout).toContain("fixup! original commit");

      // Verify NO PR was created
      if (isGitHubIntegrationEnabled()) {
        const prs = await repo.findPRs(repo.uniqueId);
        expect(prs.length).toBe(0);
      }
    },
    { timeout: 60000 },
  );

  storyTest(
    "Mixed stack with temp commits",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When a stack has both regular and temporary commits, sp creates PRs for the regular commits and skips the temporary ones.",
      );

      const repo = await repos.clone({ testName: "mixed-stack" });
      await repo.branch("feature/mixed-test");
      await repo.commit({ message: "Add feature A" }); // should get PR
      await repo.commit({ message: "WIP: still working on B" }); // should be skipped

      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created 1 PR");
      expect(result.stdout).toContain("Skipped PR for 1 temporary commit");

      // Verify only 1 PR was created (for the non-WIP commit)
      if (isGitHubIntegrationEnabled()) {
        const prs = await repo.findPRs(repo.uniqueId);
        expect(prs.length).toBe(1);
      }
    },
    { timeout: 60000 },
  );

  storyTest(
    "Single commit PR creation",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate("A feature branch with a single commit gets one PR created.");

      const repo = await repos.clone({ testName: "single-pr" });
      await repo.branch("feature/test-pr");
      await repo.commit();

      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created");

      // Verify progress feedback is shown (in non-TTY mode: "Creating PR for "title"... #number")
      expect(result.stdout).toContain("Creating PR for");
      expect(result.stdout).toMatch(/Creating PR for .+\.\.\. #\d+/);

      // Verify PR was created
      if (isGitHubIntegrationEnabled()) {
        const prs = await repo.findPRs(repo.uniqueId);
        expect(prs.length).toBeGreaterThanOrEqual(1);
      }
    },
    { timeout: 90000 },
  );

  storyTest(
    "Opening PRs for existing branches",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "If branches were previously pushed without --open, running sync --open later will create PRs for them.",
      );

      const repo = await repos.clone({ testName: "open-existing" });
      await repo.branch("feature/stacked-no-pr");
      await repo.commit();
      await repo.commit();

      // Run sp sync WITHOUT --open (just push branches)
      const syncResult = await runSync(repo.path, { open: false });
      story.narrate("First, sync without --open to just push branches:");
      story.log(syncResult);
      expect(syncResult.exitCode).toBe(0);

      // Verify no PRs were created yet (search by uniqueId to isolate from other tests)
      if (isGitHubIntegrationEnabled()) {
        const prsBefore = await repo.findPRs(repo.uniqueId);
        expect(prsBefore.length).toBe(0);
      }

      // Now run sp sync WITH --open
      story.narrate("Then, sync with --open to create PRs:");
      const openResult = await runSync(repo.path, { open: true });
      story.log(openResult);

      expect(openResult.exitCode).toBe(0);

      // Verify progress feedback is shown for each PR
      expect(openResult.stdout).toContain("Creating PR for");

      // Verify PRs were created
      if (isGitHubIntegrationEnabled()) {
        const prsAfter = await repo.findPRs(repo.uniqueId);
        expect(prsAfter.length).toBe(2);
      }
    },
    { timeout: 90000 },
  );

  storyTest(
    "Only pushes branches up to the last PR (--apply filtering)",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When using --apply to selectively create PRs, sp only pushes branches up to the highest selected commit, not the entire stack.",
      );

      const repo = await repos.clone({ testName: "pr-boundary" });

      // Use withSpryIds scenario which creates 5 commits with IDs
      await scenarios.withSpryIds.setup(repo);

      // Count commits in the stack
      const commitCount = (
        await $`git -C ${repo.path} rev-list --count origin/main..HEAD`.text()
      ).trim();
      const totalCommits = parseInt(commitCount, 10);

      // Get the hash of the middle commit (3rd out of 5)
      const middleIndex = Math.floor(totalCommits / 2) + 1; // 3 for 5 commits
      const middleCommitHash = (
        await $`git -C ${repo.path} rev-parse HEAD~${totalCommits - middleIndex}`.text()
      ).trim();

      story.narrate(
        `Stack has ${totalCommits} commits. We'll use --apply to only open a PR for commit #${middleIndex} (${middleCommitHash.slice(0, 8)}).`,
      );

      // Run sync --open with --apply to only create PR for the middle commit
      const result = await runSpry(repo.path, "sync", [
        "--open",
        "--apply",
        JSON.stringify([middleCommitHash]),
      ]);
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created 1 PR");
      expect(result.stdout).toContain(`Pushed ${middleIndex} branch(es)`);

      // Verify only 1 PR was created
      if (isGitHubIntegrationEnabled()) {
        const prs = await repo.findPRs(repo.uniqueId);
        expect(prs.length).toBe(1);
      }

      // Verify only branches up to middleIndex were pushed
      const remoteBranches = (
        await $`git -C ${repo.path} ls-remote origin 'refs/heads/spry/*'`.text()
      ).trim();
      const branchCount = remoteBranches.split("\n").filter((l) => l.trim()).length;

      // Should have exactly middleIndex branches (all commits up to and including the one with PR)
      expect(branchCount).toBe(middleIndex);
    },
    { timeout: 90000 },
  );
});

describe("sync: PR body generation", () => {
  const repos = repoManager({ github: true });

  /** Helper to get PR body via gh CLI */
  async function getPRBody(
    github: { owner: string; repo: string },
    prNumber: number,
  ): Promise<string> {
    const result =
      await $`gh pr view ${prNumber} --repo ${github.owner}/${github.repo} --json body`.text();
    return JSON.parse(result).body || "";
  }

  storyTest(
    "PR body from commit message",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate("When creating a PR, sp generates a body with the commit message content.");

      const repo = await repos.clone({ testName: "pr-body-basic" });
      await repo.branch("feature/body-test");
      // Use default commit (with auto-generated title containing uniqueId) but add body via commitFiles
      await repo.commitFiles(
        { "feature.txt": "New feature content" },
        {
          message: `Add feature [${repo.uniqueId}]\n\nThis is a detailed description of the feature.`,
        },
      );

      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(0);

      if (isGitHubIntegrationEnabled()) {
        const pr = await repo.findPR(repo.uniqueId);
        const body = await getPRBody(repo.github, pr.number);

        // Body should contain spry markers
        expect(body).toContain("<!-- spry:body:begin -->");
        expect(body).toContain("<!-- spry:body:end -->");
        // Body should contain the commit description
        expect(body).toContain("This is a detailed description of the feature.");
        // Footer should be present
        expect(body).toContain("<!-- spry:footer:begin -->");
        expect(body).toContain("Spry");
      }
    },
    { timeout: 60000 },
  );

  storyTest(
    "Stack links in PR body",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When a stack has multiple PRs, each PR body contains links to all PRs in the stack.",
      );

      const repo = await repos.clone({ testName: "pr-body-stack" });
      await repo.branch("feature/stack-links-test");
      await repo.commit({ message: "First commit in stack" });
      await repo.commit({ message: "Second commit in stack" });

      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created 2 PR");

      if (isGitHubIntegrationEnabled()) {
        const prs = await repo.findPRs(repo.uniqueId);
        expect(prs.length).toBe(2);

        // Check first PR body has stack links
        const firstPR = prs.find((p) => p.title.includes("First commit"));
        if (!firstPR) throw new Error("First PR not found");

        const body = await getPRBody(repo.github, firstPR.number);

        // Should have stack links section
        expect(body).toContain("<!-- spry:stack-links:begin -->");
        expect(body).toContain("<!-- spry:stack-links:end -->");
        expect(body).toContain("**Stack**");
        expect(body).toContain("← this PR");
      }
    },
    { timeout: 90000 },
  );

  storyTest(
    "Group PR with commit list",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When multiple commits are grouped, the PR body lists all commit subjects as bullet points. " +
          "Using --allow-untitled-pr since this group has no stored title.",
      );

      const repo = await repos.clone({ testName: "pr-body-group" });
      await repo.branch("feature/group-body-test");

      // Create grouped commits - the group ID needs to match pattern and commit messages get uniqueId appended
      const groupId = `group-${repo.uniqueId}`;
      await repo.commit({
        message: `Start feature X [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });
      await repo.commit({
        message: `Continue feature X [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });
      await repo.commit({
        message: `Complete feature X [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });

      // Use --allow-untitled-pr since this group has no stored title
      const result = await runSync(repo.path, { open: true, allowUntitledPr: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created 1 PR");

      if (isGitHubIntegrationEnabled()) {
        const pr = await repo.findPR(repo.uniqueId);
        const body = await getPRBody(repo.github, pr.number);

        // Body should list all commit subjects
        expect(body).toContain("- Start feature X");
        expect(body).toContain("- Continue feature X");
        expect(body).toContain("- Complete feature X");
      }
    },
    { timeout: 60000 },
  );

  storyTest(
    "Untitled group PR error",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When a group has no stored title and --allow-untitled-pr is not set, sync fails with a helpful error.",
      );

      const repo = await repos.clone({ testName: "pr-body-untitled-fail" });
      await repo.branch("feature/untitled-group-test");

      // Create grouped commits without a stored title
      const groupId = `group-${repo.uniqueId}`;
      await repo.commit({
        message: `First commit [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });
      await repo.commit({
        message: `Second commit [${repo.uniqueId}]`,
        trailers: { "Spry-Group": groupId },
      });

      // Without --allow-untitled-pr, this should fail
      const result = await runSync(repo.path, { open: true });
      story.log(result);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("has no stored title");
      expect(result.stderr).toContain("sp group");
      expect(result.stderr).toContain("--allow-untitled-pr");
    },
    { timeout: 60000 },
  );
});

describe.skipIf(SKIP_GITHUB_TESTS)("sync: branch protection", () => {
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

describe("sync: merged PR cleanup", () => {
  const repos = repoManager({ github: true });

  storyTest.noStory(
    "detects merged PRs and cleans up their remote branches when merged via GitHub UI",
    async () => {
      const repo = await repos.clone({ testName: "cleanup" });
      await repo.branch("feature/cleanup-test");
      await repo.commit();
      await repo.commit();

      // Run sp sync --open to create PRs
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      if (isGitHubIntegrationEnabled()) {
        // Get PRs (both will have uniqueId in title)
        const prs = await repo.findPRs(repo.uniqueId);
        expect(prs.length).toBe(2);
        const firstPr = prs[0];
        const secondPr = prs[1];
        if (!firstPr || !secondPr) throw new Error("Expected 2 PRs");

        // Wait for CI on the first PR
        await repo.github.waitForCI(firstPr.number, { timeout: 180000 });

        // Merge the first PR via GitHub API (simulating GitHub UI merge)
        // Note: deleteBranch: false to leave the branch orphaned
        await repo.github.mergePR(firstPr.number, { deleteBranch: false });

        // Verify first PR is merged but branch still exists
        const firstStatus =
          await $`gh pr view ${firstPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
        expect(JSON.parse(firstStatus).state).toBe("MERGED");

        // Verify the branch still exists (orphaned)
        const branchCheck =
          await $`gh api repos/${repo.github.owner}/${repo.github.repo}/branches/${firstPr.headRefName}`.nothrow();
        expect(branchCheck.exitCode).toBe(0); // Branch should still exist
      }

      // Now run sync again - it should detect the merged PR and clean up the orphaned branch
      const syncResult2 = await runSync(repo.path, { open: false });

      expect(syncResult2.exitCode).toBe(0);
      expect(syncResult2.stdout).toContain("Cleaned up");
      expect(syncResult2.stdout).toMatch(/#\d+/);

      if (isGitHubIntegrationEnabled()) {
        const prs = await repo.findPRs(repo.uniqueId);
        const firstPr = prs[0];
        if (!firstPr) throw new Error("Expected at least 1 PR");

        // Verify the orphaned branch was deleted
        const branchGone = await repo.waitForBranchGone(firstPr.headRefName);
        expect(branchGone).toBe(true);

        // The second PR should still be tracked (not cleaned up)
        const secondPr = prs[1];
        if (!secondPr) throw new Error("Expected 2 PRs");
        const secondStatus =
          await $`gh pr view ${secondPr.number} --repo ${repo.github.owner}/${repo.github.repo} --json state`.text();
        expect(JSON.parse(secondStatus).state).toBe("OPEN");
      }
    },
    { timeout: 300000 },
  );
});

// ============================================================================
// Part 3: CI verification (record-mode waits for CI; replay uses snapshots)
// ============================================================================

describe("sync --open: CI verification", () => {
  const repos = repoManager({ github: true });

  storyTest.noStory(
    "CI passes for normal commits",
    async () => {
      const repo = await repos.clone({ testName: "ci-pass" });
      await repo.branch("feature/ci-pass-test");
      await repo.commit();

      const result = await runSync(repo.path, { open: true });
      expect(result.exitCode).toBe(0);

      if (isGitHubIntegrationEnabled()) {
        const pr = await repo.findPR(repo.uniqueId);
        const ciStatus = await repo.github.waitForCI(pr.number, { timeout: 180000 });
        expect(ciStatus.state).toBe("success");
      }
    },
    { timeout: 200000 },
  );

  storyTest.noStory(
    "CI fails for commits with [FAIL_CI] marker",
    async () => {
      const repo = await repos.clone({ testName: "sync-ci-fail" });
      await repo.branch("feature/ci-fail-test");
      await repo.commit({ message: "[FAIL_CI] trigger CI failure" });

      const result = await runSync(repo.path, { open: true });
      expect(result.exitCode).toBe(0);

      if (isGitHubIntegrationEnabled()) {
        const pr = await repo.findPR(repo.uniqueId);
        const ciStatus = await repo.github.waitForCI(pr.number, { timeout: 180000 });
        expect(ciStatus.state).toBe("failure");
      }
    },
    { timeout: 200000 },
  );
});
