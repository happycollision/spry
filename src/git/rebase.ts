import { $ } from "bun";
import { join } from "node:path";
import type { GitOptions } from "./commands.ts";
import { getStackCommits, getStackCommitsWithTrailers, getCurrentBranch } from "./commands.ts";
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
} from "./plumbing.ts";

export interface InjectIdsResult {
  /** Number of commits that were modified */
  modifiedCount: number;
  /** Whether a rebase was performed */
  rebasePerformed: boolean;
}

/**
 * Inject Taspr-Commit-Id trailers into commits that don't have them.
 * Uses git plumbing commands (no working directory modifications).
 *
 * @returns Information about the operation
 */
export async function injectMissingIds(options: GitOptions = {}): Promise<InjectIdsResult> {
  // Get commits with trailers parsed
  const commits = await getStackCommitsWithTrailers(options);

  // Find commits without IDs
  const needsId = commits.filter((c) => !c.trailers["Taspr-Commit-Id"]);

  if (needsId.length === 0) {
    return { modifiedCount: 0, rebasePerformed: false };
  }

  // Build the rewrites map: original hash -> new message with ID
  const rewrites = new Map<string, string>();
  for (const commit of needsId) {
    const newId = generateCommitId();
    const originalMessage = await getCommitMessage(commit.hash, options);
    const newMessage = await addTrailers(originalMessage, { "Taspr-Commit-Id": newId });
    rewrites.set(commit.hash, newMessage);
  }

  // Get all commit hashes in order for the chain rewrite
  const allHashes = commits.map((c) => c.hash);

  // Get current branch and tip for finalization
  const branch = await getCurrentBranch(options);
  const oldTip = asserted(allHashes.at(-1));

  // Rewrite the commit chain using plumbing
  const result = await rewriteCommitChain(allHashes, rewrites, options);

  // Finalize: update branch ref and reset if needed (won't reset for message-only changes)
  await finalizeRewrite(branch, oldTip, result.newTip, options);

  return { modifiedCount: needsId.length, rebasePerformed: true };
}

/**
 * Check if all commits in the stack have Taspr-Commit-Id trailers.
 */
export async function allCommitsHaveIds(options: GitOptions = {}): Promise<boolean> {
  const commits = await getStackCommitsWithTrailers(options);

  if (commits.length === 0) {
    return true;
  }

  return commits.every((c) => c.trailers["Taspr-Commit-Id"]);
}

/**
 * Get the count of commits that are missing Taspr-Commit-Id trailers.
 */
export async function countCommitsMissingIds(options: GitOptions = {}): Promise<number> {
  const commits = await getStackCommitsWithTrailers(options);
  return commits.filter((c) => !c.trailers["Taspr-Commit-Id"]).length;
}

export interface RebaseResult {
  /** Whether the rebase completed successfully */
  success: boolean;
  /** Number of commits that were rebased */
  commitCount: number;
  /** If there was a conflict, the first conflicting file */
  conflictFile?: string;
}

/**
 * Rebase the current stack onto the latest origin/main.
 * Uses git plumbing when possible, falling back to traditional
 * rebase on conflict for user conflict resolution.
 *
 * @returns Result indicating success or conflict details
 */
export async function rebaseOntoMain(options: GitOptions = {}): Promise<RebaseResult> {
  const { cwd } = options;
  const defaultBranchRef = await getDefaultBranchRef();

  // Count commits in stack before rebase
  const commits = await getStackCommits(options);
  const commitCount = commits.length;

  if (commitCount === 0) {
    return { success: true, commitCount: 0 };
  }

  // Get the target to rebase onto
  const onto = await getFullSha(defaultBranchRef, options);

  // Get commit hashes in order
  const commitHashes = commits.map((c) => c.hash);

  // Try plumbing rebase first
  const result = await rebasePlumbing(onto, commitHashes, options);

  if (result.ok) {
    // Success! Finalize the rewrite
    const branch = await getCurrentBranch(options);
    const oldTip = asserted(commitHashes.at(-1));
    await finalizeRewrite(branch, oldTip, result.newTip, options);
    return { success: true, commitCount };
  }

  // Plumbing rebase detected a conflict
  // Fall back to traditional rebase so user can resolve conflicts interactively
  // Use --no-autosquash to prevent fixup!/amend! commits from being auto-reordered
  // Use --no-verify to skip pre-commit and commit-msg hooks during rebase
  const traditionalResult = cwd
    ? await $`git -C ${cwd} rebase --no-autosquash --no-verify ${defaultBranchRef}`
        .quiet()
        .nothrow()
    : await $`git rebase --no-autosquash --no-verify ${defaultBranchRef}`.quiet().nothrow();

  if (traditionalResult.exitCode === 0) {
    return { success: true, commitCount };
  }

  // Check for conflict - look for unmerged files
  const statusResult = cwd
    ? await $`git -C ${cwd} status --porcelain`.text()
    : await $`git status --porcelain`.text();

  // UU = both modified (conflict), AA = both added, etc.
  const conflictMatch = statusResult.match(/^(?:UU|AA|DD|AU|UA|DU|UD) (.+)$/m);

  if (conflictMatch?.[1]) {
    return {
      success: false,
      commitCount,
      conflictFile: conflictMatch[1],
    };
  }

  // Unknown failure - throw with stderr
  throw new Error(`Rebase failed: ${traditionalResult.stderr.toString()}`);
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
  4. taspr sync

To abort:
  git rebase --abort`;
}
