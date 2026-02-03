import { $ } from "bun";
import type { CommitInfo } from "../types.ts";
import { parseTrailers } from "./trailers.ts";
import type { CommitWithTrailers } from "../core/stack.ts";
import { getDefaultBranchRef, getSpryConfig } from "./config.ts";

/**
 * Information about a Spry-tracked local branch.
 */
export interface SpryBranchInfo {
  /** Branch name (without refs/heads/) */
  name: string;
  /** Branch tip SHA */
  tipSha: string;
  /** Number of commits in stack (between branch and origin/main) */
  commitCount: number;
  /** Whether branch is checked out in a worktree */
  inWorktree: boolean;
  /** Path to worktree if checked out */
  worktreePath?: string;
  /** Whether any commits in stack are missing Spry-Commit-Id (needs ID injection) */
  hasMissingIds: boolean;
}

export interface GitOptions {
  cwd?: string;
}

/**
 * Get the merge-base between HEAD and the default branch.
 * This is the commit where the current branch diverged from the default branch.
 */
export async function getMergeBase(options: GitOptions = {}): Promise<string> {
  const { cwd } = options;
  const defaultBranchRef = await getDefaultBranchRef();

  try {
    const result = cwd
      ? await $`git -C ${cwd} merge-base HEAD ${defaultBranchRef}`.text()
      : await $`git merge-base HEAD ${defaultBranchRef}`.text();
    return result.trim();
  } catch {
    // Check if the default branch exists on origin
    const remoteCheck = cwd
      ? await $`git -C ${cwd} rev-parse --verify ${defaultBranchRef} 2>/dev/null`.nothrow()
      : await $`git rev-parse --verify ${defaultBranchRef} 2>/dev/null`.nothrow();
    if (remoteCheck.exitCode !== 0) {
      const config = await getSpryConfig();
      throw new Error(
        `No ${defaultBranchRef} branch found. Please ensure you have a remote named '${config.remote}' with a '${config.defaultBranch}' branch, or set a different default branch with: git config spry.defaultBranch <branch>`,
      );
    }
    throw new Error(`Failed to find merge-base with ${defaultBranchRef}`);
  }
}

/**
 * Parse git log output into CommitInfo objects.
 * Shared between getStackCommits() and getStackCommitsForBranch().
 */
function parseCommitLog(result: string): CommitInfo[] {
  if (!result.trim()) {
    return [];
  }

  const commits: CommitInfo[] = [];

  // Split by record separator and filter empty entries
  const records = result.split("\x01").filter((r) => r.trim());

  for (const record of records) {
    const [hashRaw, subject, body] = record.split("\x00");
    if (hashRaw && subject !== undefined && body !== undefined) {
      commits.push({
        hash: hashRaw.trim(),
        subject,
        body,
        trailers: {}, // Trailers will be parsed by the trailers module
      });
    }
  }

  return commits;
}

/**
 * Get all commits in the stack (between merge-base and HEAD).
 * Returns commits in oldest-to-newest order (bottom of stack first).
 */
export async function getStackCommits(options: GitOptions = {}): Promise<CommitInfo[]> {
  const { cwd } = options;
  const mergeBase = await getMergeBase(options);

  // Get commits with null-byte separators for reliable parsing
  // %H = hash, %s = subject, %B = full body (includes subject)
  // Using %x00 for null bytes between fields, %x01 as record separator
  const result = cwd
    ? await $`git -C ${cwd} log --reverse --format=%H%x00%s%x00%B%x01 ${mergeBase}..HEAD`.text()
    : await $`git log --reverse --format=%H%x00%s%x00%B%x01 ${mergeBase}..HEAD`.text();

  return parseCommitLog(result);
}

/**
 * Get commits between origin/main and a specific branch.
 * Unlike getStackCommits(), this works on any branch, not just HEAD.
 * Returns commits in oldest-to-newest order (bottom of stack first).
 */
