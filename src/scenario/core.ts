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
 * - Initial commit on main, pushed to origin
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
import { mkdtemp, rm } from "node:fs/promises";
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
}

/** A local git repository with a bare origin */
export interface LocalRepo {
  /** Path to the working repository */
  path: string;
  /** Path to the bare origin repository */
  originPath: string;
  /** Unique identifier for this scenario/test run */
  readonly uniqueId: string;

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

  /** Update origin/main with a new commit (simulates another developer's work) */
  updateOriginMain(message: string, files?: Record<string, string>): Promise<void>;

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
}

function createRepoMethods(config: RepoMethodsConfig) {
  const { path, ctx, cleanupFn } = config;
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
      await $`git -C ${path} fetch origin`.quiet();
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

  // Create the "origin" bare repository first
  const originPath = await mkdtemp(join(tmpdir(), "spry-test-origin-"));
  await $`git init --bare ${originPath}`.quiet();

  // Create the working repository
  const path = await mkdtemp(join(tmpdir(), "spry-test-"));
  await $`git init ${path}`.quiet();
  await $`git -C ${path} config user.email "test@example.com"`.quiet();
  await $`git -C ${path} config user.name "Test User"`.quiet();

  // Add origin remote pointing to the bare repo
  await $`git -C ${path} remote add origin ${originPath}`.quiet();

  // Create initial commit on main
  const readmePath = join(path, "README.md");
  await Bun.write(readmePath, "# Test Repo\n");
  await $`git -C ${path} add .`.quiet();
  await $`git -C ${path} commit -m "Initial commit"`.quiet();

  // Push main to origin so origin/main exists
  await $`git -C ${path} push -u origin main`.quiet();

  const methods = createRepoMethods({
    path,
    ctx,
    cleanupFn: async () => {
      await rm(path, { recursive: true, force: true });
      await rm(originPath, { recursive: true, force: true });
    },
  });

  return {
    path,
    originPath,
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
          const filename = `main-update-${Date.now()}.txt`;
          await Bun.write(join(tempWorktree, filename), `Update: ${message}\n`);
        }

        await $`git -C ${tempWorktree} add .`.quiet();
        await $`git -C ${tempWorktree} commit -m ${message}`.quiet();
        await $`git -C ${tempWorktree} push origin main`.quiet();
      } finally {
        await rm(tempWorktree, { recursive: true, force: true });
      }
    },
  };
}
