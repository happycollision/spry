import { $ } from "bun";
import type { GitOptions } from "./commands.ts";
import { getDefaultBranchRef, getSpryConfig } from "./config.ts";

export interface LocalMainStatus {
  /** Whether local main is behind remote */
  isBehind: boolean;
  /** Number of commits behind */
  commitsBehind: number;
  /** Whether local main can be fast-forwarded (no local commits ahead) */
  canFastForward: boolean;
  /** Number of commits local main is ahead (if any) */
  commitsAhead: number;
}

/**
 * Check the status of local main relative to remote main.
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

/**
 * Fast-forward the local main branch to match remote main.
 * Does NOT checkout main - updates the ref directly.
 * Only succeeds if local main is strictly behind remote (no divergence).
 *
 * @returns true if fast-forward was performed, false if already up-to-date
 * @throws Error if local main has diverged and cannot be fast-forwarded
 */
export async function fastForwardLocalMain(options: GitOptions = {}): Promise<boolean> {
  const { cwd } = options;
  const config = await getSpryConfig();
  const localMain = config.defaultBranch;
  const remoteMain = `${config.remote}/${config.defaultBranch}`;

  const status = await getLocalMainStatus(options);

  if (!status.isBehind) {
    return false; // Already up-to-date
  }

  if (!status.canFastForward) {
    throw new Error(
      `Cannot fast-forward local '${localMain}': it has ${status.commitsAhead} local commit(s) not on ${remoteMain}.\n` +
        `This may indicate unpushed changes on your local ${localMain} branch.`,
    );
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

  return true;
}

/**
 * Check if the stack is behind the default branch on the remote.
 * Returns true if there are commits on remote/defaultBranch that aren't in the current branch.
 */
export async function isStackBehindMain(options: GitOptions = {}): Promise<boolean> {
  const { cwd } = options;
  const config = await getSpryConfig();
  const defaultBranchRef = await getDefaultBranchRef();

  // Fetch latest from remote
  const fetchCmd = cwd
    ? $`git -C ${cwd} fetch ${config.remote}`.quiet().nothrow()
    : $`git fetch ${config.remote}`.quiet().nothrow();
  await fetchCmd;

  // Count commits that are on origin/main but not on HEAD
  const result = cwd
    ? await $`git -C ${cwd} rev-list HEAD..${defaultBranchRef} --count`.text()
    : await $`git rev-list HEAD..${defaultBranchRef} --count`.text();

  return parseInt(result.trim(), 10) > 0;
}

/**
 * Get the number of commits the stack is behind the remote default branch.
 * Does NOT fetch - call isStackBehindMain() first if you need fresh data.
 */
export async function getCommitsBehind(options: GitOptions = {}): Promise<number> {
  const { cwd } = options;
  const defaultBranchRef = await getDefaultBranchRef();

  const result = cwd
    ? await $`git -C ${cwd} rev-list HEAD..${defaultBranchRef} --count`.text()
    : await $`git rev-list HEAD..${defaultBranchRef} --count`.text();

  return parseInt(result.trim(), 10);
}