export async function getStackCommitsForBranch(
  branch: string,
  options: GitOptions = {},
): Promise<CommitInfo[]> {
  const defaultBranchRef = await getDefaultBranchRef(options);
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} log --reverse --format=%H%x00%s%x00%B%x01 ${defaultBranchRef}..${branch}`.text()
    : await $`git log --reverse --format=%H%x00%s%x00%B%x01 ${defaultBranchRef}..${branch}`.text();

  return parseCommitLog(result);
}

/**
 * Check if there are uncommitted changes in the working tree.
 */
export async function hasUncommittedChanges(options: GitOptions = {}): Promise<boolean> {
  const { cwd } = options;
  const result = cwd
    ? await $`git -C ${cwd} status --porcelain`.text()
    : await $`git status --porcelain`.text();
  return result.trim().length > 0;
}

/**
 * Get the current branch name.
 * Returns "HEAD" if in detached HEAD state.
 */
export async function getCurrentBranch(options: GitOptions = {}): Promise<string> {
  const { cwd } = options;
  const result = cwd
    ? await $`git -C ${cwd} rev-parse --abbrev-ref HEAD`.text()
    : await $`git rev-parse --abbrev-ref HEAD`.text();
  return result.trim();
}

/**
 * Check if the repository is in detached HEAD state.
 */
export async function isDetachedHead(options: GitOptions = {}): Promise<boolean> {
  const branch = await getCurrentBranch(options);
  return branch === "HEAD";
}

/**
 * Assert that we are not in detached HEAD state.
 * Throws a helpful error if we are.
 */
export async function assertNotDetachedHead(options: GitOptions = {}): Promise<void> {
  if (await isDetachedHead(options)) {
    throw new Error(
      "Cannot perform this operation in detached HEAD state.\n" +
        "Please checkout a branch first: git checkout <branch-name>\n" +
        "Or create a new branch: git checkout -b <new-branch-name>",
    );
  }
}

/**
 * Get all commits in the stack with their trailers parsed.
 * Returns commits in oldest-to-newest order (bottom of stack first).
 *
 * @param options.branch - Optional branch name. If provided, gets commits for that branch instead of HEAD.
 */
export async function getStackCommitsWithTrailers(
  options: GitOptions & { branch?: string } = {},
): Promise<CommitWithTrailers[]> {
  const { branch, ...gitOptions } = options;

  // Get commits for specified branch or HEAD
  const commits = branch
    ? await getStackCommitsForBranch(branch, gitOptions)
    : await getStackCommits(gitOptions);

  const commitsWithTrailers: CommitWithTrailers[] = await Promise.all(
    commits.map(async (commit) => {
      const trailers = await parseTrailers(commit.body);
      return {
        ...commit,
        trailers,
      };
    }),
  );

  return commitsWithTrailers;
}

/**
 * Check if a branch is checked out in any worktree.
 *
 * This is important for operations that use `git update-ref` to update a branch.
 * If a branch is checked out in another worktree, updating its ref via plumbing
 * commands will leave that worktree's working directory out of sync (dirty state).
 *
 * @param branch - Branch name (without refs/heads/ prefix)
 * @returns true if the branch is checked out in any worktree
 */
export async function isBranchCheckedOutInWorktree(
  branch: string,
  options: GitOptions = {},
): Promise<boolean> {
  const { cwd } = options;

  // Use `git worktree list --porcelain` to get all worktrees
  const result = cwd
    ? await $`git -C ${cwd} worktree list --porcelain`.text()
    : await $`git worktree list --porcelain`.text();

  const output = result.trim();
  if (!output) return false;

  const targetRef = `refs/heads/${branch}`;
  const entries = output.split("\n\n");

  for (const entry of entries) {
    const lines = entry.split("\n");
    for (const line of lines) {
      if (line.startsWith("branch ") && line.slice("branch ".length) === targetRef) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Result of checking if a branch is in a worktree.
 */
export interface WorktreeCheckResult {
  /** Whether the branch is checked out in any worktree */
  checkedOut: boolean;
  /** Path to the worktree (if checked out) */
  worktreePath?: string;
}

/**
 * Check if a branch is checked out in any worktree and return its path.
 *
 * @param branch - Branch name (without refs/heads/ prefix)
 * @returns Object with checkedOut boolean and optional worktreePath
 */
export async function getBranchWorktree(
  branch: string,
  options: GitOptions = {},
): Promise<WorktreeCheckResult> {
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} worktree list --porcelain`.text()
    : await $`git worktree list --porcelain`.text();

  const output = result.trim();
  if (!output) return { checkedOut: false };

  const targetRef = `refs/heads/${branch}`;
  const entries = output.split("\n\n");

  for (const entry of entries) {
    const lines = entry.split("\n");
    let worktreePath = "";
    let branchRef = "";

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        branchRef = line.slice("branch ".length);
      }
    }

    if (branchRef === targetRef && worktreePath) {
      return { checkedOut: true, worktreePath };
    }
  }

  return { checkedOut: false };
}

