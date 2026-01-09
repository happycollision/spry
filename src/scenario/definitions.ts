/**
 * Pre-built scenario configurations for testing and interactive exploration.
 *
 * ## Key exports
 * - `scenarios` - Named scenarios object (use in tests: `scenarios.multiCommitStack`)
 * - `scenarioList` - Array of all scenarios (use for menus/iteration)
 *
 * ## Available scenarios
 * - `emptyStack` - Just main branch, no feature work
 * - `singleCommit` - One commit on feature branch (no ID)
 * - `multiCommitStack` - 3 commits stacked on feature branch
 * - `divergedMain` - Feature branch + upstream changes (needs rebase)
 * - `withTasprIds` - 2 commits with Taspr-Commit-Id trailers
 * - `mixedTrailerStack` - Some commits have IDs, some don't
 * - `conflictScenario` - Setup that will conflict on rebase to main
 * - `multipleBranches` - Two independent feature branches
 * - `reorderConflict` - Commits that conflict when reordered (for TUI testing)
 * - `withGroups` - Stack with existing group trailers (for dissolve testing)
 * - `splitGroup` - Stack with split group (for sync validation testing)
 * - `inconsistentGroupTitle` - Stack with inconsistent group titles (for sync validation testing)
 * - `mixedGroupStack` - Mixed stack with ungrouped + multi-commit group + single-commit group
 *
 * ## Usage in tests
 * ```ts
 * import { scenarios } from "../../src/scenario/definitions.ts";
 * import { repoManager } from "../../tests/helpers/local-repo.ts";
 *
 * const repos = repoManager();
 *
 * test("my test", async () => {
 *   const repo = await repos.create();
 *   await scenarios.multiCommitStack.setup(repo);
 *   // repo now has 3 commits on feature branch
 * });
 * ```
 *
 * ## Interactive runner
 * Run `bun run scenario --help` to see available scenarios
 * Run `bun run scenario <name>` to spin up a scenario interactively
 *
 * ## Related
 * - `src/scenario/core.ts` - Low-level repo creation
 * - `src/scenario/runner.ts` - Interactive scenario runner
 */

import { $ } from "bun";
import { join } from "node:path";
import type { LocalRepo } from "./core.ts";

export interface ScenarioDefinition {
  name: string;
  description: string;
  setup: (repo: LocalRepo) => Promise<void>;
}

/**
 * Named scenarios for direct import in tests.
 */
