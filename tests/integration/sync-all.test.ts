/**
 * sync --all command tests
 *
 * Tests the `sp sync --all` feature that syncs all Spry-tracked branches
 * in the repository at once.
 */
import { $ } from "bun";
import { test, expect, describe } from "bun:test";
import { repoManager } from "../helpers/local-repo.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import { runSpry } from "./helpers.ts";
import {
  listSpryLocalBranches,
  getCurrentBranch,
  getStackCommitsWithTrailers,
} from "../../src/git/commands.ts";
import { validateBranchStack } from "../../src/git/rebase.ts";
import { syncAllCommand } from "../../src/cli/commands/sync.ts";

// ============================================================================
// Phase 1: Foundation + CLI Stub Tests
// ============================================================================

describe("sync --all: Phase 1 - Foundation", () => {
  const repos = repoManager();

  test("--all discovers Spry branches and excludes non-Spry", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    // Should include Spry branches
    expect(result.stdout).toContain("feature-behind");
    expect(result.stdout).toContain("feature-conflict");
    expect(result.stdout).toContain("feature-mixed");
    expect(result.stdout).toContain("feature-split");
    expect(result.stdout).toContain("feature-uptodate");
    // Should NOT include non-Spry branch
    expect(result.stdout).not.toContain("feature-nospry");
  });

  test("--all syncs current branch (rebase)", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    // Current branch (feature-behind) should be rebased, not just listed
    expect(result.stdout).toContain("feature-behind");
    expect(result.stdout).toMatch(/feature-behind.*rebased.*commit.*current branch/i);
    // Should report "Rebased: 3 branch(es)" in summary (behind, mixed, uptodate)
    // Note: feature-conflict skipped due to conflict, feature-split skipped due to split group
    expect(result.stdout).toMatch(/Rebased:\s*3\s*branch/i);
  });

  test("--all and --open are mutually exclusive", async () => {
    const repo = await repos.create();
    const result = await runSpry(repo.path, "sync", ["--all", "--open"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });

  test("--all is incompatible with --apply", async () => {
    const repo = await repos.create();
    const result = await runSpry(repo.path, "sync", ["--all", "--apply", '["abc"]']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot be used with");
  });

  test("--all is incompatible with --up-to", async () => {
    const repo = await repos.create();
    const result = await runSpry(repo.path, "sync", ["--all", "--up-to", "abc"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot be used with");
  });

  test("--all is incompatible with --interactive", async () => {
    const repo = await repos.create();
    const result = await runSpry(repo.path, "sync", ["--all", "--interactive"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot be used with");
  });

  test("help shows --all option", async () => {
    const repo = await repos.create();
    const result = await runSpry(repo.path, "sync", ["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--all");
    expect(result.stdout).toContain("Sync all Spry-tracked branches");
  });

  test("listSpryLocalBranches returns Spry branches with correct info", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const branches = await listSpryLocalBranches({ cwd: repo.path });

    // Should have 5 Spry branches (not the non-Spry one)
    expect(branches.length).toBe(5);

    // Check branch names (they include the unique ID suffix)
    const branchNames = branches.map((b) => b.name);
    expect(branchNames.some((n) => n.includes("feature-behind"))).toBe(true);
    expect(branchNames.some((n) => n.includes("feature-conflict"))).toBe(true);
    expect(branchNames.some((n) => n.includes("feature-mixed"))).toBe(true);
    expect(branchNames.some((n) => n.includes("feature-split"))).toBe(true);
    expect(branchNames.some((n) => n.includes("feature-uptodate"))).toBe(true);
    // Should NOT include non-Spry branch
    expect(branchNames.some((n) => n.includes("feature-nospry"))).toBe(false);
  });

  test("listSpryLocalBranches detects hasMissingIds", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const branches = await listSpryLocalBranches({ cwd: repo.path });

    const mixedBranch = branches.find((b) => b.name.includes("feature-mixed"));
    expect(mixedBranch).toBeDefined();
    expect(mixedBranch!.hasMissingIds).toBe(true);

    const behindBranch = branches.find((b) => b.name.includes("feature-behind"));
    expect(behindBranch).toBeDefined();
    expect(behindBranch!.hasMissingIds).toBe(false);
  });

  test("listSpryLocalBranches returns commit count", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const branches = await listSpryLocalBranches({ cwd: repo.path });

    // feature-behind has 1 commit
    const behindBranch = branches.find((b) => b.name.includes("feature-behind"));
    expect(behindBranch).toBeDefined();
    expect(behindBranch!.commitCount).toBe(1);

    // feature-mixed has 2 commits
    const mixedBranch = branches.find((b) => b.name.includes("feature-mixed"));
    expect(mixedBranch).toBeDefined();
    expect(mixedBranch!.commitCount).toBe(2);

    // feature-split has 3 commits
    const splitBranch = branches.find((b) => b.name.includes("feature-split"));
    expect(splitBranch).toBeDefined();
    expect(splitBranch!.commitCount).toBe(3);
  });

  test("--all with no Spry branches shows appropriate message", async () => {
    const repo = await repos.create();
    // Just a plain repo with no Spry branches
    await repo.branch("feature");
    await repo.commit({ message: "Plain commit without Spry-Commit-Id" });

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No Spry-tracked branches found");
  });

  test("--all reports count of discovered branches", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    // Should report "Syncing 5 Spry branch(es)" or similar
    expect(result.stdout).toMatch(/Syncing \d+ Spry branch/);
  });
});

// ============================================================================
// Phase 3: Stack Validation Tests
// ============================================================================

describe("sync --all: Phase 3 - Stack Validation", () => {
  const repos = repoManager();

  test("validateBranchStack detects split group on non-current branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    // feature-split has a split group (groupA)
    const result = await validateBranchStack(`feature-split-${repo.uniqueId}`, { cwd: repo.path });

    expect(result.valid).toBe(false);
    expect(result.error).toBe("split-group");
    expect(result.splitGroupInfo?.groupId).toBe("groupA");
    expect(result.splitGroupInfo?.interruptingCommits.length).toBeGreaterThan(0);
  });

  test("validateBranchStack returns valid for well-formed branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    // feature-behind has a valid stack (no split groups)
    const result = await validateBranchStack(`feature-behind-${repo.uniqueId}`, { cwd: repo.path });

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.splitGroupInfo).toBeUndefined();
  });

  test("validateBranchStack does not change current branch", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const branchBefore = await getCurrentBranch({ cwd: repo.path });

    // Validate a different branch (feature-split has split group)
    await validateBranchStack(`feature-split-${repo.uniqueId}`, { cwd: repo.path });

    const branchAfter = await getCurrentBranch({ cwd: repo.path });
    expect(branchAfter).toBe(branchBefore);
  });

  test("--all skips branches with split groups", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    // Should show the split group skip reason with group title
    expect(result.stdout).toContain("feature-split");
    expect(result.stdout).toContain("split group");
    // Group title falls back to first commit subject when no stored title
    expect(result.stdout).toContain("Group A part 1");
  });

  test("--all shows sp group --fix suggestion for split groups", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sp group --fix");
  });
});

