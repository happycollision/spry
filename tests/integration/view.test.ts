import { expect, describe } from "bun:test";
import { repoManager } from "../helpers/local-repo.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { SKIP_GITHUB_TESTS, runSync, runView } from "./helpers.ts";

const { test } = createStoryTest("view.test.ts");

describe.skipIf(SKIP_GITHUB_TESTS)("GitHub Integration: view command", () => {
  const repos = repoManager({ github: true });

  test(
    "Empty stack",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When there are no local commits ahead of main, `sp view` shows an empty stack.",
      );

      const repo = await repos.clone({ testName: "empty" });

      const result = await runView(repo.path);
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Empty stack");
    },
    { timeout: 60000 },
  );

  test(
    "Stack with synced commits",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "After syncing commits with `sp sync`, `sp view` shows each commit with its Spry ID.",
      );

      const repo = await repos.clone({ testName: "synced" });
      await repo.branch("feature/view-synced");
      await repo.commit();
      await repo.commit();

      // Sync to add Spry IDs
      const syncResult = await runSync(repo.path);
      expect(syncResult.exitCode).toBe(0);

      story.narrate("After syncing, the stack shows each commit:");
      const result = await runView(repo.path);
      story.log(result);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("2 commits");
    },
    { timeout: 60000 },
  );

  test(
    "Stack with open PRs",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "When PRs have been created with `sp sync --open`, `sp view` shows PR numbers and status indicators.",
      );

      const repo = await repos.clone({ testName: "prs" });
      await repo.branch("feature/view-prs");
      await repo.commit();

      // Sync with --open to create PR
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      story.narrate("With an open PR, view shows the PR number and status:");
      const result = await runView(repo.path);
      story.log(result);

      expect(result.exitCode).toBe(0);
      // Should show PR indicator
      expect(result.stdout).toMatch(/#\d+/);
    },
    { timeout: 60000 },
  );

  test(
    "View all PRs",
    async (story) => {
      story.strip(repos.uniqueId);
      story.narrate(
        "The `sp view --all` flag shows all PRs authored by the current user, not just the current stack.",
      );

      const repo = await repos.clone({ testName: "all" });
      await repo.branch("feature/view-all");
      await repo.commit();

      // Create a PR first
      const syncResult = await runSync(repo.path, { open: true });
      expect(syncResult.exitCode).toBe(0);

      story.narrate("With --all, view shows PRs from any branch:");
      const result = await runView(repo.path, { all: true });
      story.log(result);

      expect(result.exitCode).toBe(0);
      // Should show the PR we just created
      expect(result.stdout).toMatch(/#\d+/);
    },
    { timeout: 60000 },
  );
});
