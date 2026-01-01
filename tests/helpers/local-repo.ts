/**
 * Composable test primitives for taspr integration tests.
 *
 * Provides `repoManager()` for local-only repos (bare origin) and
 * `repoManager({ github: true })` for GitHub integration tests.
 */

import { $ } from "bun";
import { beforeAll, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createGitHubFixture, type GitHubFixture } from "./github-fixture.ts";
import { generateUniqueId } from "./unique-id.ts";

/** Mutable container for the current test's unique ID */
interface TestContext {
  uniqueId: string;
}

// ============================================================================
// Base repo interface (shared by both local and GitHub repos)
// ============================================================================

/** Options for creating a commit */
export interface CommitOptions {
  /** Optional commit message (auto-generated if not provided) */
  message?: string;
  /** Git trailers to add to the commit */
  trailers?: Record<string, string>;
}

interface BaseRepo {
  path: string;
  /** Unique identifier for this test run */
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

  /** Clean up the repo */
  cleanup(): Promise<void>;
}

// ============================================================================
// Shared repo methods factory
// ============================================================================

interface RepoMethodsConfig {
  path: string;
  ctx: TestContext;
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
      const filename = `file-${ctx.uniqueId}-${fileCounter++}.txt`;
      const message = options?.message ?? `commit-${fileCounter}`;
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
      const message = options?.message ?? `commit-${fileCounter++}`;
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

// ============================================================================
// Local-only repo (no GitHub)
// ============================================================================

export interface LocalRepo extends BaseRepo {
  originPath: string;
  /** Update origin/main with a new commit (simulates another developer's work) */
  updateOriginMain(message: string, files?: Record<string, string>): Promise<void>;
}

/**
 * Create a local git repo with a bare origin (no GitHub).
 */
async function createLocalRepo(ctx: TestContext): Promise<LocalRepo> {
  // Create the "origin" bare repository first
  const originPath = await mkdtemp(join(tmpdir(), "taspr-test-origin-"));
  await $`git init --bare ${originPath}`.quiet();

  // Create the working repository
  const path = await mkdtemp(join(tmpdir(), "taspr-test-"));
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

// ============================================================================
// GitHub repo (with PR support)
// ============================================================================

export interface GitHubRepo extends BaseRepo {
  github: GitHubFixture;

  /** Find PR by title substring */
  findPR(titleSubstring: string): Promise<{ number: number; title: string; headRefName: string }>;

  /** Find all PRs matching title */
  findPRs(
    titleSubstring: string,
  ): Promise<Array<{ number: number; title: string; headRefName: string }>>;

  /** Wait for branch to be deleted (handles GitHub eventual consistency) */
  waitForBranchGone(branchName: string, timeoutMs?: number): Promise<boolean>;
}

/**
 * Clone a GitHub repo and return a GitHubRepo with helpers.
 */
async function cloneGitHubRepo(github: GitHubFixture, ctx: TestContext): Promise<GitHubRepo> {
  const tmpResult = await $`mktemp -d`.text();
  const path = tmpResult.trim();

  await $`git clone ${github.repoUrl}.git ${path}`.quiet();
  await $`git -C ${path} config user.email "test@example.com"`.quiet();
  await $`git -C ${path} config user.name "Test User"`.quiet();

  const methods = createRepoMethods({
    path,
    ctx,
    cleanupFn: async () => {
      await rm(path, { recursive: true, force: true });
    },
  });

  async function findPRsImpl(
    titleSubstring: string,
  ): Promise<Array<{ number: number; title: string; headRefName: string }>> {
    const prList =
      await $`gh pr list --repo ${github.owner}/${github.repo} --state all --json number,title,headRefName`.text();
    const prs = JSON.parse(prList) as Array<{
      number: number;
      title: string;
      headRefName: string;
    }>;
    return prs.filter((p) => p.title.includes(titleSubstring));
  }

  return {
    path,
    github,
    ...methods,

    async findPR(
      titleSubstring: string,
    ): Promise<{ number: number; title: string; headRefName: string }> {
      const prs = await findPRsImpl(titleSubstring);
      const pr = prs[0];
      if (!pr) {
        throw new Error(`PR not found with title containing: ${titleSubstring}`);
      }
      return pr;
    },

    async findPRs(
      titleSubstring: string,
    ): Promise<Array<{ number: number; title: string; headRefName: string }>> {
      return findPRsImpl(titleSubstring);
    },

    async waitForBranchGone(branchName: string, timeoutMs = 5000): Promise<boolean> {
      const pollInterval = 500;
      const maxAttempts = Math.ceil(timeoutMs / pollInterval);

      for (let i = 0; i < maxAttempts; i++) {
        await Bun.sleep(pollInterval);
        const check =
          await $`gh api repos/${github.owner}/${github.repo}/branches/${branchName}`.nothrow();
        if (check.exitCode !== 0) {
          return true;
        }
      }
      return false;
    },
  };
}

// ============================================================================
// Repo managers (with function overloads for type safety)
// ============================================================================

export interface LocalRepoManager {
  /** Create a local repo with bare origin */
  create(): Promise<LocalRepo>;
  /** Clean up all repos */
  cleanup(): Promise<void>;
  /** Current test's unique ID */
  readonly uniqueId: string;
}

export interface GitHubRepoManager {
  /** Clone the GitHub test repo */
  clone(): Promise<GitHubRepo>;
  /** Clean up all repos */
  cleanup(): Promise<void>;
  /** The GitHub fixture */
  readonly github: GitHubFixture;
  /** Current test's unique ID */
  readonly uniqueId: string;
}

/**
 * Create a repo manager for local-only tests (bare origin, no GitHub).
 * Automatically sets up beforeEach/afterEach hooks for cleanup.
 *
 * Usage:
 *   const repos = repoManager();
 *
 *   test("...", async () => {
 *     const repo = await repos.create();
 *     await repo.commit();
 *     await repo.updateOriginMain("Upstream change");
 *   });
 */
export function repoManager(): LocalRepoManager;

/**
 * Create a repo manager for GitHub integration tests.
 * Automatically sets up beforeAll/beforeEach/afterEach hooks.
 *
 * Usage:
 *   const repos = repoManager({ github: true });
 *
 *   test("...", async () => {
 *     const repo = await repos.clone();
 *     await repo.commit();
 *     const pr = await repo.findPR(repo.uniqueId);
 *   });
 */
export function repoManager(options: { github: true }): GitHubRepoManager;

export function repoManager(options?: { github?: boolean }): LocalRepoManager | GitHubRepoManager {
  const ctx: TestContext = { uniqueId: generateUniqueId() };

  if (options?.github) {
    const activeRepos: GitHubRepo[] = [];
    let githubFixture: GitHubFixture | null = null;

    beforeAll(async () => {
      githubFixture = await createGitHubFixture();
    });

    beforeEach(async () => {
      ctx.uniqueId = generateUniqueId();
      await githubFixture?.reset();
    });

    afterEach(async () => {
      await githubFixture?.reset();
      for (const repo of activeRepos) {
        await repo.cleanup();
      }
      activeRepos.length = 0;
    });

    return {
      async clone(): Promise<GitHubRepo> {
        if (!githubFixture) {
          throw new Error("GitHub fixture not initialized - beforeAll hasn't run yet");
        }
        const repo = await cloneGitHubRepo(githubFixture, ctx);
        activeRepos.push(repo);
        return repo;
      },

      async cleanup(): Promise<void> {
        for (const repo of activeRepos) {
          await repo.cleanup();
        }
        activeRepos.length = 0;
      },

      get github(): GitHubFixture {
        if (!githubFixture) {
          throw new Error("GitHub fixture not initialized - beforeAll hasn't run yet");
        }
        return githubFixture;
      },

      get uniqueId(): string {
        return ctx.uniqueId;
      },
    };
  }

  // Local-only repos
  const activeRepos: LocalRepo[] = [];

  beforeEach(() => {
    ctx.uniqueId = generateUniqueId();
  });

  afterEach(async () => {
    for (const repo of activeRepos) {
      await repo.cleanup();
    }
    activeRepos.length = 0;
  });

  return {
    async create(): Promise<LocalRepo> {
      const repo = await createLocalRepo(ctx);
      activeRepos.push(repo);
      return repo;
    },

    async cleanup(): Promise<void> {
      for (const repo of activeRepos) {
        await repo.cleanup();
      }
      activeRepos.length = 0;
    },

    get uniqueId(): string {
      return ctx.uniqueId;
    },
  };
}