export const scenarios = {
  /**
   * Empty stack - just the main branch with initial commit.
   * Good for testing empty state rendering.
   */
  emptyStack: {
    name: "empty-stack",
    description: "Empty stack (just main branch)",
    setup: async (_repo: LocalRepo) => {
      // No additional setup - just the initial commit on main
    },
  },

  /**
   * Single commit on a feature branch.
   * Basic stack display scenario.
   */
  singleCommit: {
    name: "single-commit",
    description: "Single commit on feature branch",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      await repo.commit({ message: "Add feature" });
    },
  },

  /**
   * Multiple commits stacked on a feature branch.
   * Good for testing stack visualization with multiple items.
   */
  multiCommitStack: {
    name: "multi-commit-stack",
    description: "Multi-commit stack (3 commits on feature)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      await repo.commit({ message: "First change" });
      await repo.commit({ message: "Second change" });
      await repo.commit({ message: "Third change" });
    },
  },

  /**
   * Feature branch with upstream changes on main.
   * Simulates the "needs rebase" scenario.
   */
  divergedMain: {
    name: "diverged-main",
    description: "Feature branch with diverged origin/main (needs rebase)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      await repo.commit({ message: "Feature work" });
      await repo.commit({ message: "More feature work" });
      await repo.updateOriginMain("Upstream change on main");
      await repo.fetch();
    },
  },

  /**
   * Commits with Taspr-Commit-Id trailers already set.
   * For testing existing ID handling.
   */
  withTasprIds: {
    name: "with-taspr-ids",
    description: "Stack with Taspr-Commit-Id trailers",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      await repo.commit({
        message: "First commit",
        trailers: { "Taspr-Commit-Id": "abc12345" },
      });
      await repo.commit({
        message: "Second commit",
        trailers: { "Taspr-Commit-Id": "def67890" },
      });
    },
  },

  /**
   * Setup for testing rebase conflict scenarios.
   * Creates a file that will conflict when rebasing.
   */
  conflictScenario: {
    name: "conflict-scenario",
    description: "Setup for rebase conflict testing",
    setup: async (repo: LocalRepo) => {
      // Create a file that will conflict
      await repo.commitFiles({ "shared.txt": "Original content\n" });
      await $`git -C ${repo.path} push origin main`.quiet();

      await repo.branch("feature");
      await repo.commitFiles({ "shared.txt": "Feature content\n" }, { message: "Feature change" });

      // Update main with conflicting content
      await repo.updateOriginMain("Main change", { "shared.txt": "Main content\n" });
      await repo.fetch();
    },
  },

  /**
   * Multiple independent feature branches.
   * For testing complex workflow visualization.
   */
  multipleBranches: {
    name: "multiple-branches",
    description: "Multiple feature branches for complex workflows",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature-a");
      await repo.commit({ message: "Feature A work" });

      await repo.checkout("main");
      await repo.branch("feature-b");
      await repo.commit({ message: "Feature B work" });
      await repo.commit({ message: "More Feature B work" });
    },
  },

  /**
   * Stack with mixed trailer states - some commits have IDs, some don't.
   * For testing ID injection and partial sync scenarios.
   */
  mixedTrailerStack: {
    name: "mixed-trailer-stack",
    description: "Stack with some commits missing Taspr-Commit-Id",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      await repo.commit({
        message: "First commit with ID",
        trailers: { "Taspr-Commit-Id": "mix00001" },
      });
      await repo.commit({ message: "Second commit without ID" });
      await repo.commit({ message: "Third commit without ID" });
    },
  },

  /**
   * Stack where reordering commits would cause conflicts.
   * Two commits modify the same file in incompatible ways.
   * Good for testing conflict prediction in the group TUI.
   */
  reorderConflict: {
    name: "reorder-conflict",
    description: "Commits that conflict when reordered (for TUI testing)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      // First commit creates a file with specific content
      await repo.commitFiles(
        { "config.ts": 'export const API_URL = "http://localhost:3000";\n' },
        { message: "Add config file" },
      );
      // Second commit modifies the same line - safe in this order, conflicts if swapped
      await repo.commitFiles(
        {
          "config.ts":
            'export const API_URL = "http://localhost:3000";\nexport const TIMEOUT = 5000;\n',
        },
        { message: "Add timeout config" },
      );
      // Third commit also touches config - would conflict if moved before second
      await repo.commitFiles(
        {
          "config.ts":
            'export const API_URL = "http://localhost:3000";\nexport const TIMEOUT = 10000;\nexport const RETRIES = 3;\n',
        },
        { message: "Update timeout and add retries" },
      );
    },
  },

  /**
   * Stack with existing group trailers.
   * Good for testing dissolve command and group editing.
   */
  withGroups: {
    name: "with-groups",
    description: "Stack with existing group trailers (for dissolve testing)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      // Create a group of 2 commits (both have Taspr-Group and Taspr-Group-Title)
      await repo.commit({
        message: "First grouped commit",
        trailers: {
          "Taspr-Commit-Id": "grp00001",
          "Taspr-Group": "group-abc",
          "Taspr-Group-Title": "Feature Group",
        },
      });
      await repo.commit({
        message: "Second grouped commit",
        trailers: {
          "Taspr-Commit-Id": "grp00002",
          "Taspr-Group": "group-abc",
          "Taspr-Group-Title": "Feature Group",
        },
      });
      // Add a standalone commit outside the group
      await repo.commit({
        message: "Standalone commit",
        trailers: { "Taspr-Commit-Id": "std00001" },
      });
    },
  },

  /**
   * Stack with a split group (non-contiguous commits with same Taspr-Group).
   * For testing sync validation blocking.
   */
  splitGroup: {
    name: "split-group",
    description: "Stack with split group (for sync validation testing)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      // First commit in group
      await repo.commit({
        message: "First grouped commit",
        trailers: {
          "Taspr-Commit-Id": "spl00001",
          "Taspr-Group": "group-split",
          "Taspr-Group-Title": "Split Group",
        },
      });
      // Interrupting commit (not in group)
      await repo.commit({
        message: "Interrupting commit",
        trailers: { "Taspr-Commit-Id": "spl00002" },
      });
      // Second commit in same group (non-contiguous = split)
      await repo.commit({
        message: "Second grouped commit",
        trailers: {
          "Taspr-Commit-Id": "spl00003",
          "Taspr-Group": "group-split",
          "Taspr-Group-Title": "Split Group",
        },
      });
    },
  },

  /**
   * Stack with inconsistent group titles (same Taspr-Group but different Taspr-Group-Title).
   * For testing sync validation blocking.
   */
  inconsistentGroupTitle: {
    name: "inconsistent-group-title",
    description: "Stack with inconsistent group titles (for sync validation testing)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      await repo.commit({
        message: "First grouped commit",
        trailers: {
          "Taspr-Commit-Id": "inc00001",
          "Taspr-Group": "group-inconsistent",
          "Taspr-Group-Title": "Title A",
        },
      });
      await repo.commit({
        message: "Second grouped commit with different title",
        trailers: {
          "Taspr-Commit-Id": "inc00002",
          "Taspr-Group": "group-inconsistent",
          "Taspr-Group-Title": "Title B", // Different title = error
        },
      });
    },
  },

  /**
   * Mixed stack with ungrouped commits, a multi-commit group, and a single-commit group.
   * For testing and styling the view command's group display.
   */
  mixedGroupStack: {
    name: "mixed-group-stack",
    description: "Mixed stack: ungrouped commits + multi-commit group + single-commit group",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");

      // 1. Ungrouped commit at the base
      await repo.commit({
        message: "Add initial utils",
        trailers: { "Taspr-Commit-Id": "mix00001" },
      });

      // 2. Multi-commit group (3 commits - all have both trailers)
      await repo.commit({
        message: "Add user authentication",
        trailers: {
          "Taspr-Commit-Id": "mix00002",
          "Taspr-Group": "group-auth",
          "Taspr-Group-Title": "User Authentication",
        },
      });
      await repo.commit({
        message: "Add login form component",
        trailers: {
          "Taspr-Commit-Id": "mix00003",
          "Taspr-Group": "group-auth",
          "Taspr-Group-Title": "User Authentication",
        },
      });
      await repo.commit({
        message: "Add session management",
        trailers: {
          "Taspr-Commit-Id": "mix00004",
          "Taspr-Group": "group-auth",
          "Taspr-Group-Title": "User Authentication",
        },
      });

      // 3. Another ungrouped commit
      await repo.commit({
        message: "Fix typo in readme",
        trailers: { "Taspr-Commit-Id": "mix00005" },
      });

      // 4. Single-commit group
      await repo.commit({
        message: "Add dark mode support",
        trailers: {
          "Taspr-Commit-Id": "mix00006",
          "Taspr-Group": "group-dark",
          "Taspr-Group-Title": "Dark Mode",
        },
      });

      // 5. Ungrouped commit at the top
      await repo.commit({
        message: "Update dependencies",
        trailers: { "Taspr-Commit-Id": "mix00007" },
      });
    },
  },
  /**
   * Scenario that creates a file mid-stack, then removes and ignores it, then
   * recreates it as untracked. Traditional git rebase --exec fails with
   * "untracked working tree files would be overwritten" but plumbing rebase succeeds.
   *
   * This is a regression test for the plumbing-based git operations.
   *
   * The sequence:
   * - Commit 1: anything (no tracked.json)
   * - Commit 2: add tracked.json file
   * - Commit 3: anything
   * - Commit 4: rm tracked.json from tracking and add to .gitignore
   * - Commit 5: anything (also recreate tracked.json as untracked)
   * - Commit 6: anything
   *
   * The key: tracked.json is CREATED in commit 2, which is mid-stack.
   * When rebase tries to replay commit 2, it fails because tracked.json
   * already exists as an untracked file in the working directory.
   */
  untrackedAfterIgnored: {
    name: "untracked-after-ignored",
    description: "File added mid-stack then ignored (traditional rebase fails, plumbing succeeds)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");

      // Commit 1: anything
      await Bun.write(join(repo.path, "file1.txt"), "content 1\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "commit 1"`.quiet();

      // Commit 2: add tracked.json (the key file)
      await Bun.write(join(repo.path, "tracked.json"), '{"tracked": true}\n');
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "commit 2 - add tracked.json"`.quiet();

      // Commit 3: anything
      await Bun.write(join(repo.path, "file3.txt"), "content 3\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "commit 3"`.quiet();

      // Commit 4: remove tracked.json from tracking and ignore it
      await $`git -C ${repo.path} rm --cached tracked.json`.quiet();
      await Bun.write(join(repo.path, ".gitignore"), "tracked.json\n");
      await $`git -C ${repo.path} add .gitignore`.quiet();
      await $`git -C ${repo.path} commit -m "commit 4 - remove and ignore tracked.json"`.quiet();

      // Commit 5: anything, but also re-create tracked.json (untracked now)
      await Bun.write(join(repo.path, "file5.txt"), "content 5\n");
      await Bun.write(join(repo.path, "tracked.json"), '{"untracked": true, "local": "data"}\n');
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "commit 5"`.quiet();

      // Commit 6: anything
      await Bun.write(join(repo.path, "file6.txt"), "content 6\n");
      await $`git -C ${repo.path} add .`.quiet();
      await $`git -C ${repo.path} commit -m "commit 6"`.quiet();
    },
  },
} satisfies Record<string, ScenarioDefinition>;

/**
 * Array of all scenarios for the interactive menu.
 */
export const scenarioList: ScenarioDefinition[] = Object.values(scenarios);
