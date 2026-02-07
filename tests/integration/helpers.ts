import { $ } from "bun";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { GitHubFixture } from "../helpers/github-fixture.ts";
import {
  getSnapshotContext,
  nextSubprocessIndex,
  getSnapshotDir,
} from "../../src/github/snapshot-context.ts";
import { isGitHubIntegrationEnabled } from "../../src/github/service.ts";

// Skip these tests unless explicitly enabled
export const SKIP_GITHUB_TESTS = !process.env.GITHUB_INTEGRATION_TESTS;

// Skip CI-dependent tests unless explicitly enabled
export const SKIP_CI_TESTS = !process.env.GITHUB_CI_TESTS;

/** Standard result from running a sp (spry) command */
export interface SpryResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Extended result that includes the command that was executed */
export interface CommandResult extends SpryResult {
  /** The exact CLI invocation that was executed (e.g., "sp sync --open") */
  command: string;
}

// Helper to run sp (spry) commands in a directory
export async function runSpry(
  cwd: string,
  command: string,
  args: string[] = [],
): Promise<CommandResult> {
  // Build snapshot env vars for subprocess (if in snapshot test context)
  const snapshotEnv: Record<string, string> = {};
  const ctx = getSnapshotContext();
  if (ctx) {
    const mode = isGitHubIntegrationEnabled() ? "record" : "replay";
    const subprocessIdx = nextSubprocessIndex();
    snapshotEnv.SPRY_SNAPSHOT_MODE = mode;
    snapshotEnv.SPRY_SNAPSHOT_FILE = ctx.testFile;
    snapshotEnv.SPRY_SNAPSHOT_TEST = ctx.testName;
    snapshotEnv.SPRY_SNAPSHOT_TEST_ID = ctx.testId;
    snapshotEnv.SPRY_SNAPSHOT_SUBPROCESS = String(subprocessIdx);
    // Pass project root so subprocess can find snapshot files
    // (subprocess cwd is the test repo, not the project root)
    snapshotEnv.SPRY_SNAPSHOT_ROOT = getSnapshotDir().replace(/\/tests\/snapshots$/, "");
  }

  // Set SPRY_NO_TTY=1 to force non-interactive mode regardless of TTY status
  const env = { ...process.env, SPRY_NO_TTY: "1", ...snapshotEnv };
  const result =
    await $`bun run ${join(import.meta.dir, "../../src/cli/index.ts")} ${command} ${args}`
      .cwd(cwd)
      .env(env)
      .nothrow()
      .quiet();

  // Build the command string for logging/debugging
  const commandStr = args.length > 0 ? `sp ${command} ${args.join(" ")}` : `sp ${command}`;

  return {
    command: commandStr,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

// Helper to run sp sync in a directory
export async function runSync(
  cwd: string,
  options: { open?: boolean; allowUntitledPr?: boolean } = {},
): Promise<CommandResult> {
  const args: string[] = [];
  if (options.open) args.push("--open");
  if (options.allowUntitledPr) args.push("--allow-untitled-pr");
  return runSpry(cwd, "sync", args);
}

// Helper to run sp land in a directory
export async function runLand(
  cwd: string,
  options: { all?: boolean } = {},
): Promise<CommandResult> {
  const args = options.all ? ["--all"] : [];
  return runSpry(cwd, "land", args);
}

// Helper to run sp clean in a directory
export async function runClean(
  cwd: string,
  options: { dryRun?: boolean; force?: boolean; unsafe?: boolean } = {},
): Promise<CommandResult> {
  const args: string[] = [];
  if (options.dryRun) args.push("--dry-run");
  if (options.unsafe) args.push("--unsafe");
  if (options.force) args.push("--force");
  return runSpry(cwd, "clean", args);
}

// Helper to run sp view in a directory
export async function runView(
  cwd: string,
  options: { all?: boolean } = {},
): Promise<CommandResult> {
  const args = options.all ? ["--all"] : [];
  return runSpry(cwd, "view", args);
}

/**
 * Manages a local clone of a GitHub test repository for integration tests.
 * Handles setup and cleanup automatically.
 */
export interface LocalClone {
  /** Path to the local clone directory */
  path: string;
  /** Create a feature branch with optional commits */
  createFeatureBranch(
    name: string,
    commits: Array<{ message: string; files?: Record<string, string> }>,
  ): Promise<void>;
  /** Find a PR by title substring */
  findPR(titleSubstring: string): Promise<{ number: number; title: string; headRefName: string }>;
  /** Wait for remote branch deletion with polling (handles GitHub eventual consistency) */
  waitForBranchDeletion(branchName: string, options?: { timeout?: number }): Promise<boolean>;
  /** Clean up the local clone */
  cleanup(): Promise<void>;
}

/**
 * Create a local clone of a GitHub test repository.
 */
export async function createLocalClone(github: GitHubFixture): Promise<LocalClone> {
  const tmpResult = await $`mktemp -d`.text();
  const path = tmpResult.trim();

  await $`git clone ${github.repoUrl}.git ${path}`.quiet();
  await $`git -C ${path} config user.email "test@example.com"`.quiet();
  await $`git -C ${path} config user.name "Test User"`.quiet();

  async function createFeatureBranch(
    name: string,
    commits: Array<{ message: string; files?: Record<string, string> }>,
  ): Promise<void> {
    const uniqueId = Date.now().toString(36);
    const branchName = `feature/${name}-${uniqueId}`;
    await $`git -C ${path} checkout -b ${branchName}`.quiet();

    for (const commit of commits) {
      if (commit.files) {
        for (const [filename, content] of Object.entries(commit.files)) {
          await Bun.write(join(path, filename), content);
        }
      } else {
        // Create a unique file by default
        const filename = `${name}-${uniqueId}-${Date.now()}.txt`;
        await Bun.write(join(path, filename), `Content for: ${commit.message}\n`);
      }
      await $`git -C ${path} add .`.quiet();
      await $`git -C ${path} commit -m ${commit.message}`.quiet();
    }
  }

  async function findPR(
    titleSubstring: string,
  ): Promise<{ number: number; title: string; headRefName: string }> {
    const prList =
      await $`gh pr list --repo ${github.owner}/${github.repo} --state open --json number,title,headRefName`.text();
    const prs = JSON.parse(prList) as Array<{
      number: number;
      title: string;
      headRefName: string;
    }>;
    const pr = prs.find((p) => p.title.includes(titleSubstring));
    if (!pr) throw new Error(`PR not found with title containing: ${titleSubstring}`);
    return pr;
  }

  async function waitForBranchDeletion(
    branchName: string,
    options?: { timeout?: number },
  ): Promise<boolean> {
    const timeout = options?.timeout ?? 5000;
    const pollInterval = 500;
    const maxAttempts = Math.ceil(timeout / pollInterval);

    for (let i = 0; i < maxAttempts; i++) {
      await Bun.sleep(pollInterval);
      const check =
        await $`gh api repos/${github.owner}/${github.repo}/branches/${branchName}`.nothrow();
      if (check.exitCode !== 0) {
        return true;
      }
    }
    return false;
  }

  async function cleanup(): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  return { path, createFeatureBranch, findPR, waitForBranchDeletion, cleanup };
}

/**
 * Manages multiple local clones with automatic cleanup.
 * Usage:
 *   const clones = localCloneManager();
 *   afterEach(() => clones.cleanup());
 *
 *   test("...", async () => {
 *     const clone = await clones.create(github);
 *     // test code
 *   });
 */
export function localCloneManager() {
  const activeClones: LocalClone[] = [];

  return {
    async create(github: GitHubFixture): Promise<LocalClone> {
      const clone = await createLocalClone(github);
      activeClones.push(clone);
      return clone;
    },
    async cleanup(): Promise<void> {
      for (const clone of activeClones) {
        await clone.cleanup();
      }
      activeClones.length = 0;
    },
  };
}