// ============================================================================
// Phase 4: Full Orchestration Tests
// ============================================================================

describe("sync --all: Phase 4 - Full Orchestration", () => {
  const repos = repoManager();

  test("rebases non-current branches that are behind", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    // feature-mixed is behind origin/main and not current
    const mixedBranch = `feature-mixed-${repo.uniqueId}`;

    // Verify branch is behind before sync
    const behindBefore = (
      await $`git -C ${repo.path} rev-list --count ${mixedBranch}..origin/main`.text()
    ).trim();
    expect(parseInt(behindBefore)).toBeGreaterThan(0);

    const result = await syncAllCommand({ cwd: repo.path });

    // feature-mixed should be rebased (after ID injection)
    const mixedRebased = result.rebased.find((r) => r.branch.includes("feature-mixed"));
    expect(mixedRebased).toBeDefined();
    expect(mixedRebased!.commitCount).toBeGreaterThan(0);
  });

  test("rebased branches have correct ancestry (on top of origin/main)", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const mixedBranch = `feature-mixed-${repo.uniqueId}`;

    await syncAllCommand({ cwd: repo.path });

    // After sync, branch should be on top of origin/main
    const mergeBase = (
      await $`git -C ${repo.path} merge-base ${mixedBranch} origin/main`.text()
    ).trim();
    const originMain = (await $`git -C ${repo.path} rev-parse origin/main`.text()).trim();
    expect(mergeBase).toBe(originMain);
  });

  test("injects missing IDs before rebasing", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await syncAllCommand({ cwd: repo.path });

    // feature-mixed should be rebased with IDs injected
    const mixedRebased = result.rebased.find((r) => r.branch.includes("feature-mixed"));
    expect(mixedRebased).toBeDefined();
    expect(mixedRebased!.idsInjected).toBeGreaterThan(0);

    // Verify all commits on feature-mixed now have IDs
    const commits = await getStackCommitsWithTrailers({
      cwd: repo.path,
      branch: mixedRebased!.branch,
    });
    for (const commit of commits) {
      expect(commit.trailers["Spry-Commit-Id"]).toBeDefined();
    }
  });

  test("skips branches that would conflict", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await syncAllCommand({ cwd: repo.path });

    // feature-conflict should be skipped with conflict reason
    const conflictSkip = result.skipped.find((s) => s.branch.includes("feature-conflict"));
    expect(conflictSkip).toBeDefined();
    expect(conflictSkip?.reason).toBe("conflict");
    expect(conflictSkip?.conflictFiles).toBeDefined();
    expect(conflictSkip?.conflictFiles?.length).toBeGreaterThan(0);
  });

  test("skips branches with split groups", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await syncAllCommand({ cwd: repo.path });

    // feature-split should be skipped with split-group reason
    const splitSkip = result.skipped.find((s) => s.branch.includes("feature-split"));
    expect(splitSkip).toBeDefined();
    expect(splitSkip?.reason).toBe("split-group");
    expect(splitSkip?.splitGroupInfo?.groupId).toBe("groupA");
  });

  test("marks up-to-date branches as skipped", async () => {
    const repo = await repos.create();

    // Create a branch that will be behind
    await repo.branch("feature-behind");
    await repo.commit({
      message: "Behind commit",
      trailers: { "Spry-Commit-Id": "bhnd0001" },
    });

    // Update origin/main
    await repo.updateOriginMain("Upstream change");
    await repo.fetch();

    // Create a branch AFTER the origin/main update (so it's on top of origin/main)
    await repo.checkout(repo.defaultBranch);
    // Pull the update to local main
    await $`git -C ${repo.path} merge origin/main`.quiet();
    await repo.branch("feature-uptodate");
    await repo.commit({
      message: "Up to date commit",
      trailers: { "Spry-Commit-Id": "uptd0001" },
    });

    // Go back to the behind branch
    await repo.checkout(`feature-behind-${repo.uniqueId}`);

    const result = await syncAllCommand({ cwd: repo.path });

    // feature-behind should be rebased
    const behindRebased = result.rebased.find((r) => r.branch.includes("feature-behind"));
    expect(behindRebased).toBeDefined();

    // feature-uptodate should be skipped as up-to-date
    const uptodateSkip = result.skipped.find((s) => s.branch.includes("feature-uptodate"));
    expect(uptodateSkip).toBeDefined();
    expect(uptodateSkip?.reason).toBe("up-to-date");
  });

  test("CLI output shows success symbol for rebased branches", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    // Check for success symbol on rebased branches
    expect(result.stdout).toMatch(/✓.*rebased/);
  });

  test("CLI output shows skip symbol for skipped branches", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    // Check for skip symbol
    expect(result.stdout).toMatch(/⊘.*skipped/);
  });

  test("CLI summary shows breakdown of skip reasons", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    // Should show summary with breakdown
    expect(result.stdout).toContain("Rebased:");
    expect(result.stdout).toContain("Skipped:");
    // Should include reason breakdown
    expect(result.stdout).toMatch(/up-to-date|conflict|split-group/);
  });

  test("does not change current branch after syncing", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const branchBefore = await getCurrentBranch({ cwd: repo.path });

    await syncAllCommand({ cwd: repo.path });

    const branchAfter = await getCurrentBranch({ cwd: repo.path });
    expect(branchAfter).toBe(branchBefore);
  });

  test("handles empty Spry branch list gracefully", async () => {
    const repo = await repos.create();

    // Create only non-Spry branches
    await repo.branch("feature-plain");
    await repo.commit({ message: "No Spry-Commit-Id" });

    const result = await syncAllCommand({ cwd: repo.path });

    expect(result.rebased).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});
