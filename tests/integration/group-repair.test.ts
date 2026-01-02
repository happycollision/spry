import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import {
  addGroupEnd,
  removeGroupStart,
  addGroupStart,
  removeGroupEnd,
} from "../../src/git/group-rebase.ts";
import { getStackCommitsWithTrailers } from "../../src/git/commands.ts";
import { parseStack } from "../../src/core/stack.ts";

/**
 * Get commit trailers for verification.
 */
async function getCommitTrailers(cwd: string, count: number): Promise<string> {
  return await $`git -C ${cwd} log --format=%s%n%b--- HEAD~${count}..HEAD`.text();
}

describe("targeted group repair functions", () => {
  const repos = repoManager();

  describe("addGroupEnd", () => {
    test("adds Taspr-Group-End to close an unclosed group", async () => {
      const repo = await repos.create();
      await scenarios.unclosedGroup.setup(repo);

      // Get commits and find the group info
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const lastCommit = commits[commits.length - 1];
      expect(lastCommit).toBeDefined();

      // Find the group ID from the start commit
      const startCommit = commits.find((c) => c.trailers["Taspr-Group-Start"]);
      expect(startCommit).toBeDefined();
      const groupId = startCommit!.trailers["Taspr-Group-Start"];
      expect(groupId).toBeDefined();

      // Add group end to the last commit
      const result = await addGroupEnd(lastCommit!.hash, groupId!, { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify the group is now closed
      const afterTrailers = await getCommitTrailers(repo.path, 2);
      expect(afterTrailers).toContain(`Taspr-Group-End: ${groupId}`);

      // Verify stack is now valid
      const newCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const validation = parseStack(newCommits);
      expect(validation.ok).toBe(true);
    });
  });

  describe("removeGroupStart", () => {
    test("removes Taspr-Group-Start and Title from an unclosed group", async () => {
      const repo = await repos.create();
      await scenarios.unclosedGroup.setup(repo);

      // Get commits and find the group info
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const startCommit = commits.find((c) => c.trailers["Taspr-Group-Start"]);
      expect(startCommit).toBeDefined();
      const groupId = startCommit!.trailers["Taspr-Group-Start"];
      expect(groupId).toBeDefined();

      // Remove the group start
      const result = await removeGroupStart(startCommit!.hash, groupId!, { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify group trailers are removed
      const afterTrailers = await getCommitTrailers(repo.path, 2);
      expect(afterTrailers).not.toContain("Taspr-Group-Start");
      expect(afterTrailers).not.toContain("Taspr-Group-Title");
      // Commit IDs should still be there
      expect(afterTrailers).toContain("Taspr-Commit-Id");

      // Verify stack is now valid
      const newCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const validation = parseStack(newCommits);
      expect(validation.ok).toBe(true);
    });
  });

  describe("addGroupStart", () => {
    test("adds Taspr-Group-Start to fix an orphan group end", async () => {
      const repo = await repos.create();
      await scenarios.orphanGroupEnd.setup(repo);

      // Get commits and find the orphan end
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const endCommit = commits.find((c) => c.trailers["Taspr-Group-End"]);
      expect(endCommit).toBeDefined();
      const groupId = endCommit!.trailers["Taspr-Group-End"];
      expect(groupId).toBeDefined();

      // Pick the first commit to be the start
      const firstCommit = commits[0];
      expect(firstCommit).toBeDefined();

      // Add group start to the first commit
      const result = await addGroupStart(firstCommit!.hash, groupId!, "Fixed Group", {
        cwd: repo.path,
      });
      expect(result.success).toBe(true);

      // Verify the group start was added
      const afterTrailers = await getCommitTrailers(repo.path, 3);
      expect(afterTrailers).toContain(`Taspr-Group-Start: ${groupId}`);
      expect(afterTrailers).toContain("Taspr-Group-Title: Fixed Group");

      // Verify stack is now valid
      const newCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const validation = parseStack(newCommits);
      expect(validation.ok).toBe(true);
    });
  });

  describe("removeGroupEnd", () => {
    test("removes orphan Taspr-Group-End", async () => {
      const repo = await repos.create();
      await scenarios.orphanGroupEnd.setup(repo);

      // Get commits and find the orphan end
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const endCommit = commits.find((c) => c.trailers["Taspr-Group-End"]);
      expect(endCommit).toBeDefined();
      const groupId = endCommit!.trailers["Taspr-Group-End"];
      expect(groupId).toBeDefined();

      // Remove the orphan group end
      const result = await removeGroupEnd(endCommit!.hash, groupId!, { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify the group end was removed
      const afterTrailers = await getCommitTrailers(repo.path, 3);
      expect(afterTrailers).not.toContain("Taspr-Group-End");
      // Commit IDs should still be there
      expect(afterTrailers).toContain("Taspr-Commit-Id");

      // Verify stack is now valid
      const newCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const validation = parseStack(newCommits);
      expect(validation.ok).toBe(true);
    });
  });
});