/**
 * List all local branches that have Spry-tracked commits.
 * A branch is Spry-tracked if it has commits with Spry-Commit-Id trailers
 * between the branch tip and origin/main.
 */
export async function listSpryLocalBranches(options: GitOptions = {}): Promise<SpryBranchInfo[]> {
  const { cwd } = options;

  // Get the default branch ref (e.g., "origin/main")
  const defaultBranchRef = await getDefaultBranchRef(options);

  // Get all local branches with their tip SHAs
  // Note: Format string must be quoted to prevent shell interpretation of parentheses
  const format = "%(refname:short) %(objectname)";
  const branchListResult = cwd
    ? await $`git -C ${cwd} for-each-ref --format=${format} refs/heads/`.text()
    : await $`git for-each-ref --format=${format} refs/heads/`.text();

  const branches: Array<{ name: string; tipSha: string }> = [];
  for (const line of branchListResult.trim().split("\n")) {
    if (!line.trim()) continue;
    const [name, tipSha] = line.trim().split(" ");
    if (name && tipSha) {
      branches.push({ name, tipSha });
    }
  }

  // Get the default branch name (without origin/) to exclude it
  const config = await getSpryConfig(options);
  const defaultBranchName = config.defaultBranch;

  const spryBranches: SpryBranchInfo[] = [];

  for (const { name, tipSha } of branches) {
    // Skip the default branch
    if (name === defaultBranchName) continue;

    // Check if this branch has any commits above the default branch
    const countResult = cwd
      ? await $`git -C ${cwd} rev-list --count ${defaultBranchRef}..${name}`.text()
      : await $`git rev-list --count ${defaultBranchRef}..${name}`.text();

    const commitCount = parseInt(countResult.trim(), 10);
    if (commitCount === 0) continue;

    // Get the commits on this branch (between default branch and tip)
    // Check if any have Spry-Commit-Id trailers
    const logResult = cwd
      ? await $`git -C ${cwd} log --format=%H%x00%B%x01 ${defaultBranchRef}..${name}`.text()
      : await $`git log --format=%H%x00%B%x01 ${defaultBranchRef}..${name}`.text();

    if (!logResult.trim()) continue;

    const records = logResult.split("\x01").filter((r) => r.trim());
    let hasSpryCommit = false;
    let hasMissingIds = false;

    for (const record of records) {
      const [_hash, body] = record.split("\x00");
      if (body !== undefined) {
        const trailers = await parseTrailers(body);
        if (trailers["Spry-Commit-Id"]) {
          hasSpryCommit = true;
        } else {
          hasMissingIds = true;
        }
      }
    }

    // Only include branches that have at least one Spry commit
    if (!hasSpryCommit) continue;

    // Check if branch is in a worktree
    const worktreeInfo = await getBranchWorktree(name, options);

    spryBranches.push({
      name,
      tipSha,
      commitCount,
      inWorktree: worktreeInfo.checkedOut,
      worktreePath: worktreeInfo.worktreePath,
      hasMissingIds,
    });
  }

  return spryBranches;
}
