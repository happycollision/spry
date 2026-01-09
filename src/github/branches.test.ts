import { describe, test, expect } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import { getBranchName, pushBranch, type BranchNameConfig } from "./branches.ts";

const repos = repoManager();

describe("github/branches", () => {
  describe("getBranchName", () => {
    test("generates branch name with default prefix", () => {
      const config: BranchNameConfig = { prefix: "spry", username: "testuser" };
      expect(getBranchName("abc12345", config)).toBe("spry/testuser/abc12345");
    });

    test("generates branch name with custom prefix", () => {
      const config: BranchNameConfig = { prefix: "stacked", username: "msims" };
      expect(getBranchName("deadbeef", config)).toBe("stacked/msims/deadbeef");
    });
  });

  describe("pushBranch", () => {
    test("pushes a commit to a new branch", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const commitHash = await repo.commit();

      // Push to a new branch in origin
      await pushBranch(commitHash, "spry/testuser/test123", false, { cwd: repo.path });

      // Verify the branch exists in origin
      const result = await $`git -C ${repo.originPath} branch --list spry/testuser/test123`.text();
      expect(result.trim()).toBe("spry/testuser/test123");
    });

    test("updates an existing branch", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const firstCommit = await repo.commit();
      await pushBranch(firstCommit, "spry/testuser/update123", false, { cwd: repo.path });

      const secondCommit = await repo.commit();
      await pushBranch(secondCommit, "spry/testuser/update123", true, { cwd: repo.path });

      // Verify the branch points to the second commit
      const result = await $`git -C ${repo.originPath} rev-parse spry/testuser/update123`.text();
      expect(result.trim()).toBe(secondCommit);
    });

    test("force push overwrites divergent history", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const commit1 = await repo.commit();
      await pushBranch(commit1, "spry/testuser/force123", false, { cwd: repo.path });

      // Create a different commit (simulating a rebase)
      await $`git -C ${repo.path} reset --hard HEAD~1`.quiet();
      const commit2 = await repo.commit();

      // Force push should succeed
      await pushBranch(commit2, "spry/testuser/force123", true, { cwd: repo.path });

      const result = await $`git -C ${repo.originPath} rev-parse spry/testuser/force123`.text();
      expect(result.trim()).toBe(commit2);
    });
  });
});
