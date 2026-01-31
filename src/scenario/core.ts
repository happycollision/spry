/**
 * Core scenario infrastructure for creating temporary git repositories.
 *
 * This module provides the foundational repo creation logic without any
 * test framework dependencies, making it reusable by both tests and the
 * interactive scenario runner.
 *
 * ## Key exports
 * - `createLocalRepo(ctx, options)` - Creates a temp repo with bare origin
 * - `LocalRepo` - Interface for repo operations (commit, branch, fetch, etc.)
 *
 * ## What it creates
 * - A bare "origin" repo in /tmp/spry-test-origin-*
 * - A working clone in /tmp/spry-test-*
 * - Initial commit on default branch (configurable, defaults to "main"), pushed to origin
 * - Git config with test user identity
 *
 * ## Usage
 * ```ts
 * import { createLocalRepo } from "./core.ts";
 * import { generateUniqueId } from "../../tests/helpers/unique-id.ts";
 *
 * const repo = await createLocalRepo({ uniqueId: generateUniqueId() });
 * await repo.branch("feature");
 * await repo.commit({ message: "Add feature" });
 * await repo.cleanup();
 * ```
 *
 * ## Related
 * - `src/scenario/definitions.ts` - Pre-built scenarios using this module
 * - `tests/helpers/local-repo.ts` - Test wrapper with bun:test hooks
 */

import { $ } from "bun";
import { join } from "node:path";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";

// ============================================================================
// Types
// ============================================================================

/** Context for scenario/test isolation */
export interface ScenarioContext {
  uniqueId: string;
  scenarioName?: string;
}

/** Options for creating a commit */
export interface CommitOptions {
  /** Optional commit message (auto-generated if not provided) */
  message?: string;
  /** Git trailers to add to the commit */
  trailers?: Record<string, string>;
}

/** Options for creating a repo */
export interface CreateRepoOptions {
  /** Short name for this scenario/test, used as prefix in commit messages */
  scenarioName?: string;
  /** Default branch name (default: "main") */
  defaultBranch?: string;
  /** Remote name (default: "origin") */
  remoteName?: string;
}

/** Information about a git worktree */
export interface WorktreeInfo {
  /** Path to the worktree */
  path: string;
  /** Branch checked out in this worktree (empty string if detached HEAD) */
  branch: string;
  /** HEAD commit SHA */
  head: string;
  /** Whether this is the main worktree */
  isMain: boolean;
}

/** A local git repository with a bare origin */
export interface LocalRepo {
  /** Path to the working repository */
  path: string;
  /** Path to the bare origin repository */
  originPath: string;
  /** Unique identifier for this scenario/test run */
  readonly uniqueId: string;
  /** Default branch name (e.g., "main", "master", "develop") */
  readonly defaultBranch: string;
  /** Remote name (e.g., "origin", "upstream") */
  readonly remoteName: string;

  /** Create a commit with auto-generated file */
  commit(options?: CommitOptions): Promise<string>;

  /** Create a commit with specific files */
  commitFiles(files: Record<string, string>, options?: CommitOptions): Promise<string>;

  /** Create a new branch and switch to it. Automatically made unique. */
  branch(name: string): Promise<string>;

  /** Checkout an existing branch */
  checkout(name: string): Promise<void>;

  /** Fetch from origin */
  fetch(): Promise<void>;

  /** Get current branch name */
  currentBranch(): Promise<string>;

  /** Update origin's default branch with a new commit (simulates another developer's work) */
  updateOriginMain(message: string, files?: Record<string, string>): Promise<void>;

  /** Create a worktree for an existing branch */
  createWorktree(branch: string, worktreePath?: string): Promise<WorktreeInfo>;

  /** List all worktrees for this repository */
  listWorktrees(): Promise<WorktreeInfo[]>;

  /** Remove a worktree */
  removeWorktree(worktreePath: string): Promise<void>;

  /** Clean up the repo (removes both working and origin directories) */
  cleanup(): Promise<void>;
}

// ============================================================================
// Implementation
// ============================================================================

interface RepoMethodsConfig {
  path: string;
  ctx: ScenarioContext;
  cleanupFn: () => Promise<void>;
  remoteName?: string;
}

