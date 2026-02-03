import { $ } from "bun";
import { join } from "node:path";
import type { GitOptions } from "./commands.ts";
import {
  getStackCommits,
  getStackCommitsWithTrailers,
  getStackCommitsForBranch,
  getCurrentBranch,
  isDetachedHead,
  getBranchWorktree,
} from "./commands.ts";
import { getDefaultBranchRef } from "./config.ts";
import { generateCommitId } from "../core/id.ts";
import { addTrailers } from "./trailers.ts";
import { asserted } from "../utils/assert.ts";
import {
  getCommitMessage,
  rewriteCommitChain,
  finalizeRewrite,
  rebasePlumbing,
  getFullSha,
  updateRef,
} from "./plumbing.ts";
import { parseConflictOutput } from "./conflict-predict.ts";

/**
 * Result of injecting missing IDs into commits.
 */
export type InjectIdsResult =
  | { ok: true; modifiedCount: number; rebasePerformed: boolean }
  | { ok: false; reason: "detached-head" };

/**
 * Inject Spry-Commit-Id trailers into commits that don't have them.
 * Uses git plumbing commands (no working directory modifications).
 *
 * @param options.branch - Optional branch name. If provided, operates on that branch instead of current.
 * @returns Result indicating success with modification count, or failure with reason
 */
export async function injectMissingIds(
  options: GitOptions & { branch?: string } = {},
): Promise<InjectIdsResult> {
  const { branch: branchParam, ...gitOptions } = options;
  const branch = branchParam ?? (await getCurrentBranch(gitOptions));

  // Check for detached HEAD
  if (!branchParam) {
    // Operating on current branch - check current worktree
    const detached = await isDetachedHead(gitOptions);
    if (detached) {
      return { ok: false, reason: "detached-head" };
    }
  } else {
    // Operating on specific branch - check if it's in a worktree with detached HEAD
    const worktreeInfo = await getBranchWorktree(branch, gitOptions);
    if (worktreeInfo.checkedOut && worktreeInfo.worktreePath) {
      const detached = await isDetachedHead({ cwd: worktreeInfo.worktreePath });
      if (detached) {
        return { ok: false, reason: "detached-head" };
      }
    }
  }

  // Get commits with trailers parsed (branch-aware)
  const commits = await getStackCommitsWithTrailers({ ...gitOptions, branch });

  // Find commits without IDs
  const needsId = commits.filter((c) => !c.trailers["Spry-Commit-Id"]);

  if (needsId.length === 0) {
    return { ok: true, modifiedCount: 0, rebasePerformed: false };
  }

  // Build the rewrites map: original hash -> new message with ID
  const rewrites = new Map<string, string>();
  for (const commit of needsId) {
    const newId = generateCommitId();
    const originalMessage = await getCommitMessage(commit.hash, gitOptions);
    const newMessage = await addTrailers(originalMessage, { "Spry-Commit-Id": newId });
    rewrites.set(commit.hash, newMessage);
  }

  // Get all commit hashes in order for the chain rewrite
  const allHashes = commits.map((c) => c.hash);
  const oldTip = asserted(allHashes.at(-1));

  // Rewrite the commit chain using plumbing
  const result = await rewriteCommitChain(allHashes, rewrites, gitOptions);

  // Finalize based on context
  if (branchParam) {
    // Non-current branch: just update ref
    await updateRef(`refs/heads/${branch}`, result.newTip, oldTip, gitOptions);

    // If in worktree, also update working directory
    const worktreeInfo = await getBranchWorktree(branch, gitOptions);
    if (worktreeInfo.checkedOut && worktreeInfo.worktreePath) {
      await $`git -C ${worktreeInfo.worktreePath} reset --hard ${result.newTip}`.quiet();
    }
  } else {
    // Current branch: use finalizeRewrite
    await finalizeRewrite(branch, oldTip, result.newTip, gitOptions);
  }

  return { ok: true, modifiedCount: needsId.length, rebasePerformed: true };
}

/**
 * Check if all commits in the stack have Spry-Commit-Id trailers.
 */
export async function allCommitsHaveIds(options: GitOptions = {}): Promise<boolean> {
  const commits = await getStackCommitsWithTrailers(options);

  if (commits.length === 0) {
    return true;
  }

  return commits.every((c) => c.trailers["Spry-Commit-Id"]);
}

/**
 * Get the count of commits that are missing Spry-Commit-Id trailers.
 */
export async function countCommitsMissingIds(options: GitOptions = {}): Promise<number> {
  const commits = await getStackCommitsWithTrailers(options);
  return commits.filter((c) => !c.trailers["Spry-Commit-Id"]).length;
}

/**
 * Result of a rebase operation.
 */
export type RebaseResult =
  | { ok: true; commitCount: number; newTip: string }
  | { ok: false; reason: "detached-head" | "conflict"; conflictFile?: string };

