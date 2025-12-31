import { test, expect, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";
import { createGitFixture, type GitFixture } from "../../tests/helpers/git-fixture.ts";
import {
  injectMissingIds,
  allCommitsHaveIds,
  countCommitsMissingIds,
  rebaseOntoMain,
} from "./rebase.ts";
import { getStackCommitsWithTrailers } from "./commands.ts";

let fixture: GitFixture | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.cleanup();
    fixture = null;
  }
});

describe("git/rebase", () => {
  describe("injectMissingIds", () => {
    test("adds IDs to commits that don't have them", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-no-ids", { create: true });

      // Create commits without IDs
      await fixture.commit("First commit");
      await fixture.commit("Second commit");

      // Verify they don't have IDs
      const beforeCommits = await getStackCommitsWithTrailers({ cwd: fixture.path });
      expect(beforeCommits).toHaveLength(2);
      expect(beforeCommits[0]?.trailers["Taspr-Commit-Id"]).toBeUndefined();
      expect(beforeCommits[1]?.trailers["Taspr-Commit-Id"]).toBeUndefined();

      // Inject IDs
      const result = await injectMissingIds({ cwd: fixture.path });

      expect(result.modifiedCount).toBe(2);
      expect(result.rebasePerformed).toBe(true);

      // Verify they now have IDs
      const afterCommits = await getStackCommitsWithTrailers({ cwd: fixture.path });
      expect(afterCommits).toHaveLength(2);
      expect(afterCommits[0]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
      expect(afterCommits[1]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
    });

    test("preserves existing IDs", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-mixed", { create: true });

      // Create commits - one with ID, one without
      await fixture.commit("Has ID", { trailers: { "Taspr-Commit-Id": "existing1" } });
      await fixture.commit("No ID");

      const result = await injectMissingIds({ cwd: fixture.path });

      expect(result.modifiedCount).toBe(1);
      expect(result.rebasePerformed).toBe(true);

      const afterCommits = await getStackCommitsWithTrailers({ cwd: fixture.path });
      expect(afterCommits[0]?.trailers["Taspr-Commit-Id"]).toBe("existing1");
      expect(afterCommits[1]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
      expect(afterCommits[1]?.trailers["Taspr-Commit-Id"]).not.toBe("existing1");
    });

    test("no-op when all commits have IDs", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-all-ids", { create: true });

      await fixture.commit("Has ID 1", { trailers: { "Taspr-Commit-Id": "id111111" } });
      await fixture.commit("Has ID 2", { trailers: { "Taspr-Commit-Id": "id222222" } });

      const result = await injectMissingIds({ cwd: fixture.path });

      expect(result.modifiedCount).toBe(0);
      expect(result.rebasePerformed).toBe(false);

      // Verify IDs unchanged
      const commits = await getStackCommitsWithTrailers({ cwd: fixture.path });
      expect(commits[0]?.trailers["Taspr-Commit-Id"]).toBe("id111111");
      expect(commits[1]?.trailers["Taspr-Commit-Id"]).toBe("id222222");
    });

    test("no-op when stack is empty", async () => {
      fixture = await createGitFixture();
      // No commits beyond merge-base

      const result = await injectMissingIds({ cwd: fixture.path });

      expect(result.modifiedCount).toBe(0);
      expect(result.rebasePerformed).toBe(false);
    });
  });

  describe("allCommitsHaveIds", () => {
    test("returns true when all commits have IDs", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-check-all", { create: true });

      await fixture.commit("Commit 1", { trailers: { "Taspr-Commit-Id": "id111111" } });
      await fixture.commit("Commit 2", { trailers: { "Taspr-Commit-Id": "id222222" } });

      const result = await allCommitsHaveIds({ cwd: fixture.path });
      expect(result).toBe(true);
    });

    test("returns false when some commits missing IDs", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-check-some", { create: true });

      await fixture.commit("Has ID", { trailers: { "Taspr-Commit-Id": "id111111" } });
      await fixture.commit("No ID");

      const result = await allCommitsHaveIds({ cwd: fixture.path });
      expect(result).toBe(false);
    });

    test("returns true for empty stack", async () => {
      fixture = await createGitFixture();

      const result = await allCommitsHaveIds({ cwd: fixture.path });
      expect(result).toBe(true);
    });
  });

  describe("countCommitsMissingIds", () => {
    test("counts commits without IDs", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-count", { create: true });

      await fixture.commit("Has ID", { trailers: { "Taspr-Commit-Id": "id111111" } });
      await fixture.commit("No ID 1");
      await fixture.commit("No ID 2");

      const count = await countCommitsMissingIds({ cwd: fixture.path });
      expect(count).toBe(2);
    });

    test("returns 0 when all have IDs", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-count-all", { create: true });

      await fixture.commit("Has ID", { trailers: { "Taspr-Commit-Id": "id111111" } });

      const count = await countCommitsMissingIds({ cwd: fixture.path });
      expect(count).toBe(0);
    });
  });

  describe("rebaseOntoMain", () => {
    test("successfully rebases stack onto updated main", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-rebase", { create: true });
      await fixture.commit("Feature commit 1", { trailers: { "Taspr-Commit-Id": "feat0001" } });
      await fixture.commit("Feature commit 2", { trailers: { "Taspr-Commit-Id": "feat0002" } });

      // Push commits to origin/main (simulating other developer's work)
      const tempWorktree = `${fixture.originPath}-worktree`;
      await $`git clone ${fixture.originPath} ${tempWorktree}`.quiet();
      await $`git -C ${tempWorktree} config user.email "other@example.com"`.quiet();
      await $`git -C ${tempWorktree} config user.name "Other User"`.quiet();
      await Bun.write(join(tempWorktree, "main-update.txt"), "Main content\n");
      await $`git -C ${tempWorktree} add .`.quiet();
      await $`git -C ${tempWorktree} commit -m "Update on main"`.quiet();
      await $`git -C ${tempWorktree} push origin main`.quiet();
      await $`rm -rf ${tempWorktree}`.quiet();

      // Fetch to get the new main
      await $`git -C ${fixture.path} fetch origin`.quiet();

      // Rebase onto main
      const result = await rebaseOntoMain({ cwd: fixture.path });

      expect(result.success).toBe(true);
      expect(result.commitCount).toBe(2);
      expect(result.conflictFile).toBeUndefined();
    });

    test("preserves Taspr trailers through rebase", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-trailers", { create: true });
      await fixture.commit("Feature commit", { trailers: { "Taspr-Commit-Id": "preserve1" } });

      // Push commit to origin/main
      const tempWorktree = `${fixture.originPath}-worktree`;
      await $`git clone ${fixture.originPath} ${tempWorktree}`.quiet();
      await $`git -C ${tempWorktree} config user.email "other@example.com"`.quiet();
      await $`git -C ${tempWorktree} config user.name "Other User"`.quiet();
      await Bun.write(join(tempWorktree, "main-file.txt"), "Main content\n");
      await $`git -C ${tempWorktree} add .`.quiet();
      await $`git -C ${tempWorktree} commit -m "Main commit"`.quiet();
      await $`git -C ${tempWorktree} push origin main`.quiet();
      await $`rm -rf ${tempWorktree}`.quiet();

      await $`git -C ${fixture.path} fetch origin`.quiet();

      const result = await rebaseOntoMain({ cwd: fixture.path });
      expect(result.success).toBe(true);

      // Verify trailer was preserved
      const commits = await getStackCommitsWithTrailers({ cwd: fixture.path });
      expect(commits).toHaveLength(1);
      expect(commits[0]?.trailers["Taspr-Commit-Id"]).toBe("preserve1");
    });

    test("detects conflict and returns conflict file", async () => {
      fixture = await createGitFixture();

      // Create a file that will conflict
      const conflictFile = "conflict.txt";
      await Bun.write(join(fixture.path, conflictFile), "Original content\n");
      await $`git -C ${fixture.path} add .`.quiet();
      await $`git -C ${fixture.path} commit -m "Add conflict file"`.quiet();
      await $`git -C ${fixture.path} push origin main`.quiet();

      // Create feature branch and modify the file
      await fixture.checkout("feature-conflict", { create: true });
      await Bun.write(join(fixture.path, conflictFile), "Feature content\n");
      await $`git -C ${fixture.path} add .`.quiet();
      await $`git -C ${fixture.path} commit -m "Feature change"`.quiet();

      // Update main with conflicting change
      const tempWorktree = `${fixture.originPath}-worktree`;
      await $`git clone ${fixture.originPath} ${tempWorktree}`.quiet();
      await $`git -C ${tempWorktree} config user.email "other@example.com"`.quiet();
      await $`git -C ${tempWorktree} config user.name "Other User"`.quiet();
      await Bun.write(join(tempWorktree, conflictFile), "Main content\n");
      await $`git -C ${tempWorktree} add .`.quiet();
      await $`git -C ${tempWorktree} commit -m "Main change"`.quiet();
      await $`git -C ${tempWorktree} push origin main`.quiet();
      await $`rm -rf ${tempWorktree}`.quiet();

      await $`git -C ${fixture.path} fetch origin`.quiet();

      // Rebase should detect conflict
      const result = await rebaseOntoMain({ cwd: fixture.path });

      expect(result.success).toBe(false);
      expect(result.conflictFile).toBe(conflictFile);

      // Clean up the rebase state
      await $`git -C ${fixture.path} rebase --abort`.quiet().nothrow();
    });

    test("no-op when already up to date", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-uptodate", { create: true });
      await fixture.commit("Feature commit", { trailers: { "Taspr-Commit-Id": "uptodate1" } });

      // No changes to main, just fetch
      await $`git -C ${fixture.path} fetch origin`.quiet();

      const result = await rebaseOntoMain({ cwd: fixture.path });

      expect(result.success).toBe(true);
      expect(result.commitCount).toBe(1);
    });
  });
});
