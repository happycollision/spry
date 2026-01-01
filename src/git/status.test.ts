import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import { getWorkingTreeStatus, requireCleanWorkingTree, DirtyWorkingTreeError } from "./status.ts";
import { join } from "node:path";

// Git operations can be slow under load, increase default timeout
setDefaultTimeout(15_000);

const repos = repoManager();

describe("git/status", () => {
  describe("getWorkingTreeStatus", () => {
    test("clean working tree", async () => {
      const repo = await repos.create();

      const status = await getWorkingTreeStatus({ cwd: repo.path });

      expect(status.isDirty).toBe(false);
      expect(status.hasStagedChanges).toBe(false);
      expect(status.hasUnstagedChanges).toBe(false);
      expect(status.hasUntrackedFiles).toBe(false);
    });

    test("detects untracked files", async () => {
      const repo = await repos.create();
      await Bun.write(join(repo.path, "untracked.ts"), "// untracked");

      const status = await getWorkingTreeStatus({ cwd: repo.path });

      expect(status.isDirty).toBe(true);
      expect(status.hasUntrackedFiles).toBe(true);
      expect(status.hasStagedChanges).toBe(false);
      expect(status.hasUnstagedChanges).toBe(false);
    });

    test("detects staged changes", async () => {
      const repo = await repos.create();
      await Bun.write(join(repo.path, "staged.ts"), "// staged");
      await $`git -C ${repo.path} add staged.ts`.quiet();

      const status = await getWorkingTreeStatus({ cwd: repo.path });

      expect(status.isDirty).toBe(true);
      expect(status.hasStagedChanges).toBe(true);
      expect(status.hasUnstagedChanges).toBe(false);
      expect(status.hasUntrackedFiles).toBe(false);
    });

    test("detects unstaged changes to tracked file", async () => {
      const repo = await repos.create();
      // Modify existing tracked file
      await Bun.write(join(repo.path, "README.md"), "# Modified");

      const status = await getWorkingTreeStatus({ cwd: repo.path });

      expect(status.isDirty).toBe(true);
      expect(status.hasUnstagedChanges).toBe(true);
      expect(status.hasStagedChanges).toBe(false);
      expect(status.hasUntrackedFiles).toBe(false);
    });

    test("detects both staged and unstaged changes", async () => {
      const repo = await repos.create();
      // Stage a new file
      await Bun.write(join(repo.path, "staged.ts"), "// staged");
      await $`git -C ${repo.path} add staged.ts`.quiet();
      // Modify tracked file without staging
      await Bun.write(join(repo.path, "README.md"), "# Modified");

      const status = await getWorkingTreeStatus({ cwd: repo.path });

      expect(status.isDirty).toBe(true);
      expect(status.hasStagedChanges).toBe(true);
      expect(status.hasUnstagedChanges).toBe(true);
    });
  });

  describe("requireCleanWorkingTree", () => {
    test("passes with clean working tree", async () => {
      const repo = await repos.create();

      // Should not throw
      await requireCleanWorkingTree({ cwd: repo.path });
    });

    test("passes with only untracked files", async () => {
      const repo = await repos.create();
      await Bun.write(join(repo.path, "untracked.ts"), "// untracked");

      // Should not throw - untracked files don't affect rebase
      await requireCleanWorkingTree({ cwd: repo.path });
    });

    test("throws DirtyWorkingTreeError with staged changes", async () => {
      const repo = await repos.create();
      await Bun.write(join(repo.path, "staged.ts"), "// staged");
      await $`git -C ${repo.path} add staged.ts`.quiet();

      try {
        await requireCleanWorkingTree({ cwd: repo.path });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DirtyWorkingTreeError);
      }
    });

    test("throws DirtyWorkingTreeError with unstaged changes", async () => {
      const repo = await repos.create();
      await Bun.write(join(repo.path, "README.md"), "# Modified");

      try {
        await requireCleanWorkingTree({ cwd: repo.path });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DirtyWorkingTreeError);
      }
    });

    test("error message describes the problem", async () => {
      const repo = await repos.create();
      await Bun.write(join(repo.path, "staged.ts"), "// staged");
      await $`git -C ${repo.path} add staged.ts`.quiet();
      await Bun.write(join(repo.path, "README.md"), "# Modified");

      try {
        await requireCleanWorkingTree({ cwd: repo.path });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DirtyWorkingTreeError);
        const error = e as DirtyWorkingTreeError;
        expect(error.message).toContain("staged changes");
        expect(error.message).toContain("unstaged changes");
        expect(error.status.hasStagedChanges).toBe(true);
        expect(error.status.hasUnstagedChanges).toBe(true);
      }
    });
  });
});