export interface RebaseConflictPrediction {
  /** Whether the rebase would succeed without conflicts */
  wouldSucceed: boolean;
  /** Number of commits that would be rebased */
  commitCount: number;
  /** If there would be a conflict, info about it */
  conflictInfo?: {
    /** The commit hash that would conflict */
    commitHash: string;
    /** Files involved in the conflict */
    files: string[];
  };
}

/**
 * Check if rebasing onto the remote default branch would cause conflicts.
 *
 * Uses git merge-tree to test the rebase without modifying refs or working directory.
 * May create orphaned commit objects on success path, but these are harmless and
 * will be cleaned up by git gc.
 *
 * @param options.branch - Optional branch name. If provided, checks that branch instead of HEAD.
 * @param options.onto - Optional target to rebase onto. Defaults to origin/main.
 * @returns Prediction of whether rebase would succeed
 */
export async function predictRebaseConflicts(
  options: GitOptions & { branch?: string; onto?: string } = {},
): Promise<RebaseConflictPrediction> {
  const { branch, onto: ontoParam, ...gitOptions } = options;
  const onto = ontoParam ?? (await getDefaultBranchRef());

  // Get commits for specified branch or HEAD
  const commits = branch
    ? await getStackCommitsForBranch(branch, gitOptions)
    : await getStackCommits(gitOptions);

  const commitCount = commits.length;

  if (commitCount === 0) {
    return { wouldSucceed: true, commitCount: 0 };
  }

  // Get the target SHA
  const ontoSha = await getFullSha(onto, gitOptions);

  // Get commit hashes in order
  const commitHashes = commits.map((c) => c.hash);

  // rebasePlumbing creates git objects but doesn't update refs or working directory.
  // If it detects a conflict, it returns early without any side effects.
  // On success, orphaned commit objects are created but harmless (gc will clean them).
  const result = await rebasePlumbing(ontoSha, commitHashes, gitOptions);

  if (result.ok) {
    return { wouldSucceed: true, commitCount };
  }

  // Would conflict - parse conflict info to extract file names
  const { files } = parseConflictOutput(result.conflictInfo ?? "");

  return {
    wouldSucceed: false,
    commitCount,
    conflictInfo: {
      commitHash: result.conflictCommit,
      files,
    },
  };
}

/**
 * Rebase a stack onto the latest remote default branch.
 * "Main" in the function name refers to the configured default branch (main, master, develop, etc.)
 *
 * Uses git plumbing when possible, falling back to traditional
 * rebase on conflict for user conflict resolution (current branch only).
 *
 * @param options.branch - Optional branch name. If provided, rebases that branch instead of current.
 * @param options.onto - Optional target to rebase onto. Defaults to origin/main.
 * @param options.worktreePath - Optional worktree path if the branch is checked out in a worktree.
 * @returns Result indicating success with new tip, or failure with reason
 */
export async function rebaseOntoMain(
  options: GitOptions & {
    branch?: string;
    onto?: string;
    worktreePath?: string;
  } = {},
): Promise<RebaseResult> {
  const { branch: branchParam, onto: ontoParam, worktreePath, ...gitOptions } = options;
  const { cwd } = gitOptions;
  const branch = branchParam ?? (await getCurrentBranch(gitOptions));
  const onto = ontoParam ?? (await getDefaultBranchRef());

  // Check for detached HEAD
  if (!branchParam) {
    const detached = await isDetachedHead(gitOptions);
    if (detached) {
      return { ok: false, reason: "detached-head" };
    }
  } else if (worktreePath) {
    const detached = await isDetachedHead({ cwd: worktreePath });
    if (detached) {
      return { ok: false, reason: "detached-head" };
    }
  }

  // Get commits for specified branch or HEAD
  const commits = branchParam
    ? await getStackCommitsForBranch(branch, gitOptions)
    : await getStackCommits(gitOptions);

  const commitCount = commits.length;

  if (commitCount === 0) {
    const currentTip = await getFullSha(branch, gitOptions);
    return { ok: true, commitCount: 0, newTip: currentTip };
  }

  // Get the target SHA
  const ontoSha = await getFullSha(onto, gitOptions);
  const commitHashes = commits.map((c) => c.hash);

  // Try plumbing rebase
  const result = await rebasePlumbing(ontoSha, commitHashes, gitOptions);

  if (!result.ok) {
    // For non-current branches, we don't fall back to traditional rebase
    // Just report the conflict
    if (branchParam) {
      const { files } = parseConflictOutput(result.conflictInfo ?? "");
      return { ok: false, reason: "conflict", conflictFile: files[0] };
    }

    // For current branch, fall back to traditional rebase for user resolution
    const traditionalResult = cwd
      ? await $`git -C ${cwd} rebase --no-autosquash --no-verify ${onto}`.quiet().nothrow()
      : await $`git rebase --no-autosquash --no-verify ${onto}`.quiet().nothrow();

    if (traditionalResult.exitCode === 0) {
      const newTip = await getFullSha("HEAD", gitOptions);
      return { ok: true, commitCount, newTip };
    }

    // Check for conflict file
    const statusResult = cwd
      ? await $`git -C ${cwd} status --porcelain`.text()
      : await $`git status --porcelain`.text();

    const conflictMatch = statusResult.match(/^(?:UU|AA|DD|AU|UA|DU|UD) (.+)$/m);

    return {
      ok: false,
      reason: "conflict",
      conflictFile: conflictMatch?.[1],
    };
  }

  // Success - finalize
  const oldTip = asserted(commitHashes.at(-1));

  if (worktreePath) {
    // Branch in worktree: update ref + reset worktree
    await updateRef(`refs/heads/${branch}`, result.newTip, oldTip, gitOptions);
    await $`git -C ${worktreePath} reset --hard ${result.newTip}`.quiet();
  } else if (branchParam) {
    // Non-current branch: just update ref
    await updateRef(`refs/heads/${branch}`, result.newTip, oldTip, gitOptions);
  } else {
    // Current branch: use finalizeRewrite
    await finalizeRewrite(branch, oldTip, result.newTip, gitOptions);
  }

  return { ok: true, commitCount, newTip: result.newTip };
}