function createRepoMethods(config: RepoMethodsConfig) {
  const { path, ctx, cleanupFn, remoteName = "origin" } = config;
  let fileCounter = 0;

  return {
    get uniqueId() {
      return ctx.uniqueId;
    },

    async commit(options?: CommitOptions): Promise<string> {
      fileCounter++;
      const filename = `file-${ctx.uniqueId}-${fileCounter}.txt`;
      const prefix = ctx.scenarioName ?? "commit";
      const message = options?.message ?? `${prefix} ${fileCounter}`;
      let fullMessage = `${message} [${ctx.uniqueId}]`;
      if (options?.trailers) {
        fullMessage += "\n\n";
        for (const [key, value] of Object.entries(options.trailers)) {
          fullMessage += `${key}: ${value}\n`;
        }
      }
      await Bun.write(join(path, filename), `Content for: ${message}\n`);
      await $`git -C ${path} add .`.quiet();
      await $`git -C ${path} commit -m ${fullMessage}`.quiet();
      return (await $`git -C ${path} rev-parse HEAD`.text()).trim();
    },

    async commitFiles(files: Record<string, string>, options?: CommitOptions): Promise<string> {
      for (const [filename, content] of Object.entries(files)) {
        await Bun.write(join(path, filename), content);
      }
      fileCounter++;
      const prefix = ctx.scenarioName ?? "commit";
      const message = options?.message ?? `${prefix} ${fileCounter}`;
      let fullMessage = `${message} [${ctx.uniqueId}]`;
      if (options?.trailers) {
        fullMessage += "\n\n";
        for (const [key, value] of Object.entries(options.trailers)) {
          fullMessage += `${key}: ${value}\n`;
        }
      }
      await $`git -C ${path} add .`.quiet();
      await $`git -C ${path} commit -m ${fullMessage}`.quiet();
      return (await $`git -C ${path} rev-parse HEAD`.text()).trim();
    },

    async branch(name: string): Promise<string> {
      const branchName = `${name}-${ctx.uniqueId}`;
      await $`git -C ${path} checkout -b ${branchName}`.quiet();
      return branchName;
    },

    async checkout(name: string): Promise<void> {
      await $`git -C ${path} checkout ${name}`.quiet();
    },

    async fetch(): Promise<void> {
      await $`git -C ${path} fetch ${remoteName}`.quiet();
    },

    async currentBranch(): Promise<string> {
      return (await $`git -C ${path} rev-parse --abbrev-ref HEAD`.text()).trim();
    },

    cleanup: cleanupFn,
  };
}

/**
 * Create a local git repo with a bare origin.
 *
 * This is the core function for creating test/scenario repositories.
 * It has no test framework dependencies and can be used anywhere.
 */
