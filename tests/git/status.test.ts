import { test, expect, describe } from "bun:test";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import {
  getWorkingTreeStatus,
  requireCleanWorkingTree,
} from "../../src/git/status.ts";

const git = createRealGitRunner();

describe("getWorkingTreeStatus", () => {
  test("clean tree: all false", async () => {
    const repo = await createRepo();
    try {
      const status = await getWorkingTreeStatus(git, { cwd: repo.path });
      expect(status.isDirty).toBe(false);
      expect(status.hasUnstagedChanges).toBe(false);
      expect(status.hasStagedChanges).toBe(false);
      expect(status.hasUntrackedFiles).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  test("unstaged changes: isDirty and hasUnstagedChanges true", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(repo.path + "/README.md", "modified");
      const status = await getWorkingTreeStatus(git, { cwd: repo.path });
      expect(status.isDirty).toBe(true);
      expect(status.hasUnstagedChanges).toBe(true);
      expect(status.hasStagedChanges).toBe(false);
      expect(status.hasUntrackedFiles).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  test("staged changes: hasStagedChanges true", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(repo.path + "/README.md", "modified");
      await git.run(["add", "README.md"], { cwd: repo.path });
      const status = await getWorkingTreeStatus(git, { cwd: repo.path });
      expect(status.isDirty).toBe(true);
      expect(status.hasStagedChanges).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("untracked files: hasUntrackedFiles true, hasUnstagedChanges false", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(repo.path + "/untracked.txt", "new");
      const status = await getWorkingTreeStatus(git, { cwd: repo.path });
      expect(status.isDirty).toBe(true);
      expect(status.hasUntrackedFiles).toBe(true);
      expect(status.hasUnstagedChanges).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("requireCleanWorkingTree", () => {
  test("does not throw for clean tree", async () => {
    const repo = await createRepo();
    try {
      await requireCleanWorkingTree(git, { cwd: repo.path });
    } finally {
      await repo.cleanup();
    }
  });

  test("throws for unstaged changes", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(repo.path + "/README.md", "modified");
      await expect(
        requireCleanWorkingTree(git, { cwd: repo.path }),
      ).rejects.toThrow("uncommitted");
    } finally {
      await repo.cleanup();
    }
  });

  test("does not throw for untracked-only", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(repo.path + "/untracked.txt", "new");
      await requireCleanWorkingTree(git, { cwd: repo.path });
    } finally {
      await repo.cleanup();
    }
  });
});
