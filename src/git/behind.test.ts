import { test, expect, afterEach, describe } from "bun:test";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import { isStackBehindMain, getCommitsBehind } from "./behind.ts";

const repos = repoManager();
afterEach(() => repos.cleanup());

describe("git/behind", () => {
  describe("isStackBehindMain", () => {
    test("returns false when stack is up to date", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Feature commit");

      const result = await isStackBehindMain({ cwd: repo.path });
      expect(result).toBe(false);
    });

    test("returns true when origin/main has new commits", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Feature commit");

      // Push a commit to origin/main (simulating another developer's work)
      await repo.updateOriginMain("Commit from main");

      const result = await isStackBehindMain({ cwd: repo.path });
      expect(result).toBe(true);
    });

    test("returns false when stack is ahead but not behind", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Feature commit 1");
      await repo.commit("Feature commit 2");

      // Stack is ahead of main but not behind
      const result = await isStackBehindMain({ cwd: repo.path });
      expect(result).toBe(false);
    });
  });

  describe("getCommitsBehind", () => {
    test("returns 0 when stack is up to date", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Feature commit");

      await repo.fetch();

      const count = await getCommitsBehind({ cwd: repo.path });
      expect(count).toBe(0);
    });

    test("returns correct count when behind by N commits", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Feature commit");

      // Push multiple commits to origin/main
      for (let i = 1; i <= 3; i++) {
        await repo.updateOriginMain(`Main commit ${i}`);
      }

      await repo.fetch();

      const count = await getCommitsBehind({ cwd: repo.path });
      expect(count).toBe(3);
    });

    test("returns correct count when diverged (both ahead and behind)", async () => {
      const repo = await repos.create();
      await repo.branch("feature");
      await repo.commit("Feature commit 1");
      await repo.commit("Feature commit 2");

      // Push commit to origin/main (creating divergence)
      await repo.updateOriginMain("Divergent commit");

      await repo.fetch();

      // Stack is 2 ahead, 1 behind
      const count = await getCommitsBehind({ cwd: repo.path });
      expect(count).toBe(1);
    });
  });
});