export interface ConflictInfo {
  /** Files with conflicts */
  files: string[];
  /** Short SHA of the commit being applied */
  currentCommit: string;
  /** Subject line of the commit being applied */
  currentSubject: string;
}

/**
 * Check if we're in the middle of a rebase with conflicts.
 * Returns conflict information if in a conflicted state, null otherwise.
 */
export async function getConflictInfo(options: GitOptions = {}): Promise<ConflictInfo | null> {
  const { cwd } = options;

  // Check if we're in a rebase by looking for rebase-merge or rebase-apply directory
  // git rev-parse --git-path returns paths relative to the repo root
  const rebaseMergeResult = cwd
    ? await $`git -C ${cwd} rev-parse --git-path rebase-merge`.text()
    : await $`git rev-parse --git-path rebase-merge`.text();

  const rebaseApplyResult = cwd
    ? await $`git -C ${cwd} rev-parse --git-path rebase-apply`.text()
    : await $`git rev-parse --git-path rebase-apply`.text();

  // The paths are relative to the repo, so we need to join with cwd if provided
  const rebaseMergePath = cwd ? join(cwd, rebaseMergeResult.trim()) : rebaseMergeResult.trim();
  const rebaseApplyPath = cwd ? join(cwd, rebaseApplyResult.trim()) : rebaseApplyResult.trim();

  // Use stat to check if directories exist (Bun.file().exists() doesn't work for directories)
  const { stat } = await import("node:fs/promises");

  let rebaseMergeExists = false;
  let rebaseApplyExists = false;

  try {
    await stat(rebaseMergePath);
    rebaseMergeExists = true;
  } catch {
    // Directory doesn't exist
  }

  try {
    await stat(rebaseApplyPath);
    rebaseApplyExists = true;
  } catch {
    // Directory doesn't exist
  }

  if (!rebaseMergeExists && !rebaseApplyExists) {
    return null;
  }

  // Get conflicting files from git status
  const statusResult = cwd
    ? await $`git -C ${cwd} status --porcelain`.text()
    : await $`git status --porcelain`.text();

  const conflicts = statusResult
    .split("\n")
    .filter((line) => /^(?:UU|AA|DD|AU|UA|DU|UD) /.test(line))
    .map((line) => line.slice(3));

  // Get the commit being applied (REBASE_HEAD)
  const rebaseHeadResult = cwd
    ? await $`git -C ${cwd} rev-parse REBASE_HEAD`.quiet().nothrow()
    : await $`git rev-parse REBASE_HEAD`.quiet().nothrow();

  let currentCommit = "unknown";
  let currentSubject = "unknown";

  if (rebaseHeadResult.exitCode === 0) {
    currentCommit = rebaseHeadResult.stdout.toString().trim().slice(0, 8);

    const subjectResult = cwd
      ? await $`git -C ${cwd} log -1 --format=%s REBASE_HEAD`.text()
      : await $`git log -1 --format=%s REBASE_HEAD`.text();
    currentSubject = subjectResult.trim();
  }

  return {
    files: conflicts,
    currentCommit,
    currentSubject,
  };
}

/**
 * Format conflict information into a user-friendly error message.
 */
export function formatConflictError(info: ConflictInfo): string {
  const fileList = info.files.map((f) => `  • ${f}`).join("\n");

  return `✗ Rebase conflict while applying commit ${info.currentCommit}
  "${info.currentSubject}"

Conflicting files:
${fileList}

To resolve:
  1. Edit the conflicting files
  2. git add <fixed files>
  3. git rebase --continue
  4. sp sync

To abort:
  git rebase --abort`;
}
