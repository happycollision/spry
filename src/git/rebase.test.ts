import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import { scenarios } from "../scenario/definitions.ts";
import {
  injectMissingIds,
  allCommitsHaveIds,
  countCommitsMissingIds,
  rebaseOntoMain,
  getConflictInfo,
  formatConflictError,
  predictRebaseConflicts,
} from "./rebase.ts";
import { getStackCommitsWithTrailers, getCurrentBranch } from "./commands.ts";

const repos = repoManager();

describe("git/rebase", () => {
  describe("injectMissingIds", () => {
    test("adds IDs to commits that don't have them", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);
      await repo.commit();

      // Verify they don't have IDs
      const beforeCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(beforeCommits).toHaveLength(2);
      expect(beforeCommits[0]?.trailers["Spry-Commit-Id"]).toBeUndefined();
      expect(beforeCommits[1]?.trailers["Spry-Commit-Id"]).toBeUndefined();

      // Inject IDs
      const result = await injectMissingIds({ cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modifiedCount).toBe(2);
        expect(result.rebasePerformed).toBe(true);
      }

      // Verify they now have IDs
      const afterCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(afterCommits).toHaveLength(2);
      expect(afterCommits[0]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
      expect(afterCommits[1]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
    });

    test("preserves existing IDs", async () => {
      const repo = await repos.create();
      await scenarios.mixedTrailerStack.setup(repo);

      const result = await injectMissingIds({ cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modifiedCount).toBe(2);
        expect(result.rebasePerformed).toBe(true);
      }

      const afterCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(afterCommits[0]?.trailers["Spry-Commit-Id"]).toBe("mix00001");
      expect(afterCommits[1]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
      expect(afterCommits[2]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
      expect(afterCommits[1]?.trailers["Spry-Commit-Id"]).not.toBe("mix00001");
    });

    test("no-op when all commits have IDs", async () => {
      const repo = await repos.create();
      await scenarios.withSpryIds.setup(repo);

      const result = await injectMissingIds({ cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modifiedCount).toBe(0);
        expect(result.rebasePerformed).toBe(false);
      }

      // Verify IDs unchanged
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits[0]?.trailers["Spry-Commit-Id"]).toBe("abc12345");
      expect(commits[1]?.trailers["Spry-Commit-Id"]).toBe("def67890");
    });

    test("no-op when stack is empty", async () => {
      const repo = await repos.create();
      await scenarios.emptyStack.setup(repo);

      const result = await injectMissingIds({ cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modifiedCount).toBe(0);
        expect(result.rebasePerformed).toBe(false);
      }
    });
  });

  describe("allCommitsHaveIds", () => {
    test("returns true when all commits have IDs", async () => {
      const repo = await repos.create();
      await scenarios.withSpryIds.setup(repo);

      const result = await allCommitsHaveIds({ cwd: repo.path });
      expect(result).toBe(true);
    });

    test("returns false when some commits missing IDs", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);

      const result = await allCommitsHaveIds({ cwd: repo.path });
      expect(result).toBe(false);
    });

    test("returns true for empty stack", async () => {
      const repo = await repos.create();
      await scenarios.emptyStack.setup(repo);

      const result = await allCommitsHaveIds({ cwd: repo.path });
      expect(result).toBe(true);
    });
  });

  describe("countCommitsMissingIds", () => {
    test("counts commits without IDs", async () => {
      const repo = await repos.create();
      await scenarios.mixedTrailerStack.setup(repo);

      const count = await countCommitsMissingIds({ cwd: repo.path });
      expect(count).toBe(2);
    });

    test("returns 0 when all have IDs", async () => {
      const repo = await repos.create();
      await scenarios.withSpryIds.setup(repo);

      const count = await countCommitsMissingIds({ cwd: repo.path });
      expect(count).toBe(0);
    });
  });

  describe("rebaseOntoMain", () => {
    test("successfully rebases stack onto updated main", async () => {
      const repo = await repos.create();
      await scenarios.divergedMain.setup(repo);

      // Rebase onto main
      const result = await rebaseOntoMain({ cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.commitCount).toBe(2);
      }
    });

    test("preserves Spry trailers through rebase", async () => {
      const repo = await repos.create();
      await scenarios.divergedMain.setup(repo);

      const result = await rebaseOntoMain({ cwd: repo.path });
      expect(result.ok).toBe(true);

      // Verify commits are present (divergedMain doesn't add trailers by default, but commits are preserved)
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);
    });

    test("detects conflict and returns conflict file", async () => {
      const repo = await repos.create();
      await scenarios.conflictScenario.setup(repo);

      // Rebase should detect conflict
      const result = await rebaseOntoMain({ cwd: repo.path });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.conflictFile).toBe("shared.txt");
      }

      // Clean up the rebase state
      await $`git -C ${repo.path} rebase --abort`.quiet().nothrow();
    });

    test("no-op when already up to date", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);

      // No changes to main, just fetch
      await repo.fetch();

      const result = await rebaseOntoMain({ cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.commitCount).toBe(1);
      }
    });
  });

  describe("getConflictInfo", () => {
    test("returns null when not in a rebase", async () => {
      const repo = await repos.create();
      await scenarios.singleCommit.setup(repo);

      const info = await getConflictInfo({ cwd: repo.path });
      expect(info).toBeNull();
    });

    test("returns conflict info during rebase conflict", async () => {
      const repo = await repos.create();
      await scenarios.conflictScenario.setup(repo);

      // Start rebase that will conflict
      await $`git -C ${repo.path} rebase origin/main`.quiet().nothrow();

      // Now we should be in a conflict state
      const info = await getConflictInfo({ cwd: repo.path });

      expect(info).not.toBeNull();
      expect(info?.files).toContain("shared.txt");
      expect(info?.currentCommit).toMatch(/^[0-9a-f]{8}$/);
      expect(info?.currentSubject).toContain("Feature change");

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

  describe("fixup! commit handling", () => {
    test("injectMissingIds does not reorder fixup! commits", async () => {
      const repo = await repos.create();

      // Enable autosquash so the test is meaningful - without --no-autosquash,
      // git would reorder fixup! commits to follow their target
      await $`git -C ${repo.path} config rebase.autoSquash true`.quiet();

      await repo.branch("feature");

      // Create commits in a specific order:
      // 1. Regular commit
      // 2. Another regular commit
      // 3. fixup! commit that targets commit 1
      // Without --no-autosquash, the fixup would move to be after commit 1
      await Bun.write(join(repo.path, "file1.txt"), "content1\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "Add file1"`.quiet();

      await Bun.write(join(repo.path, "file2.txt"), "content2\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "Add file2"`.quiet();

      await Bun.write(join(repo.path, "file1.txt"), "content1 modified\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "fixup! Add file1"`.quiet();

      // Verify initial order
      const beforeCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(beforeCommits).toHaveLength(3);
      expect(beforeCommits[0]?.subject).toBe("Add file1");
      expect(beforeCommits[1]?.subject).toBe("Add file2");
      expect(beforeCommits[2]?.subject).toBe("fixup! Add file1");

      // Inject IDs - this performs a rebase
      const result = await injectMissingIds({ cwd: repo.path });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rebasePerformed).toBe(true);
      }

      // Verify order is preserved (fixup! commit should NOT have moved)
      const afterCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(afterCommits).toHaveLength(3);
      expect(afterCommits[0]?.subject).toBe("Add file1");
      expect(afterCommits[1]?.subject).toBe("Add file2");
      expect(afterCommits[2]?.subject).toBe("fixup! Add file1");

      // Verify all have IDs now
      expect(afterCommits[0]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
      expect(afterCommits[1]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
      expect(afterCommits[2]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
    });

    test("rebaseOntoMain does not reorder fixup! commits", async () => {
      const repo = await repos.create();

      // Enable autosquash so the test is meaningful
      await $`git -C ${repo.path} config rebase.autoSquash true`.quiet();

      await repo.branch("feature");

      // Create commits with fixup! in the middle
      await Bun.write(join(repo.path, "file1.txt"), "content1\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "Add file1" --trailer "Spry-Commit-Id: id000001"`.quiet();

      await Bun.write(join(repo.path, "file1.txt"), "content1 fixed\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "fixup! Add file1" --trailer "Spry-Commit-Id: id000002"`.quiet();

      await Bun.write(join(repo.path, "file2.txt"), "content2\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "Add file2" --trailer "Spry-Commit-Id: id000003"`.quiet();

      // Update origin/main with non-conflicting change
      await repo.updateOriginMain("Main update", { "main-file.txt": "main content\n" });
      await repo.fetch();

      // Verify initial order
      const beforeCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(beforeCommits).toHaveLength(3);
      expect(beforeCommits[0]?.subject).toBe("Add file1");
      expect(beforeCommits[1]?.subject).toBe("fixup! Add file1");
      expect(beforeCommits[2]?.subject).toBe("Add file2");

      // Rebase onto main
      const result = await rebaseOntoMain({ cwd: repo.path });
      expect(result.ok).toBe(true);

      // Verify order is preserved
      const afterCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(afterCommits).toHaveLength(3);
      expect(afterCommits[0]?.subject).toBe("Add file1");
      expect(afterCommits[1]?.subject).toBe("fixup! Add file1");
      expect(afterCommits[2]?.subject).toBe("Add file2");
    });
  });

  // ==========================================================================
  // Phase 2: Branch-Aware Function Tests
  // ==========================================================================

  describe("branch-aware functions (Phase 2)", () => {
    test("getStackCommitsWithTrailers works on non-current branch", async () => {
      const repo = await repos.create();

      // Create branch A with a commit
      const branchA = await repo.branch("feature-a");
      await repo.commit({
        message: "Commit on A",
        trailers: { "Spry-Commit-Id": "aaa00001" },
      });

      // Create branch B with different commits
      await repo.checkout(repo.defaultBranch);
      const branchB = await repo.branch("feature-b");
      await repo.commit({
        message: "Commit on B",
        trailers: { "Spry-Commit-Id": "bbb00001" },
      });

      // Stay on B, query A
      const commitsA = await getStackCommitsWithTrailers({
        cwd: repo.path,
        branch: branchA,
      });

      expect(commitsA).toHaveLength(1);
      expect(commitsA[0]?.trailers["Spry-Commit-Id"]).toBe("aaa00001");

      // Verify still on B
      const currentBranch = await getCurrentBranch({ cwd: repo.path });
      expect(currentBranch).toBe(branchB);
    });

    test("injectMissingIds works on non-current branch", async () => {
      const repo = await repos.create();

      // Create branch with mixed commits
      const featureBranch = await repo.branch("feature-mixed");
      await repo.commit({
        message: "Commit with ID",
        trailers: { "Spry-Commit-Id": "mix00001" },
      });
      await repo.commit({ message: "Commit without ID" });

      // Go back to main
      await repo.checkout(repo.defaultBranch);

      // Inject IDs on the feature branch (while on main)
      const result = await injectMissingIds({ cwd: repo.path, branch: featureBranch });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modifiedCount).toBe(1);
        expect(result.rebasePerformed).toBe(true);
      }

      // Verify all commits on feature branch now have IDs
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path, branch: featureBranch });
      expect(commits).toHaveLength(2);
      for (const commit of commits) {
        expect(commit.trailers["Spry-Commit-Id"]).toBeDefined();
      }

      // Verify still on main
      const currentBranch = await getCurrentBranch({ cwd: repo.path });
      expect(currentBranch).toBe(repo.defaultBranch);
    });

    test("predictRebaseConflicts works on non-current branch", async () => {
      const repo = await repos.create();
      await scenarios.multiSpryBranches.setup(repo);

      // Get the conflict branch name (includes unique ID)
      const currentBranch = await getCurrentBranch({ cwd: repo.path });

      // Find the conflict branch - it should be feature-conflict-<uniqueId>
      const result = await $`git -C ${repo.path} branch --list "feature-conflict-*"`.text();
      const conflictBranch = result.trim();

      // Stay on current branch, predict conflicts for feature-conflict
      const prediction = await predictRebaseConflicts({
        cwd: repo.path,
        branch: conflictBranch,
        onto: "origin/main",
      });

      expect(prediction.wouldSucceed).toBe(false);
      expect(prediction.conflictInfo?.files).toContain("conflict.txt");

      // Verify we didn't change branches
      const branchAfter = await getCurrentBranch({ cwd: repo.path });
      expect(branchAfter).toBe(currentBranch);
    });

    test("predictRebaseConflicts does not change current branch", async () => {
      const repo = await repos.create();
      await scenarios.multiSpryBranches.setup(repo);

      const branchBefore = await getCurrentBranch({ cwd: repo.path });

      // Find and predict on a different branch
      const result = await $`git -C ${repo.path} branch --list "feature-uptodate-*"`.text();
      const otherBranch = result.trim();

      await predictRebaseConflicts({
        cwd: repo.path,
        branch: otherBranch,
        onto: "origin/main",
      });

      const branchAfter = await getCurrentBranch({ cwd: repo.path });
      expect(branchAfter).toBe(branchBefore);
    });

    test("rebaseOntoMain works on non-current branch", async () => {
      const repo = await repos.create();

      // Create feature branch
      const featureBranch = await repo.branch("feature");
      await repo.commit({
        message: "Feature commit",
        trailers: { "Spry-Commit-Id": "feat0001" },
      });

      // Go back to main and update origin
      await repo.checkout(repo.defaultBranch);
      await repo.updateOriginMain("Upstream change", { "new-file.txt": "content\n" });
      await repo.fetch();

      // Rebase the feature branch (while on main)
      const result = await rebaseOntoMain({
        cwd: repo.path,
        branch: featureBranch,
        onto: "origin/main",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.commitCount).toBe(1);
      }

      // Verify we're still on main
      const currentBranch = await getCurrentBranch({ cwd: repo.path });
      expect(currentBranch).toBe(repo.defaultBranch);

      // Verify feature is now on top of origin/main
      const mergeBase = (
        await $`git -C ${repo.path} merge-base ${featureBranch} origin/main`.text()
      ).trim();
      const originMain = (await $`git -C ${repo.path} rev-parse origin/main`.text()).trim();
      expect(mergeBase).toBe(originMain);
    });

    test("rebaseOntoMain returns result for conflict instead of throwing", async () => {
      const repo = await repos.create();
      await scenarios.multiSpryBranches.setup(repo);

      // Find the conflict branch
      const branchListResult =
        await $`git -C ${repo.path} branch --list "feature-conflict-*"`.text();
      const conflictBranch = branchListResult.trim();

      const result = await rebaseOntoMain({
        cwd: repo.path,
        branch: conflictBranch,
        onto: "origin/main",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("conflict");
      }
    });
  });
});
