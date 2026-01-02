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
 * - `unclosedGroup` - Stack with unclosed group (for sync validation testing)
 * - `overlappingGroups` - Stack with overlapping groups (for sync validation testing)
 * - `orphanGroupEnd` - Stack with orphan group end (for sync validation testing)
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
      // Create a group of 2 commits
      await repo.commit({
        message: "First grouped commit",
        trailers: {
          "Taspr-Commit-Id": "grp00001",
          "Taspr-Group-Start": "group-abc",
          "Taspr-Group-Title": "Feature Group",
        },
      });
      await repo.commit({
        message: "Second grouped commit",
        trailers: {
          "Taspr-Commit-Id": "grp00002",
          "Taspr-Group-End": "group-abc",
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
   * Stack with an unclosed group (Taspr-Group-Start but no Taspr-Group-End).
   * For testing sync validation blocking.
   */
  unclosedGroup: {
    name: "unclosed-group",
    description: "Stack with unclosed group (for sync validation testing)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      // Create a group start without matching end
      await repo.commit({
        message: "First grouped commit",
        trailers: {
          "Taspr-Commit-Id": "unc00001",
          "Taspr-Group-Start": "group-incomplete",
          "Taspr-Group-Title": "Incomplete Group",
        },
      });
      await repo.commit({
        message: "Second commit (missing group end)",
        trailers: { "Taspr-Commit-Id": "unc00002" },
      });
    },
  },

  /**
   * Stack with overlapping groups (nested Taspr-Group-Start trailers).
   * For testing sync validation blocking.
   */
  overlappingGroups: {
    name: "overlapping-groups",
    description: "Stack with overlapping groups (for sync validation testing)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      // Start first group
      await repo.commit({
        message: "Start first group",
        trailers: {
          "Taspr-Commit-Id": "ovr00001",
          "Taspr-Group-Start": "group-outer",
          "Taspr-Group-Title": "Outer Group",
        },
      });
      // Start second group inside first (invalid)
      await repo.commit({
        message: "Start second group (overlapping)",
        trailers: {
          "Taspr-Commit-Id": "ovr00002",
          "Taspr-Group-Start": "group-inner",
          "Taspr-Group-Title": "Inner Group",
        },
      });
      await repo.commit({
        message: "Third commit",
        trailers: {
          "Taspr-Commit-Id": "ovr00003",
          "Taspr-Group-End": "group-inner",
        },
      });
    },
  },

  /**
   * Stack with an orphan group end (Taspr-Group-End but no matching Taspr-Group-Start).
   * For testing sync validation blocking and interactive repair.
   */
  orphanGroupEnd: {
    name: "orphan-group-end",
    description: "Stack with orphan group end (for sync validation testing)",
    setup: async (repo: LocalRepo) => {
      await repo.branch("feature");
      // Regular commit without group trailers
      await repo.commit({
        message: "First commit (no group)",
        trailers: { "Taspr-Commit-Id": "orp00001" },
      });
      // Commit with group end but no matching start
      await repo.commit({
        message: "Second commit (orphan group end)",
        trailers: {
          "Taspr-Commit-Id": "orp00002",
          "Taspr-Group-End": "group-orphan",
        },
      });
      // Another regular commit
      await repo.commit({
        message: "Third commit",
        trailers: { "Taspr-Commit-Id": "orp00003" },
      });
    },
  },
} satisfies Record<string, ScenarioDefinition>;

/**
 * Array of all scenarios for the interactive menu.
 */
export const scenarioList: ScenarioDefinition[] = Object.values(scenarios);
