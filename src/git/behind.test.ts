import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import { scenarios } from "../scenario/definitions.ts";
import {
  isStackBehindMain,
  getCommitsBehind,
  getLocalMainStatus,
  fastForwardLocalMain,
} from "./behind.ts";

const repos = repoManager();

describe("git/behind", () => {
  describe("isStackBehindMain", () => {
    test("returns false when stack is up to date", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);

      const result = await isStackBehindMain({ cwd: repo.path });
      expect(result).toBe(false);
    });

    test("returns true when origin/main has new commits", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);
      await repo.updateOriginMain("Commit from main");

      const result = await isStackBehindMain({ cwd: repo.path });
      expect(result).toBe(true);
    });

    test("returns false when stack is ahead but not behind", async () => {
      const repo = await repos.create();
      await scenarios.multiCommitStack.setup(repo);

      // Stack is ahead of main but not behind
      const result = await isStackBehindMain({ cwd: repo.path });
      expect(result).toBe(false);
    });
  });

  describe("getCommitsBehind", () => {
    test("returns 0 when stack is up to date", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);
      await repo.fetch();

      const count = await getCommitsBehind({ cwd: repo.path });
      expect(count).toBe(0);
    });

    test("returns correct count when behind by N commits", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);

      // Push multiple commits to origin/main
      for (let i = 1; i <= 3; i++) {
        await repo.updateOriginMain(`Main commit ${i}`);
      }
      await repo.fetch();

      const count = await getCommitsBehind({ cwd: repo.path });
      expect(count).toBe(3);
    });

    test("returns correct count when diverged (both ahead and behind)", async () => {
      const repo = await repos.create();
      await scenarios.multiCommitStack.setup(repo);
      await repo.updateOriginMain("Divergent commit");
      await repo.fetch();

      // Stack is 3 ahead, 1 behind
      const count = await getCommitsBehind({ cwd: repo.path });
      expect(count).toBe(1);
    });
  });

  describe("getLocalMainStatus", () => {
    test("returns not behind when local main matches remote", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);
      await repo.fetch();

      const status = await getLocalMainStatus({ cwd: repo.path });
      expect(status.isBehind).toBe(false);
      expect(status.commitsBehind).toBe(0);
      expect(status.canFastForward).toBe(false);
      expect(status.commitsAhead).toBe(0);
    });

    test("returns canFastForward true when local main is strictly behind", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);
      await repo.updateOriginMain("New commit on main");
      await repo.fetch();

      const status = await getLocalMainStatus({ cwd: repo.path });
      expect(status.isBehind).toBe(true);
      expect(status.commitsBehind).toBe(1);
      expect(status.canFastForward).toBe(true);
      expect(status.commitsAhead).toBe(0);
    });

    test("returns canFastForward false when local main has diverged", async () => {
      const repo = await repos.create();
      // Start on main and add a local commit
      await repo.commit({ message: "Local commit on main" });
      // Add a commit to origin/main (creates divergence)
      await repo.updateOriginMain("Remote commit on main");
      await repo.fetch();

      const status = await getLocalMainStatus({ cwd: repo.path });
      expect(status.isBehind).toBe(true);
      expect(status.commitsBehind).toBe(1);
      expect(status.canFastForward).toBe(false);
      expect(status.commitsAhead).toBe(1);
    });
  });

  describe("fastForwardLocalMain", () => {
    test("fast-forwards local main when strictly behind", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);

      // Add commits to origin/main
      await repo.updateOriginMain("Main commit 1");
      await repo.updateOriginMain("Main commit 2");
      await repo.fetch();

      // Get SHA before fast-forward
      const mainBefore = (
        await $`git -C ${repo.path} rev-parse main`.text()
      ).trim();
      const remoteSha = (
        await $`git -C ${repo.path} rev-parse origin/main`.text()
      ).trim();

      expect(mainBefore).not.toBe(remoteSha);

      const result = await fastForwardLocalMain({ cwd: repo.path });
      expect(result).toBe(true);

      // Verify local main now matches origin/main
      const mainAfter = (
        await $`git -C ${repo.path} rev-parse main`.text()
      ).trim();
      expect(mainAfter).toBe(remoteSha);
    });

    test("returns false when already up-to-date", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);
      await repo.fetch();

      const result = await fastForwardLocalMain({ cwd: repo.path });
      expect(result).toBe(false);
    });

    test("throws when local main has diverged", async () => {
      const repo = await repos.create();
      // Add local commit on main
      await repo.commit({ message: "Local commit" });
      // Add remote commit (creates divergence)
      await repo.updateOriginMain("Remote commit");
      await repo.fetch();

      await expect(fastForwardLocalMain({ cwd: repo.path })).rejects.toThrow(
        /Cannot fast-forward/,
      );
    });

    test("works while on a feature branch", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);

      // Add commits to origin/main while we're on a feature branch
      await repo.updateOriginMain("Main commit");
      await repo.fetch();

      // We're on feature branch, but should still be able to ff local main
      const result = await fastForwardLocalMain({ cwd: repo.path });
      expect(result).toBe(true);

      // Verify we're still on our feature branch
      const currentBranch = await repo.currentBranch();
      expect(currentBranch).not.toBe("main");
    });
  });
});