export async function createLocalRepo(
  ctx: ScenarioContext,
  options?: CreateRepoOptions,
): Promise<LocalRepo> {
  // Set scenarioName on context if provided
  if (options?.scenarioName) {
    ctx.scenarioName = options.scenarioName;
  }

  const defaultBranch = options?.defaultBranch ?? "main";
  const remoteName = options?.remoteName ?? "origin";

  // Track worktree paths for cleanup
  const worktreePaths: string[] = [];

  // Create the "origin" bare repository first
  const originPath = await mkdtemp(join(tmpdir(), "spry-test-origin-"));
  await $`git init --bare ${originPath}`.quiet();
  // Set the default branch in the bare repo
  await $`git -C ${originPath} symbolic-ref HEAD refs/heads/${defaultBranch}`.quiet();

  // Create the working repository
  const path = await mkdtemp(join(tmpdir(), "spry-test-"));
  await $`git init --initial-branch=${defaultBranch} ${path}`.quiet();
  await $`git -C ${path} config user.email "test@example.com"`.quiet();
  await $`git -C ${path} config user.name "Test User"`.quiet();

  // Add remote pointing to the bare repo
  await $`git -C ${path} remote add ${remoteName} ${originPath}`.quiet();

  // Create initial commit on default branch
  const readmePath = join(path, "README.md");
  await Bun.write(readmePath, "# Test Repo\n");
  await $`git -C ${path} add .`.quiet();
  await $`git -C ${path} commit -m "Initial commit"`.quiet();

  // Push to remote so <remoteName>/<defaultBranch> exists
  await $`git -C ${path} push -u ${remoteName} ${defaultBranch}`.quiet();

  const methods = createRepoMethods({
    path,
    ctx,
    remoteName,
    cleanupFn: async () => {
      // Remove worktrees first (must be done before removing main repo)
      for (const wtPath of worktreePaths) {
        await $`git -C ${path} worktree remove --force ${wtPath}`.quiet().nothrow();
        await rm(wtPath, { recursive: true, force: true });
      }
      await rm(path, { recursive: true, force: true });
      await rm(originPath, { recursive: true, force: true });
    },
  });

  /**
   * Parse `git worktree list --porcelain` output into WorktreeInfo objects.
   */
  async function parseWorktreeList(): Promise<WorktreeInfo[]> {
    const output = (await $`git -C ${path} worktree list --porcelain`.text()).trim();
    if (!output) return [];

    const worktrees: WorktreeInfo[] = [];
    const entries = output.split("\n\n");

    // Resolve the main repo path to handle symlinks (e.g., /tmp -> /private/tmp on macOS)
    const resolvedMainPath = await realpath(path);

    for (const entry of entries) {
      const lines = entry.split("\n");
      let wtPath = "";
      let head = "";
      let branch = "";
      let isMain = false;

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          wtPath = line.slice("worktree ".length);
          // Main worktree is the one at the repo path (compare resolved paths)
          try {
            const resolvedWtPath = await realpath(wtPath);
            isMain = resolvedWtPath === resolvedMainPath;
          } catch {
            // If realpath fails, fall back to direct comparison
            isMain = wtPath === path;
          }
        } else if (line.startsWith("HEAD ")) {
          head = line.slice("HEAD ".length);
        } else if (line.startsWith("branch ")) {
          // Branch is refs/heads/branchname, extract just the branch name
          branch = line.slice("branch refs/heads/".length);
        } else if (line === "detached") {
          branch = "";
        }
      }

      if (wtPath) {
        worktrees.push({ path: wtPath, head, branch, isMain });
      }
    }

    return worktrees;
  }

  return {
    path,
    originPath,
    defaultBranch,
    remoteName,
    ...methods,

    async updateOriginMain(message: string, files?: Record<string, string>): Promise<void> {
      const tempWorktree = `${originPath}-worktree-${Date.now()}`;
      try {
        await $`git clone ${originPath} ${tempWorktree}`.quiet();
        await $`git -C ${tempWorktree} config user.email "other@example.com"`.quiet();
        await $`git -C ${tempWorktree} config user.name "Other User"`.quiet();

        if (files) {
          for (const [filename, content] of Object.entries(files)) {
            await Bun.write(join(tempWorktree, filename), content);
          }
        } else {
          const filename = `${defaultBranch}-update-${Date.now()}.txt`;
          await Bun.write(join(tempWorktree, filename), `Update: ${message}\n`);
        }

        await $`git -C ${tempWorktree} add .`.quiet();
        await $`git -C ${tempWorktree} commit -m ${message}`.quiet();
        // Note: the cloned worktree always has "origin" as its remote
        await $`git -C ${tempWorktree} push origin ${defaultBranch}`.quiet();
      } finally {
        await rm(tempWorktree, { recursive: true, force: true });
      }
    },

    async createWorktree(branch: string, worktreePath?: string): Promise<WorktreeInfo> {
      const wtPath = worktreePath ?? (await mkdtemp(join(tmpdir(), "spry-test-worktree-")));
      worktreePaths.push(wtPath);

      await $`git -C ${path} worktree add ${wtPath} ${branch}`.quiet();

      // Get the HEAD of the new worktree
      const head = (await $`git -C ${wtPath} rev-parse HEAD`.text()).trim();

      return {
        path: wtPath,
        branch,
        head,
        isMain: false,
      };
    },

    async listWorktrees(): Promise<WorktreeInfo[]> {
      return parseWorktreeList();
    },

    async removeWorktree(worktreePath: string): Promise<void> {
      await $`git -C ${path} worktree remove --force ${worktreePath}`.quiet();
      const idx = worktreePaths.indexOf(worktreePath);
      if (idx !== -1) {
        worktreePaths.splice(idx, 1);
      }
    },
  };
}
