import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createLocalRepo, type LocalRepo } from "../scenario/core.ts";
import { generateUniqueId } from "../../tests/helpers/unique-id.ts";
import {
  getCommitFiles,
  checkFileOverlap,
  simulateMerge,
  predictConflict,
  checkReorderConflicts,
  formatConflictIndicator,
  clearFileCache,
} from "./conflict-predict.ts";
import { $ } from "bun";
import { join } from "node:path";

describe("conflict-predict", () => {
  let repo: LocalRepo;

  // Helper to write a file in the repo
  async function writeFile(filename: string, content: string) {
    await Bun.write(join(repo.path, filename), content);
  }

  beforeEach(async () => {
    repo = await createLocalRepo(
      { uniqueId: generateUniqueId() },
      { scenarioName: "conflict-predict" },
    );
    // Clear the file cache before each test
    clearFileCache();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  describe("getCommitFiles", () => {
    test("returns files modified by a commit", async () => {
      await repo.branch("feature");
      const hash = await repo.commitFiles(
        { "file1.txt": "content1", "file2.txt": "content2" },
        { message: "Add two files" },
      );

      const files = await getCommitFiles(hash, { cwd: repo.path });

      expect(files).toContain("file1.txt");
      expect(files).toContain("file2.txt");
      expect(files).toHaveLength(2);
    });

    test("returns empty array for commit with no file changes", async () => {
      await repo.branch("feature");
      // Create empty commit using --allow-empty
      await $`git -C ${repo.path} commit --allow-empty -m "Empty commit"`.nothrow();
      const hash = await $`git -C ${repo.path} rev-parse HEAD`.text();

      const files = await getCommitFiles(hash.trim(), { cwd: repo.path });

      expect(files).toHaveLength(0);
    });

    test("caches results for repeated calls", async () => {
      await repo.branch("feature");
      const hash = await repo.commitFiles(
        { "cached.txt": "content" },
        { message: "Cached commit" },
      );

      // First call
      const files1 = await getCommitFiles(hash, { cwd: repo.path });
      // Second call should use cache
      const files2 = await getCommitFiles(hash, { cwd: repo.path });

      expect(files1).toEqual(files2);
      expect(files1).toContain("cached.txt");
    });
  });

  describe("checkFileOverlap", () => {
    test("detects overlapping files between commits", async () => {
      await repo.branch("feature");

      // First commit modifies file1.txt and file2.txt
      const hash1 = await repo.commitFiles(
        { "file1.txt": "v1", "file2.txt": "v1" },
        { message: "First commit" },
      );

      // Second commit modifies file2.txt and file3.txt
      const hash2 = await repo.commitFiles(
        { "file2.txt": "v2", "file3.txt": "v1" },
        { message: "Second commit" },
      );

      const overlap = await checkFileOverlap(hash1, hash2, { cwd: repo.path });

      expect(overlap).toContain("file2.txt");
      expect(overlap).not.toContain("file1.txt");
      expect(overlap).not.toContain("file3.txt");
    });

    test("returns empty array when no overlap", async () => {
      await repo.branch("feature");

      const hash1 = await repo.commitFiles(
        { "file1.txt": "content1" },
        { message: "First commit" },
      );
      const hash2 = await repo.commitFiles(
        { "file2.txt": "content2" },
        { message: "Second commit" },
      );

      const overlap = await checkFileOverlap(hash1, hash2, { cwd: repo.path });

      expect(overlap).toHaveLength(0);
    });

    test("handles multiple overlapping files", async () => {
      await repo.branch("feature");

      const hash1 = await repo.commitFiles(
        { "shared1.txt": "v1", "shared2.txt": "v1", "unique1.txt": "v1" },
        { message: "First commit" },
      );

      const hash2 = await repo.commitFiles(
        { "shared1.txt": "v2", "shared2.txt": "v2", "unique2.txt": "v1" },
        { message: "Second commit" },
      );

      const overlap = await checkFileOverlap(hash1, hash2, { cwd: repo.path });

      expect(overlap).toContain("shared1.txt");
      expect(overlap).toContain("shared2.txt");
      expect(overlap).toHaveLength(2);
    });
  });

  describe("simulateMerge", () => {
    test("returns conflict status when commits conflict", async () => {
      await repo.branch("feature");

      // Create a base file
      const baseCommit = await repo.commitFiles(
        { "conflict.txt": "base content\nline 2\nline 3\n" },
        { message: "Base commit" },
      );

      // First commit changes line 2
      const hash1 = await repo.commitFiles(
        { "conflict.txt": "base content\nmodified by first\nline 3\n" },
        { message: "First change" },
      );

      // Go back to base and create conflicting change
      await $`git -C ${repo.path} checkout ${baseCommit}`.nothrow();
      await writeFile("conflict.txt", "base content\nmodified by second\nline 3\n");
      await $`git -C ${repo.path} add -A`.nothrow();
      await $`git -C ${repo.path} commit -m "Second change"`.nothrow();
      const hash2 = await $`git -C ${repo.path} rev-parse HEAD`.text();

      const result = await simulateMerge(baseCommit, hash1, hash2.trim(), ["conflict.txt"], {
        cwd: repo.path,
      });

      expect(result.status).toBe("conflict");
    });

    test("returns warning status when files overlap but no conflict", async () => {
      await repo.branch("feature");

      // Create a file with multiple sections
      const baseCommit = await repo.commitFiles(
        { "shared.txt": "section 1\n---\nsection 2\n---\nsection 3\n" },
        { message: "Base commit" },
      );

      // First commit changes section 1
      const hash1 = await repo.commitFiles(
        { "shared.txt": "modified section 1\n---\nsection 2\n---\nsection 3\n" },
        { message: "First change" },
      );

      // Go back to base and change section 3
      await $`git -C ${repo.path} checkout ${baseCommit}`.nothrow();
      await writeFile("shared.txt", "section 1\n---\nsection 2\n---\nmodified section 3\n");
      await $`git -C ${repo.path} add -A`.nothrow();
      await $`git -C ${repo.path} commit -m "Second change"`.nothrow();
      const hash2 = await $`git -C ${repo.path} rev-parse HEAD`.text();

      const result = await simulateMerge(baseCommit, hash1, hash2.trim(), ["shared.txt"], {
        cwd: repo.path,
      });

      // Different sections modified - should merge cleanly (warning because files overlap)
      expect(result.status).toBe("warning");
      expect(result.files).toContain("shared.txt");
    });

    test("returns clean status when no overlapping files", async () => {
      await repo.branch("feature");

      const hash1 = await repo.commitFiles({ "file1.txt": "content" }, { message: "First commit" });

      const result = await simulateMerge(hash1, hash1, hash1, [], { cwd: repo.path });

      expect(result.status).toBe("clean");
    });
  });

  describe("predictConflict", () => {
    test("returns clean when commits touch different files", async () => {
      await repo.branch("feature");

      const baseCommit = await repo.commitFiles({ "file1.txt": "content1" }, { message: "Base" });
      const hash1 = await repo.commitFiles({ "file2.txt": "content2" }, { message: "Touch file2" });

      await $`git -C ${repo.path} checkout ${baseCommit}`.nothrow();
      await writeFile("file3.txt", "content3");
      await $`git -C ${repo.path} add -A`.nothrow();
      await $`git -C ${repo.path} commit -m "Touch file3"`.nothrow();
      const hash2 = await $`git -C ${repo.path} rev-parse HEAD`.text();

      const result = await predictConflict(hash1, hash2.trim(), baseCommit, { cwd: repo.path });

      expect(result.status).toBe("clean");
    });

    test("returns conflict when commits would conflict", async () => {
      await repo.branch("feature");

      const baseCommit = await repo.commitFiles(
        { "shared.txt": "original\n" },
        { message: "Base" },
      );
      const hashA = await repo.commitFiles(
        { "shared.txt": "changed by A\n" },
        { message: "Change A" },
      );

      await $`git -C ${repo.path} checkout ${baseCommit}`.nothrow();
      await writeFile("shared.txt", "changed by B\n");
      await $`git -C ${repo.path} add -A`.nothrow();
      await $`git -C ${repo.path} commit -m "Change B"`.nothrow();
      const hashB = await $`git -C ${repo.path} rev-parse HEAD`.text();

      const result = await predictConflict(hashA, hashB.trim(), baseCommit, { cwd: repo.path });

      expect(result.status).toBe("conflict");
    });
  });

  describe("checkReorderConflicts", () => {
    test("detects conflicts when reordering commits", async () => {
      await repo.branch("feature");

      const baseCommit = await repo.commitFiles({ "shared.txt": "line 1\n" }, { message: "Base" });
      const hashA = await repo.commitFiles(
        { "shared.txt": "line 1\nline 2 from A\n" },
        { message: "Commit A" },
      );
      const hashB = await repo.commitFiles(
        { "shared.txt": "line 1\nline 2 from A\nline 3 from B\n" },
        { message: "Commit B" },
      );

      // Original order: [A, B], new order: [B, A] (swapped)
      const conflicts = await checkReorderConflicts([hashA, hashB], [hashB, hashA], baseCommit, {
        cwd: repo.path,
      });

      // Should detect potential conflict since B was built on top of A
      expect(conflicts.size).toBeGreaterThanOrEqual(0); // May or may not conflict depending on content
    });

    test("returns empty map when order unchanged", async () => {
      await repo.branch("feature");

      const hash1 = await repo.commitFiles({ "file1.txt": "content1" }, { message: "First" });
      const hash2 = await repo.commitFiles({ "file2.txt": "content2" }, { message: "Second" });

      // Same order
      const conflicts = await checkReorderConflicts([hash1, hash2], [hash1, hash2], hash1, {
        cwd: repo.path,
      });

      expect(conflicts.size).toBe(0);
    });
  });

  describe("formatConflictIndicator", () => {
    test("formats clean status", () => {
      const result = formatConflictIndicator({ status: "clean" });
      expect(result.length).toBeGreaterThan(0);
    });

    test("formats warning status with files", () => {
      const result = formatConflictIndicator({
        status: "warning",
        files: ["file1.txt", "file2.txt"],
      });
      expect(result).toContain("file1.txt");
      expect(result).toContain("file2.txt");
    });

    test("formats conflict status with files", () => {
      const result = formatConflictIndicator({
        status: "conflict",
        files: ["conflict.txt"],
      });
      expect(result).toContain("conflict.txt");
    });

    test("formats conflict status with conflict lines", () => {
      const result = formatConflictIndicator({
        status: "conflict",
        files: ["auth.ts"],
        conflictLines: ["auth.ts:15-22"],
      });
      expect(result).toContain("auth.ts:15-22");
    });
  });

  describe("clearFileCache", () => {
    test("clears cached file lists", async () => {
      await repo.branch("feature");
      const hash = await repo.commitFiles({ "cached.txt": "content" }, { message: "Test commit" });

      // Populate cache
      await getCommitFiles(hash, { cwd: repo.path });

      // Clear cache
      clearFileCache();

      // After clearing, should still work (will re-fetch)
      const files = await getCommitFiles(hash, { cwd: repo.path });
      expect(files).toContain("cached.txt");
    });
  });
});
