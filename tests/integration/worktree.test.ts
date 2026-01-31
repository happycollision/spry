/**
 * Worktree sync tests
 *
 * These tests verify that `sp sync` behaves correctly when branches are
 * checked out in multiple worktrees. The key issue is that plumbing operations
 * (like `git update-ref`) can update a branch ref without updating the working
 * directory, leaving worktrees in a dirty state.
 *
 * Scenarios covered:
 * 1. Main checked out in another worktree + fast-forward
 * 2. Feature branch checked out in another worktree + rebase
 * 3. Multiple worktrees with stacked branches
 */
import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { realpath } from "node:fs/promises";
import { repoManager } from "../helpers/local-repo.ts";
import { runSync } from "./helpers.ts";

describe("sync: worktree behavior", () => {
  const repos = repoManager();

  test("main checked out in another worktree - fast-forward should not dirty worktree", async () => {
    const repo = await repos.create();

    // Main repo stays on main (this is the default after create)
    // Create a feature branch but don't switch to it yet
    const featureBranch = await repo.branch("feature");
    await repo.commit({ message: "Feature commit" });

    // Now create a worktree for the feature branch
    // First, go back to main
    await repo.checkout("main");

    // Create a new worktree for the feature branch
    const worktree = await repo.createWorktree(featureBranch);

    // Update origin/main (simulates another developer pushing)
    await repo.updateOriginMain("Remote commit on main");
    await repo.fetch();

    // Verify local main is behind origin/main
    const localMainBefore = (await $`git -C ${repo.path} rev-parse main`.text()).trim();
    const remoteSha = (await $`git -C ${repo.path} rev-parse origin/main`.text()).trim();
    expect(localMainBefore).not.toBe(remoteSha);

    // Run sync from the worktree (which is on the feature branch)
    const result = await runSync(worktree.path);
    expect(result.exitCode).toBe(0);

    // Check if the main repo's working directory is clean
    // If fast-forward happened via update-ref, main's worktree would be dirty
    const mainStatus = await $`git -C ${repo.path} status --porcelain`.text();

    // This is the key assertion - main's worktree should remain clean
    // If this fails, it means fast-forward dirtied the main worktree
    expect(mainStatus.trim()).toBe("");
  });

  test("main checked out in another worktree - shows working directory status", async () => {
    // This test documents the CURRENT (potentially buggy) behavior
    const repo = await repos.create();

    // Create and switch to a feature branch
    const featureBranch = await repo.branch("feature");
    await repo.commit({ message: "Feature commit" });

    // Go back to main and create a worktree for the feature branch
    await repo.checkout("main");
    const worktree = await repo.createWorktree(featureBranch);

    // Update origin/main
    await repo.updateOriginMain("Remote commit on main");
    await repo.fetch();

    // Get main's status BEFORE sync
    const mainStatusBefore = await $`git -C ${repo.path} status --porcelain`.text();
    expect(mainStatusBefore.trim()).toBe(""); // Should be clean before

    // Run sync from worktree
    const result = await runSync(worktree.path);
    expect(result.exitCode).toBe(0);

    // Get main's status AFTER sync
    const mainStatusAfter = await $`git -C ${repo.path} status --porcelain`.text();

    // Main worktree should remain clean after sync from feature worktree
    expect(mainStatusAfter.trim()).toBe("");
  });

  test("feature branch in another worktree - plumbing rebase should not dirty worktree", async () => {
    const repo = await repos.create();

    // Create feature branch A and make commits
    const featureA = await repo.branch("feature-a");
    await repo.commit({ message: "Feature A commit 1" });
    await repo.commit({ message: "Feature A commit 2" });

    // Create feature branch B that builds on A
    const featureB = await repo.branch("feature-b");
    await repo.commit({ message: "Feature B commit" });

    // Go back to feature-a and create a worktree for feature-b
    await repo.checkout(featureA);
    const worktreeB = await repo.createWorktree(featureB);

    // Update origin/main so rebase is needed
    await repo.updateOriginMain("Remote commit triggering rebase");
    await repo.fetch();

    // Get feature-a worktree status before sync
    const featureAStatusBefore = await $`git -C ${repo.path} status --porcelain`.text();
    expect(featureAStatusBefore.trim()).toBe("");

    // Run sync from worktree B
    const result = await runSync(worktreeB.path);
    expect(result.exitCode).toBe(0);

    // Check feature-a worktree status after sync
    const featureAStatusAfter = await $`git -C ${repo.path} status --porcelain`.text();

    // The feature-a worktree should remain clean
    // If it's dirty, the plumbing rebase is affecting other worktrees
    expect(featureAStatusAfter.trim()).toBe("");

    // Verify feature-b is now on top of origin/main (ancestry check)
    const mergeBase = (await $`git -C ${worktreeB.path} merge-base HEAD origin/main`.text()).trim();
    const originMain = (await $`git -C ${worktreeB.path} rev-parse origin/main`.text()).trim();
    expect(mergeBase).toBe(originMain);
  });

  test("sync rebases feature branch on top of origin/main (ancestry verification)", async () => {
    const repo = await repos.create();

    // Create feature branch with commits
    await repo.branch("feature");
    await repo.commit({ message: "Feature commit 1" });
    await repo.commit({ message: "Feature commit 2" });

    // Update origin/main so rebase is needed
    await repo.updateOriginMain("Remote commit on main");
    await repo.fetch();

    // Verify we're behind origin/main before sync
    const behindCount = (
      await $`git -C ${repo.path} rev-list HEAD..origin/main --count`.text()
    ).trim();
    expect(parseInt(behindCount, 10)).toBeGreaterThan(0);

    // Run sync
    const result = await runSync(repo.path);
    expect(result.exitCode).toBe(0);

    // Verify feature branch is now on top of origin/main
    // merge-base HEAD origin/main should equal origin/main
    const mergeBase = (await $`git -C ${repo.path} merge-base HEAD origin/main`.text()).trim();
    const originMain = (await $`git -C ${repo.path} rev-parse origin/main`.text()).trim();
    expect(mergeBase).toBe(originMain);

    // Verify we still have our commits (not just origin/main)
    const aheadCount = (
      await $`git -C ${repo.path} rev-list origin/main..HEAD --count`.text()
    ).trim();
    expect(parseInt(aheadCount, 10)).toBe(2); // Our 2 feature commits
  });

  test("listWorktrees returns correct information", async () => {
    const repo = await repos.create();

    // Initially should have just the main worktree
    const initialWorktrees = await repo.listWorktrees();
    expect(initialWorktrees.length).toBe(1);
    expect(initialWorktrees[0]?.isMain).toBe(true);
    expect(initialWorktrees[0]?.branch).toBe("main");

    // Create a feature branch and worktree
    const featureBranch = await repo.branch("feature");
    await repo.commit({ message: "Feature commit" });
    await repo.checkout("main");

    const worktree = await repo.createWorktree(featureBranch);

    // Should now have two worktrees
    const worktrees = await repo.listWorktrees();
    expect(worktrees.length).toBe(2);

    const mainWt = worktrees.find((wt) => wt.isMain);
    const featureWt = worktrees.find((wt) => !wt.isMain);

    expect(mainWt).toBeDefined();
    expect(mainWt?.branch).toBe("main");

    expect(featureWt).toBeDefined();
    expect(featureWt?.branch).toBe(featureBranch);
    // Compare resolved paths to handle symlinks (e.g., /tmp -> /private/tmp on macOS)
    const resolvedFeatureWtPath = featureWt?.path ? await realpath(featureWt.path) : "";
    const resolvedWorktreePath = await realpath(worktree.path);
    expect(resolvedFeatureWtPath).toBe(resolvedWorktreePath);
  });

  test("removeWorktree cleans up correctly", async () => {
    const repo = await repos.create();

    // Create a feature branch and worktree
    const featureBranch = await repo.branch("feature");
    await repo.commit({ message: "Feature commit" });
    await repo.checkout("main");

    const worktree = await repo.createWorktree(featureBranch);

    // Verify it exists
    let worktrees = await repo.listWorktrees();
    expect(worktrees.length).toBe(2);

    // Remove it
    await repo.removeWorktree(worktree.path);

    // Verify it's gone
    worktrees = await repo.listWorktrees();
    expect(worktrees.length).toBe(1);
    expect(worktrees[0]?.isMain).toBe(true);
  });
});
