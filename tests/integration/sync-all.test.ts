/**
 * sync --all command tests
 *
 * Tests the `sp sync --all` feature that syncs all Spry-tracked branches
 * in the repository at once.
 */
import { test, expect, describe } from "bun:test";
import { repoManager } from "../helpers/local-repo.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import { runSpry } from "./helpers.ts";
import { listSpryLocalBranches } from "../../src/git/commands.ts";

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
    // Should report "Rebased: 1 branch(es)" in summary
    expect(result.stdout).toMatch(/Rebased:\s*1\s*branch/i);
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
