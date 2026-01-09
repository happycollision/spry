import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import { scenarios } from "../scenario/definitions.ts";
import {
  checkGitVersion,
  getTree,
  getParents,
  getParent,
  getAuthorEnv,
  getAuthorAndCommitterEnv,
  getCommitMessage,
  createCommit,
  mergeTree,
  updateRef,
  resetToCommit,
  getShortSha,
  getFullSha,
  rewriteCommitMessage,
  rewriteCommitChain,
  rebasePlumbing,
  finalizeRewrite,
} from "./plumbing.ts";
import { join } from "node:path";

const repos = repoManager();

describe("git/plumbing", () => {
  describe("checkGitVersion", () => {
    test("returns ok:true for current git version", async () => {
      const result = await checkGitVersion();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
      }
    });
  });

  describe("getTree", () => {
    test("returns tree SHA from commit", async () => {
      const repo = await repos.create();

      const head = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();
      const tree = await getTree(head, { cwd: repo.path });

      expect(tree).toMatch(/^[a-f0-9]{40}$/);
    });

    test("works with HEAD reference", async () => {
      const repo = await repos.create();

      const tree = await getTree("HEAD", { cwd: repo.path });

      expect(tree).toMatch(/^[a-f0-9]{40}$/);
    });
  });

  describe("getParents", () => {
    test("returns single parent for normal commit", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash = await repo.commit();

      const parents = await getParents(hash, { cwd: repo.path });

      expect(parents).toHaveLength(1);
      expect(parents[0]).toMatch(/^[a-f0-9]{40}$/);
    });

    test("returns empty array for root commit", async () => {
      const repo = await repos.create();

      // Get the very first commit in the repo
      const rootCommit = (await $`git -C ${repo.path} rev-list --max-parents=0 HEAD`.text()).trim();

      const parents = await getParents(rootCommit, { cwd: repo.path });

      expect(parents).toHaveLength(0);
    });
  });

  describe("getParent", () => {
    test("returns first parent", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash = await repo.commit();
      const expectedParent = (await $`git -C ${repo.path} rev-parse ${hash}^`.text()).trim();

      const parent = await getParent(hash, { cwd: repo.path });

      expect(parent).toBe(expectedParent);
    });
  });

  describe("getAuthorEnv", () => {
    test("returns author information", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash = await repo.commit();

      const env = await getAuthorEnv(hash, { cwd: repo.path });

      expect(env.GIT_AUTHOR_NAME).toBeDefined();
      expect(env.GIT_AUTHOR_EMAIL).toBeDefined();
      expect(env.GIT_AUTHOR_DATE).toBeDefined();
      expect(Object.keys(env)).toHaveLength(3);
    });
  });

  describe("getAuthorAndCommitterEnv", () => {
    test("returns both author and committer information", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash = await repo.commit();

      const env = await getAuthorAndCommitterEnv(hash, { cwd: repo.path });

      expect(env.GIT_AUTHOR_NAME).toBeDefined();
      expect(env.GIT_AUTHOR_EMAIL).toBeDefined();
      expect(env.GIT_AUTHOR_DATE).toBeDefined();
      expect(env.GIT_COMMITTER_NAME).toBeDefined();
      expect(env.GIT_COMMITTER_EMAIL).toBeDefined();
      expect(env.GIT_COMMITTER_DATE).toBeDefined();
      expect(Object.keys(env)).toHaveLength(6);
    });
  });

  describe("getCommitMessage", () => {
    test("returns full commit message", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash = await repo.commit({ message: "Test message" });

      const message = await getCommitMessage(hash, { cwd: repo.path });

      expect(message).toContain("Test message");
    });

    test("includes trailers in message", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash = await repo.commit({
        message: "Test with trailers",
        trailers: {
          "Spry-Commit-Id": "abc12345",
        },
      });

      const message = await getCommitMessage(hash, { cwd: repo.path });

      expect(message).toContain("Test with trailers");
      expect(message).toContain("Spry-Commit-Id: abc12345");
    });
  });

  describe("createCommit", () => {
    test("creates a new commit with same tree (message-only rewrite)", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const originalHash = await repo.commit({ message: "Original" });

      // Get the original commit's data
      const tree = await getTree(originalHash, { cwd: repo.path });
      const parents = await getParents(originalHash, { cwd: repo.path });
      const env = await getAuthorAndCommitterEnv(originalHash, {
        cwd: repo.path,
      });

      // Create new commit with different message but same tree
      const newHash = await createCommit(tree, parents, "Rewritten message", env, {
        cwd: repo.path,
      });

      expect(newHash).toMatch(/^[a-f0-9]{40}$/);
      expect(newHash).not.toBe(originalHash);

      // Verify the new commit has the same tree
      const newTree = await getTree(newHash, { cwd: repo.path });
      expect(newTree).toBe(tree);

      // Verify the message was changed
      const newMessage = await getCommitMessage(newHash, { cwd: repo.path });
      expect(newMessage).toBe("Rewritten message");
    });

    test("preserves author and committer info", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const originalHash = await repo.commit();

      const tree = await getTree(originalHash, { cwd: repo.path });
      const parents = await getParents(originalHash, { cwd: repo.path });
      const env = await getAuthorAndCommitterEnv(originalHash, {
        cwd: repo.path,
      });

      const newHash = await createCommit(tree, parents, "New message", env, {
        cwd: repo.path,
      });

      // Get author info from both commits
      const originalAuthor =
        await $`git -C ${repo.path} log -1 --format=%an%x00%ae ${originalHash}`.text();
      const newAuthor = await $`git -C ${repo.path} log -1 --format=%an%x00%ae ${newHash}`.text();

      expect(newAuthor.trim()).toBe(originalAuthor.trim());
    });

    test("handles message with trailers", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const originalHash = await repo.commit();

      const tree = await getTree(originalHash, { cwd: repo.path });
      const parents = await getParents(originalHash, { cwd: repo.path });
      const env = await getAuthorAndCommitterEnv(originalHash, {
        cwd: repo.path,
      });

      const messageWithTrailer = `Test message

Spry-Commit-Id: test1234`;

      const newHash = await createCommit(tree, parents, messageWithTrailer, env, {
        cwd: repo.path,
      });

      const message = await getCommitMessage(newHash, { cwd: repo.path });
      expect(message).toContain("Spry-Commit-Id: test1234");
    });

    test("handles message with special characters", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const originalHash = await repo.commit();

      const tree = await getTree(originalHash, { cwd: repo.path });
      const parents = await getParents(originalHash, { cwd: repo.path });
      const env = await getAuthorAndCommitterEnv(originalHash, {
        cwd: repo.path,
      });

      const messageWithSpecialChars = `fix: handle "quoted" & <special> chars

Also supports $variables and \`backticks\``;

      const newHash = await createCommit(tree, parents, messageWithSpecialChars, env, {
        cwd: repo.path,
      });

      const message = await getCommitMessage(newHash, { cwd: repo.path });
      expect(message).toBe(messageWithSpecialChars);
    });
  });

  describe("mergeTree", () => {
    test("returns tree SHA for clean merge", async () => {
      const repo = await repos.create();

      // Create base commit
      await repo.branch("feature");
      const base = await repo.commit({ message: "base" });

      // Create "ours" branch with one change
      await repo.branch("ours");
      await Bun.write(join(repo.path, "ours-file.txt"), "ours content");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "ours change"`.quiet();
      const ours = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Go back to base and create "theirs" with different change
      await repo.checkout(await repo.currentBranch());
      await $`git -C ${repo.path} checkout ${base}`.quiet();
      await Bun.write(join(repo.path, "theirs-file.txt"), "theirs content");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "theirs change"`.quiet();
      const theirs = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      const result = await mergeTree(base, ours, theirs, { cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.tree).toMatch(/^[a-f0-9]{40}$/);
      }
    });

    test("returns conflict info for conflicting merge", async () => {
      const repo = await repos.create();

      // Create base commit with a file
      await repo.branch("feature");
      await Bun.write(join(repo.path, "conflict.txt"), "base content");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "base"`.quiet();
      const base = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Create "ours" with one change to the file
      await Bun.write(join(repo.path, "conflict.txt"), "ours content");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "ours change"`.quiet();
      const ours = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Go back to base and create "theirs" with conflicting change
      await $`git -C ${repo.path} checkout ${base}`.quiet();
      await Bun.write(join(repo.path, "conflict.txt"), "theirs content");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "theirs change"`.quiet();
      const theirs = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      const result = await mergeTree(base, ours, theirs, { cwd: repo.path });

      expect(result.ok).toBe(false);
    });
  });

  describe("updateRef", () => {
    test("updates ref to new SHA", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "commit 1" });
      const hash2 = await repo.commit({ message: "commit 2" });

      // Create a test ref pointing to hash1
      await $`git -C ${repo.path} update-ref refs/heads/test-ref ${hash1}`.quiet();

      // Update it to hash2
      await updateRef("refs/heads/test-ref", hash2, undefined, {
        cwd: repo.path,
      });

      const current = (await $`git -C ${repo.path} rev-parse refs/heads/test-ref`.text()).trim();
      expect(current).toBe(hash2);
    });

    test("supports compare-and-swap with oldSha", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "commit 1" });
      const hash2 = await repo.commit({ message: "commit 2" });

      // Create a test ref
      await $`git -C ${repo.path} update-ref refs/heads/test-ref ${hash1}`.quiet();

      // Update with correct oldSha - should work
      await updateRef("refs/heads/test-ref", hash2, hash1, { cwd: repo.path });

      const current = (await $`git -C ${repo.path} rev-parse refs/heads/test-ref`.text()).trim();
      expect(current).toBe(hash2);
    });

    test("fails compare-and-swap with wrong oldSha", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "commit 1" });
      const hash2 = await repo.commit({ message: "commit 2" });
      const hash3 = await repo.commit({ message: "commit 3" });

      // Create a test ref pointing to hash2
      await $`git -C ${repo.path} update-ref refs/heads/test-ref ${hash2}`.quiet();

      // Try to update with wrong oldSha (hash1 instead of hash2)
      expect(updateRef("refs/heads/test-ref", hash3, hash1, { cwd: repo.path })).rejects.toThrow();

      // Ref should be unchanged
      const current = (await $`git -C ${repo.path} rev-parse refs/heads/test-ref`.text()).trim();
      expect(current).toBe(hash2);
    });
  });

  describe("resetToCommit", () => {
    test("resets working directory to commit", async () => {
      const repo = await repos.create();

      await repo.branch("feature");

      // Create a file and commit
      await Bun.write(join(repo.path, "test.txt"), "original");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "original"`.quiet();
      const originalHash = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Modify the file and commit
      await Bun.write(join(repo.path, "test.txt"), "modified");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "modified"`.quiet();

      // Reset to original
      await resetToCommit(originalHash, { cwd: repo.path });

      // Verify file content is back to original
      const content = await Bun.file(join(repo.path, "test.txt")).text();
      expect(content).toBe("original");
    });
  });

  describe("getShortSha / getFullSha", () => {
    test("getShortSha returns abbreviated SHA", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash = await repo.commit();

      const short = await getShortSha(hash, { cwd: repo.path });

      expect(short.length).toBeLessThan(hash.length);
      expect(hash.startsWith(short)).toBe(true);
    });

    test("getFullSha returns full SHA", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash = await repo.commit();
      const shortHash = hash.slice(0, 7);

      const full = await getFullSha(shortHash, { cwd: repo.path });

      expect(full).toBe(hash);
    });
  });

  // ==========================================================================
  // Higher-level operations
  // ==========================================================================

  describe("rewriteCommitMessage", () => {
    test("rewrites message preserving tree and authorship", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const originalHash = await repo.commit({ message: "Original message" });

      const originalTree = await getTree(originalHash, { cwd: repo.path });

      const newHash = await rewriteCommitMessage(
        originalHash,
        "New message\n\nSpry-Commit-Id: abc123",
        { cwd: repo.path },
      );

      expect(newHash).not.toBe(originalHash);

      // Tree should be unchanged
      const newTree = await getTree(newHash, { cwd: repo.path });
      expect(newTree).toBe(originalTree);

      // Message should be changed
      const newMessage = await getCommitMessage(newHash, { cwd: repo.path });
      expect(newMessage).toContain("New message");
      expect(newMessage).toContain("Spry-Commit-Id: abc123");
    });

    test("preserves author and committer dates", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const originalHash = await repo.commit();

      // Wait a bit to ensure timestamps would differ if not preserved
      await Bun.sleep(10);

      const newHash = await rewriteCommitMessage(originalHash, "New message", {
        cwd: repo.path,
      });

      const originalEnv = await getAuthorAndCommitterEnv(originalHash, {
        cwd: repo.path,
      });
      const newEnv = await getAuthorAndCommitterEnv(newHash, {
        cwd: repo.path,
      });

      expect(newEnv.GIT_AUTHOR_DATE).toBe(originalEnv.GIT_AUTHOR_DATE);
      expect(newEnv.GIT_COMMITTER_DATE).toBe(originalEnv.GIT_COMMITTER_DATE);
    });
  });

  describe("rewriteCommitChain", () => {
    test("rewrites single commit in chain", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "commit 1" });

      const rewrites = new Map([[hash1, "rewritten commit 1"]]);
      const result = await rewriteCommitChain([hash1], rewrites, {
        cwd: repo.path,
      });

      expect(result.newTip).not.toBe(hash1);
      expect(result.mapping.size).toBe(1);
      expect(result.mapping.get(hash1)).toBe(result.newTip);

      const newMessage = await getCommitMessage(result.newTip, {
        cwd: repo.path,
      });
      expect(newMessage).toContain("rewritten commit 1");
    });

    test("rewrites multiple commits in chain", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "commit 1" });
      const hash2 = await repo.commit({ message: "commit 2" });
      const hash3 = await repo.commit({ message: "commit 3" });

      // Only rewrite the first and third
      const rewrites = new Map([
        [hash1, "rewritten 1"],
        [hash3, "rewritten 3"],
      ]);

      const result = await rewriteCommitChain([hash1, hash2, hash3], rewrites, {
        cwd: repo.path,
      });

      expect(result.mapping.size).toBe(3);

      // Check the new commits have correct messages
      const newHash1 = result.mapping.get(hash1)!;
      const newHash2 = result.mapping.get(hash2)!;
      const newHash3 = result.mapping.get(hash3)!;

      expect(await getCommitMessage(newHash1, { cwd: repo.path })).toContain("rewritten 1");
      expect(await getCommitMessage(newHash2, { cwd: repo.path })).toContain("commit 2"); // Unchanged
      expect(await getCommitMessage(newHash3, { cwd: repo.path })).toContain("rewritten 3");

      // Verify parent chain is correct
      const parent3 = await getParent(newHash3, { cwd: repo.path });
      const parent2 = await getParent(newHash2, { cwd: repo.path });
      expect(parent3).toBe(newHash2);
      expect(parent2).toBe(newHash1);
    });

    test("preserves tree content for all commits", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "commit 1" });
      const hash2 = await repo.commit({ message: "commit 2" });

      const tree1 = await getTree(hash1, { cwd: repo.path });
      const tree2 = await getTree(hash2, { cwd: repo.path });

      const rewrites = new Map([
        [hash1, "new 1"],
        [hash2, "new 2"],
      ]);

      const result = await rewriteCommitChain([hash1, hash2], rewrites, {
        cwd: repo.path,
      });

      const newTree1 = await getTree(result.mapping.get(hash1)!, {
        cwd: repo.path,
      });
      const newTree2 = await getTree(result.mapping.get(hash2)!, {
        cwd: repo.path,
      });

      expect(newTree1).toBe(tree1);
      expect(newTree2).toBe(tree2);
    });
  });

  describe("rebasePlumbing", () => {
    test("rebases commits onto new base (clean)", async () => {
      const repo = await repos.create();

      // Create a base commit
      await repo.branch("feature");
      const base = await repo.commit({ message: "base" });

      // Create some commits to rebase
      const hash1 = await repo.commit({ message: "commit 1" });
      const hash2 = await repo.commit({ message: "commit 2" });

      // Create a new base by going back and making a parallel commit
      await $`git -C ${repo.path} checkout ${base}`.quiet();
      await Bun.write(join(repo.path, "newbase.txt"), "new base content");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "new base"`.quiet();
      const newBase = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Rebase commits onto new base
      const result = await rebasePlumbing(newBase, [hash1, hash2], {
        cwd: repo.path,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mapping.size).toBe(2);
        expect(result.newTip).not.toBe(hash2);

        // Verify parent chain
        const newHash2 = result.newTip;
        const newHash1 = result.mapping.get(hash1)!;
        expect(await getParent(newHash2, { cwd: repo.path })).toBe(newHash1);
        expect(await getParent(newHash1, { cwd: repo.path })).toBe(newBase);

        // Verify messages preserved
        expect(
          await getCommitMessage(result.mapping.get(hash1)!, {
            cwd: repo.path,
          }),
        ).toContain("commit 1");
        expect(await getCommitMessage(result.newTip, { cwd: repo.path })).toContain("commit 2");
      }
    });

    test("returns empty commits for empty input", async () => {
      const repo = await repos.create();

      await repo.branch("feature");
      const base = await repo.commit();

      const result = await rebasePlumbing(base, [], { cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.newTip).toBe(base);
        expect(result.mapping.size).toBe(0);
      }
    });

    test("detects conflicts without modifying working directory", async () => {
      const repo = await repos.create();

      // Create base with a file
      await repo.branch("feature");
      await Bun.write(join(repo.path, "conflict.txt"), "original");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "base"`.quiet();
      const base = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Create a commit that modifies the file
      await Bun.write(join(repo.path, "conflict.txt"), "feature change");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "feature"`.quiet();
      const featureCommit = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Go back to base and make conflicting change
      await $`git -C ${repo.path} checkout ${base}`.quiet();
      await Bun.write(join(repo.path, "conflict.txt"), "conflicting change");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "conflicting base"`.quiet();
      const newBase = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Record current working directory state
      const originalContent = await Bun.file(join(repo.path, "conflict.txt")).text();

      // Try to rebase - should fail with conflict
      const result = await rebasePlumbing(newBase, [featureCommit], {
        cwd: repo.path,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.conflictCommit).toBe(featureCommit);
      }

      // Working directory should be unchanged
      const afterContent = await Bun.file(join(repo.path, "conflict.txt")).text();
      expect(afterContent).toBe(originalContent);
    });
  });

  describe("finalizeRewrite", () => {
    test("updates branch ref and skips reset for message-only changes", async () => {
      const repo = await repos.create();

      const branchName = await repo.branch("feature");
      const originalHash = await repo.commit({ message: "original" });

      // Create a marker file to verify working directory is NOT reset
      const markerPath = join(repo.path, "marker.txt");
      await Bun.write(markerPath, "marker");

      // Rewrite message only
      const newHash = await rewriteCommitMessage(originalHash, "new message", {
        cwd: repo.path,
      });

      await finalizeRewrite(branchName, originalHash, newHash, {
        cwd: repo.path,
      });

      // Branch should point to new commit
      const headRef = (await $`git -C ${repo.path} rev-parse ${branchName}`.text()).trim();
      expect(headRef).toBe(newHash);

      // Marker file should still exist (working directory not reset)
      expect(await Bun.file(markerPath).exists()).toBe(true);
    });

    test("resets working directory when tree changes", async () => {
      const repo = await repos.create();

      const branchName = await repo.branch("feature");

      // Create initial commit with a file
      await Bun.write(join(repo.path, "file.txt"), "original");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "original"`.quiet();
      const originalHash = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Create a new commit with different content
      await Bun.write(join(repo.path, "file.txt"), "modified");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "modified"`.quiet();
      const newHash = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

      // Change working directory
      await Bun.write(join(repo.path, "file.txt"), "local change");

      // "Revert" to original commit (tree change, not just message)
      await finalizeRewrite(branchName, newHash, originalHash, {
        cwd: repo.path,
      });

      // Working directory should be reset
      const content = await Bun.file(join(repo.path, "file.txt")).text();
      expect(content).toBe("original");
    });
  });

  // ==========================================================================
  // Regression tests for edge cases
  // ==========================================================================

  describe("edge cases", () => {
    /**
     * Scenario: File added mid-stack, then removed and ignored, but still on disk
     *
     * Commit 1: anything
     * Commit 2: add tracked.json file
     * Commit 3: anything
     * Commit 4: rm tracked.json and add to .gitignore
     * Commit 5: anything (also re-create tracked.json, but it's NOT tracked - just on disk)
     * Commit 6: anything
     *
     * When traditional rebase replays commit 2 (which adds tracked.json),
     * it fails because tracked.json already exists as untracked in working dir.
     */

    test("traditional rebase --exec fails when file added mid-stack then ignored", async () => {
      const repo = await repos.create();
      await scenarios.untrackedAfterIgnored.setup(repo);

      // Verify tracked.json exists but is untracked
      expect(await Bun.file(join(repo.path, "tracked.json")).exists()).toBe(true);
      const lsFiles = await $`git -C ${repo.path} ls-files tracked.json`.text();
      expect(lsFiles.trim()).toBe(""); // Not tracked

      // Get merge base for rebase
      const mergeBase = (await $`git -C ${repo.path} merge-base HEAD origin/main`.text()).trim();

      // Try traditional rebase with --exec (what spry used to do)
      // This should FAIL because when replaying commit 2, tracked.json already exists
      const result =
        await $`GIT_SEQUENCE_EDITOR=true git -C ${repo.path} rebase -i --exec "echo rewriting" ${mergeBase}`
          .quiet()
          .nothrow();

      // Traditional rebase should fail with untracked file error
      expect(result.exitCode).not.toBe(0);
      const stderr = result.stderr.toString();
      expect(
        stderr.includes("untracked working tree files would be overwritten") ||
          stderr.includes("would be overwritten by merge") ||
          stderr.includes("The following untracked working tree files would be overwritten"),
      ).toBe(true);

      // Abort the failed rebase
      await $`git -C ${repo.path} rebase --abort`.quiet().nothrow();
    });

    test("plumbing rebase succeeds when file added mid-stack then ignored", async () => {
      const repo = await repos.create();
      await scenarios.untrackedAfterIgnored.setup(repo);

      // Get current branch name and commits from the scenario
      const branchName = (await $`git -C ${repo.path} rev-parse --abbrev-ref HEAD`.text()).trim();

      // Get all 6 commits from the stack (oldest to newest)
      const logOutput =
        await $`git -C ${repo.path} log --reverse --format=%H origin/main..HEAD`.text();
      const commits = logOutput.trim().split("\n");
      expect(commits.length).toBe(6);

      // Record the untracked file content
      const untrackedContentBefore = await Bun.file(join(repo.path, "tracked.json")).text();
      expect(untrackedContentBefore).toBe('{"untracked": true, "local": "data"}\n');

      // Build rewrites - add "hello: " prefix to all commit messages
      const rewrites = new Map<string, string>();
      for (const hash of commits) {
        const msg = await getCommitMessage(hash, { cwd: repo.path });
        rewrites.set(hash, `hello: ${msg}`);
      }

      // Perform plumbing rebase with message rewrites
      // This is equivalent to what rewriteCommitChain does
      const result = await rewriteCommitChain(commits, rewrites, { cwd: repo.path });

      // Plumbing rebase should succeed
      expect(result.newTip).toBeDefined();
      expect(result.mapping.size).toBe(6);

      // The untracked file should be UNCHANGED
      const untrackedContentAfter = await Bun.file(join(repo.path, "tracked.json")).text();
      expect(untrackedContentAfter).toBe(untrackedContentBefore);

      // Finalize the rewrite
      const oldTip = commits[commits.length - 1]!;
      await finalizeRewrite(branchName, oldTip, result.newTip, { cwd: repo.path });

      // Verify all messages were rewritten
      let current = result.newTip;
      for (let i = commits.length - 1; i >= 0; i--) {
        const msg = await getCommitMessage(current, { cwd: repo.path });
        expect(msg).toContain("hello:");
        if (i > 0) {
          current = await getParent(current, { cwd: repo.path });
        }
      }

      // Untracked file should still be there with original content
      expect(await Bun.file(join(repo.path, "tracked.json")).exists()).toBe(true);
      expect(await Bun.file(join(repo.path, "tracked.json")).text()).toBe(untrackedContentBefore);
    });
  });
});
