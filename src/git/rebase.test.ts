import { test, expect, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import {
  injectMissingIds,
  allCommitsHaveIds,
  countCommitsMissingIds,
  rebaseOntoMain,
  getConflictInfo,
  formatConflictError,
} from "./rebase.ts";
import { getStackCommitsWithTrailers } from "./commands.ts";

const repos = repoManager();
afterEach(() => repos.cleanup());

describe("git/rebase", () => {
  describe("injectMissingIds", () => {
    test("adds IDs to commits that don't have them", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      // Create commits without IDs
      await repo.commit("First commit");
      await repo.commit("Second commit");

      // Verify they don't have IDs
      const beforeCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(beforeCommits).toHaveLength(2);
      expect(beforeCommits[0]?.trailers["Taspr-Commit-Id"]).toBeUndefined();
      expect(beforeCommits[1]?.trailers["Taspr-Commit-Id"]).toBeUndefined();

      // Inject IDs
      const result = await injectMissingIds({ cwd: repo.path });

      expect(result.modifiedCount).toBe(2);
      expect(result.rebasePerformed).toBe(true);

      // Verify they now have IDs
      const afterCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(afterCommits).toHaveLength(2);
      expect(afterCommits[0]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
      expect(afterCommits[1]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
    });

    test("preserves existing IDs", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      // Create commits - one with ID, one without
      await repo.commit("Has ID", { trailers: { "Taspr-Commit-Id": "existing1" } });
      await repo.commit("No ID");

      const result = await injectMissingIds({ cwd: repo.path });

      expect(result.modifiedCount).toBe(1);
      expect(result.rebasePerformed).toBe(true);

      const afterCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(afterCommits[0]?.trailers["Taspr-Commit-Id"]).toBe("existing1");
      expect(afterCommits[1]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
      expect(afterCommits[1]?.trailers["Taspr-Commit-Id"]).not.toBe("existing1");
    });

    test("no-op when all commits have IDs", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      await repo.commit("Has ID 1", { trailers: { "Taspr-Commit-Id": "id111111" } });
      await repo.commit("Has ID 2", { trailers: { "Taspr-Commit-Id": "id222222" } });

      const result = await injectMissingIds({ cwd: repo.path });

      expect(result.modifiedCount).toBe(0);
      expect(result.rebasePerformed).toBe(false);

      // Verify IDs unchanged
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits[0]?.trailers["Taspr-Commit-Id"]).toBe("id111111");
      expect(commits[1]?.trailers["Taspr-Commit-Id"]).toBe("id222222");
    });

    test("no-op when stack is empty", async () => {
      const repo = await repos.create();
      // No commits beyond merge-base

      const result = await injectMissingIds({ cwd: repo.path });

      expect(result.modifiedCount).toBe(0);
      expect(result.rebasePerformed).toBe(false);
    });
  });

  describe("allCommitsHaveIds", () => {
    test("returns true when all commits have IDs", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      await repo.commit("Commit 1", { trailers: { "Taspr-Commit-Id": "id111111" } });
      await repo.commit("Commit 2", { trailers: { "Taspr-Commit-Id": "id222222" } });

      const result = await allCommitsHaveIds({ cwd: repo.path });
      expect(result).toBe(true);
    });

    test("returns false when some commits missing IDs", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      await repo.commit("Has ID", { trailers: { "Taspr-Commit-Id": "id111111" } });
      await repo.commit("No ID");

      const result = await allCommitsHaveIds({ cwd: repo.path });
      expect(result).toBe(false);
    });

    test("returns true for empty stack", async () => {
      const repo = await repos.create();

      const result = await allCommitsHaveIds({ cwd: repo.path });
      expect(result).toBe(true);
    });
  });

  describe("countCommitsMissingIds", () => {
    test("counts commits without IDs", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      await repo.commit("Has ID", { trailers: { "Taspr-Commit-Id": "id111111" } });
      await repo.commit("No ID 1");
      await repo.commit("No ID 2");

      const count = await countCommitsMissingIds({ cwd: repo.path });
      expect(count).toBe(2);
    });

    test("returns 0 when all have IDs", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      await repo.commit("Has ID", { trailers: { "Taspr-Commit-Id": "id111111" } });

      const count = await countCommitsMissingIds({ cwd: repo.path });
      expect(count).toBe(0);
    });
  });

  describe("rebaseOntoMain", () => {
    test("successfully rebases stack onto updated main", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Feature commit 1", { trailers: { "Taspr-Commit-Id": "feat0001" } });
      await repo.commit("Feature commit 2", { trailers: { "Taspr-Commit-Id": "feat0002" } });

      // Update origin/main (simulating other developer's work)
      await repo.updateOriginMain("Update on main");
      await repo.fetch();

      // Rebase onto main
      const result = await rebaseOntoMain({ cwd: repo.path });

      expect(result.success).toBe(true);
      expect(result.commitCount).toBe(2);
      expect(result.conflictFile).toBeUndefined();
    });

    test("preserves Taspr trailers through rebase", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Feature commit", { trailers: { "Taspr-Commit-Id": "preserve1" } });

      // Update origin/main
      await repo.updateOriginMain("Main commit");
      await repo.fetch();

      const result = await rebaseOntoMain({ cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify trailer was preserved
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(1);
      expect(commits[0]?.trailers["Taspr-Commit-Id"]).toBe("preserve1");
    });

    test("detects conflict and returns conflict file", async () => {
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
      await repo.fetch();

      // Rebase should detect conflict
      const result = await rebaseOntoMain({ cwd: repo.path });

      expect(result.success).toBe(false);
      expect(result.conflictFile).toBe(conflictFile);

      // Clean up the rebase state
      await $`git -C ${repo.path} rebase --abort`.quiet().nothrow();
    });

    test("no-op when already up to date", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Feature commit", { trailers: { "Taspr-Commit-Id": "uptodate1" } });

      // No changes to main, just fetch
      await repo.fetch();

      const result = await rebaseOntoMain({ cwd: repo.path });

      expect(result.success).toBe(true);
      expect(result.commitCount).toBe(1);
    });
  });

  describe("getConflictInfo", () => {
    test("returns null when not in a rebase", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Normal commit");

      const info = await getConflictInfo({ cwd: repo.path });
      expect(info).toBeNull();
    });

    test("returns conflict info during rebase conflict", async () => {
      const repo = await repos.create();

      // Create a file that will conflict
      const conflictFile = "conflict-info.txt";
      await Bun.write(join(repo.path, conflictFile), "Original content\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "Add conflict file"`.quiet();
      await $`git -C ${repo.path} push origin main`.quiet();

      // Create feature branch and modify the file
      await repo.branch("feature");
      await Bun.write(join(repo.path, conflictFile), "Feature content\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "Feature modification"`.quiet();

      // Update main with conflicting change
      await repo.updateOriginMain("Main modification", { [conflictFile]: "Main content\n" });
      await repo.fetch();

      // Start rebase that will conflict
      await $`git -C ${repo.path} rebase origin/main`.quiet().nothrow();

      // Now we should be in a conflict state
      const info = await getConflictInfo({ cwd: repo.path });

      expect(info).not.toBeNull();
      expect(info?.files).toContain(conflictFile);
      expect(info?.currentCommit).toMatch(/^[0-9a-f]{8}$/);
      expect(info?.currentSubject).toBe("Feature modification");

      // Clean up
      await $`git -C ${repo.path} rebase --abort`.quiet().nothrow();
    });

    test("lists multiple conflicting files", async () => {
      const repo = await repos.create();

      // Create files that will conflict
      await Bun.write(join(repo.path, "file1.txt"), "Original 1\n");
      await Bun.write(join(repo.path, "file2.txt"), "Original 2\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "Add files"`.quiet();
      await $`git -C ${repo.path} push origin main`.quiet();

      // Create feature branch and modify both files
      await repo.branch("feature");
      await Bun.write(join(repo.path, "file1.txt"), "Feature 1\n");
      await Bun.write(join(repo.path, "file2.txt"), "Feature 2\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "Modify both files"`.quiet();

      // Update main with conflicting changes
      await repo.updateOriginMain("Main changes", {
        "file1.txt": "Main 1\n",
        "file2.txt": "Main 2\n",
      });
      await repo.fetch();
      await $`git -C ${repo.path} rebase origin/main`.quiet().nothrow();

      const info = await getConflictInfo({ cwd: repo.path });

      expect(info).not.toBeNull();
      expect(info?.files).toHaveLength(2);
      expect(info?.files).toContain("file1.txt");
      expect(info?.files).toContain("file2.txt");

      // Clean up
      await $`git -C ${repo.path} rebase --abort`.quiet().nothrow();
    });
  });

  describe("formatConflictError", () => {
    test("formats conflict info into readable error message", () => {
      const info = {
        files: ["src/auth.ts", "src/config.ts"],
        currentCommit: "abc12345",
        currentSubject: "Add authentication",
      };

      const message = formatConflictError(info);

      expect(message).toContain("abc12345");
      expect(message).toContain("Add authentication");
      expect(message).toContain("src/auth.ts");
      expect(message).toContain("src/config.ts");
      expect(message).toContain("git add");
      expect(message).toContain("git rebase --continue");
      expect(message).toContain("git rebase --abort");
    });
  });
});
