import { $ } from "bun";
import type { GitOptions } from "./commands.ts";
import { getCurrentBranch } from "./commands.ts";
import { getDefaultBranchRef, getSpryConfig } from "./config.ts";

/**
 * Status of the local default branch relative to the remote.
 * "Main" in the name refers to the configured default branch (main, master, develop, etc.)
 */
export interface LocalMainStatus {
  /** Whether local default branch is behind remote */
  isBehind: boolean;
  /** Number of commits behind */
  commitsBehind: number;
  /** Whether local default branch can be fast-forwarded (no local commits ahead) */
  canFastForward: boolean;
  /** Number of commits local default branch is ahead (if any) */
  commitsAhead: number;
}

/**
 * Check the status of the local default branch relative to the remote.
 * "Main" in the function name refers to the configured default branch (main, master, develop, etc.)
 *
 * Does NOT fetch - caller should fetch first if fresh data is needed.
 */
export async function getLocalMainStatus(options: GitOptions = {}): Promise<LocalMainStatus> {
  const { cwd } = options;
  const config = await getSpryConfig();
  const localMain = config.defaultBranch;
  const remoteMain = `${config.remote}/${config.defaultBranch}`;

  // Check if local main exists
  const localMainExists = cwd
    ? await $`git -C ${cwd} rev-parse --verify refs/heads/${localMain}`.quiet().nothrow()
    : await $`git rev-parse --verify refs/heads/${localMain}`.quiet().nothrow();

  if (localMainExists.exitCode !== 0) {
    // Local main doesn't exist - nothing to fast-forward
    return { isBehind: false, commitsBehind: 0, canFastForward: false, commitsAhead: 0 };
  }

  // Count commits that are on remote but not on local (behind)
  const behindResult = cwd
    ? await $`git -C ${cwd} rev-list ${localMain}..${remoteMain} --count`.text()
    : await $`git rev-list ${localMain}..${remoteMain} --count`.text();
  const commitsBehind = parseInt(behindResult.trim(), 10);

  // Count commits that are on local but not on remote (ahead)
  const aheadResult = cwd
    ? await $`git -C ${cwd} rev-list ${remoteMain}..${localMain} --count`.text()
    : await $`git rev-list ${remoteMain}..${localMain} --count`.text();
  const commitsAhead = parseInt(aheadResult.trim(), 10);

  return {
    isBehind: commitsBehind > 0,
    commitsBehind,
    canFastForward: commitsBehind > 0 && commitsAhead === 0,
    commitsAhead,
  };
}

export interface FastForwardResult {
  /** Whether fast-forward was performed */
  performed: boolean;
  /** Reason for skipping (if not performed) */
  skippedReason?: "up-to-date" | "on-main-branch" | "diverged";
}

/**
 * Fast-forward the local default branch to match the remote.
 * "Main" in the function name refers to the configured default branch (main, master, develop, etc.)
 *
 * Does NOT checkout the branch - updates the ref directly.
 * Only succeeds if local is strictly behind remote (no divergence).
 *
 * Skips (returns performed: false) when:
 * - Already up-to-date
 * - Currently on the default branch (would desync worktree)
 * - Local has diverged (has local commits not on remote)
 *
 * @returns Result indicating whether fast-forward was performed and why it was skipped
 */
export async function fastForwardLocalMain(options: GitOptions = {}): Promise<FastForwardResult> {
  const { cwd } = options;
  const config = await getSpryConfig();
  const localMain = config.defaultBranch;
  const remoteMain = `${config.remote}/${config.defaultBranch}`;

  // Skip if currently on main branch - updating ref would desync with worktree
  const currentBranch = await getCurrentBranch(options);
  if (currentBranch === localMain) {
    return { performed: false, skippedReason: "on-main-branch" };
  }

  const status = await getLocalMainStatus(options);

  if (!status.isBehind) {
    return { performed: false, skippedReason: "up-to-date" };
  }

  if (!status.canFastForward) {
    return { performed: false, skippedReason: "diverged" };
  }

  // Get the SHA of the remote main
  const remoteSha = cwd
    ? (await $`git -C ${cwd} rev-parse ${remoteMain}`.text()).trim()
    : (await $`git rev-parse ${remoteMain}`.text()).trim();

  // Update the local main ref directly (no checkout needed)
  if (cwd) {
    await $`git -C ${cwd} update-ref refs/heads/${localMain} ${remoteSha}`.quiet();
  } else {
    await $`git update-ref refs/heads/${localMain} ${remoteSha}`.quiet();
  }

  return { performed: true };
}

/**
 * Fetch latest refs from the configured remote.
 * Call this before checking if stack is behind to ensure fresh data.
 */
export async function fetchRemote(options: GitOptions = {}): Promise<void> {
  const { cwd } = options;
  const config = await getSpryConfig();

  const fetchCmd = cwd
    ? $`git -C ${cwd} fetch ${config.remote}`.quiet().nothrow()
    : $`git fetch ${config.remote}`.quiet().nothrow();
  await fetchCmd;
}

/**
 * Check if the stack is behind the default branch on the remote.
 * "Main" in the function name refers to the configured default branch (main, master, develop, etc.)
 *
 * Returns true if there are commits on remote/defaultBranch that aren't in the current branch.
 *
 * NOTE: This checks against cached remote refs. Call fetchRemote() first if you need fresh data.
 */
export async function isStackBehindMain(options: GitOptions = {}): Promise<boolean> {
  const { cwd } = options;
  const defaultBranchRef = await getDefaultBranchRef();

  // Count commits that are on remote default branch but not on HEAD
  const result = cwd
    ? await $`git -C ${cwd} rev-list HEAD..${defaultBranchRef} --count`.text()
    : await $`git rev-list HEAD..${defaultBranchRef} --count`.text();

  return parseInt(result.trim(), 10) > 0;
}

/**
 * Get the number of commits the stack is behind the remote default branch.
 * Does NOT fetch - call fetchRemote() first if you need fresh data.
 */
export async function getCommitsBehind(options: GitOptions = {}): Promise<number> {
  const { cwd } = options;
  const defaultBranchRef = await getDefaultBranchRef();

  const result = cwd
    ? await $`git -C ${cwd} rev-list HEAD..${defaultBranchRef} --count`.text()
    : await $`git rev-list HEAD..${defaultBranchRef} --count`.text();

  return parseInt(result.trim(), 10);
}
