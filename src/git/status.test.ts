import { test, expect, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { createGitFixture, type GitFixture } from "../../tests/helpers/git-fixture.ts";
import { getWorkingTreeStatus, requireCleanWorkingTree, DirtyWorkingTreeError } from "./status.ts";
import { join } from "node:path";

let fixture: GitFixture | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.cleanup();
    fixture = null;
  }
});

describe("git/status", () => {
  describe("getWorkingTreeStatus", () => {
    test("clean working tree", async () => {
      fixture = await createGitFixture();

      const status = await getWorkingTreeStatus({ cwd: fixture.path });

      expect(status.isDirty).toBe(false);
      expect(status.hasStagedChanges).toBe(false);
      expect(status.hasUnstagedChanges).toBe(false);
      expect(status.hasUntrackedFiles).toBe(false);
    });

    test("detects untracked files", async () => {
      fixture = await createGitFixture();
      await Bun.write(join(fixture.path, "untracked.ts"), "// untracked");

      const status = await getWorkingTreeStatus({ cwd: fixture.path });

      expect(status.isDirty).toBe(true);
      expect(status.hasUntrackedFiles).toBe(true);
      expect(status.hasStagedChanges).toBe(false);
      expect(status.hasUnstagedChanges).toBe(false);
    });

    test("detects staged changes", async () => {
      fixture = await createGitFixture();
      await Bun.write(join(fixture.path, "staged.ts"), "// staged");
      await $`git -C ${fixture.path} add staged.ts`.quiet();

      const status = await getWorkingTreeStatus({ cwd: fixture.path });

      expect(status.isDirty).toBe(true);
      expect(status.hasStagedChanges).toBe(true);
      expect(status.hasUnstagedChanges).toBe(false);
      expect(status.hasUntrackedFiles).toBe(false);
    });

    test("detects unstaged changes to tracked file", async () => {
      fixture = await createGitFixture();
      // Modify existing tracked file
      await Bun.write(join(fixture.path, "README.md"), "# Modified");

      const status = await getWorkingTreeStatus({ cwd: fixture.path });

      expect(status.isDirty).toBe(true);
      expect(status.hasUnstagedChanges).toBe(true);
      expect(status.hasStagedChanges).toBe(false);
      expect(status.hasUntrackedFiles).toBe(false);
    });

    test("detects both staged and unstaged changes", async () => {
      fixture = await createGitFixture();
      // Stage a new file
      await Bun.write(join(fixture.path, "staged.ts"), "// staged");
      await $`git -C ${fixture.path} add staged.ts`.quiet();
      // Modify tracked file without staging
      await Bun.write(join(fixture.path, "README.md"), "# Modified");

      const status = await getWorkingTreeStatus({ cwd: fixture.path });

      expect(status.isDirty).toBe(true);
      expect(status.hasStagedChanges).toBe(true);
      expect(status.hasUnstagedChanges).toBe(true);
    });
  });

  describe("requireCleanWorkingTree", () => {
    test("passes with clean working tree", async () => {
      fixture = await createGitFixture();

      // Should not throw
      await requireCleanWorkingTree({ cwd: fixture.path });
    });

    test("passes with only untracked files", async () => {
      fixture = await createGitFixture();
      await Bun.write(join(fixture.path, "untracked.ts"), "// untracked");

      // Should not throw - untracked files don't affect rebase
      await requireCleanWorkingTree({ cwd: fixture.path });
    });

    test("throws DirtyWorkingTreeError with staged changes", async () => {
      fixture = await createGitFixture();
      await Bun.write(join(fixture.path, "staged.ts"), "// staged");
      await $`git -C ${fixture.path} add staged.ts`.quiet();

      try {
        await requireCleanWorkingTree({ cwd: fixture.path });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DirtyWorkingTreeError);
      }
    });

    test("throws DirtyWorkingTreeError with unstaged changes", async () => {
      fixture = await createGitFixture();
      await Bun.write(join(fixture.path, "README.md"), "# Modified");

      try {
        await requireCleanWorkingTree({ cwd: fixture.path });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DirtyWorkingTreeError);
      }
    });

    test("error message describes the problem", async () => {
      fixture = await createGitFixture();
      await Bun.write(join(fixture.path, "staged.ts"), "// staged");
      await $`git -C ${fixture.path} add staged.ts`.quiet();
      await Bun.write(join(fixture.path, "README.md"), "# Modified");

      try {
        await requireCleanWorkingTree({ cwd: fixture.path });
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
