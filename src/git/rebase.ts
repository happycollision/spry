import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink, chmod, writeFile } from "node:fs/promises";
import type { GitOptions } from "./commands.ts";
import { getMergeBase, getStackCommits, getStackCommitsWithTrailers } from "./commands.ts";
import { getDefaultBranchRef } from "./config.ts";

export interface InjectIdsResult {
  /** Number of commits that were modified */
  modifiedCount: number;
  /** Whether a rebase was performed */
  rebasePerformed: boolean;
}

/**
 * Create a shell script that adds Taspr-Commit-Id to commits that don't have one.
 * This script is used with `git rebase --exec`.
 */
function createIdInjectionScript(): string {
  return `#!/bin/bash
set -e

# Check if commit already has Taspr-Commit-Id
if git log -1 --format=%B | grep -q "^Taspr-Commit-Id:"; then
  exit 0
fi

# Generate new ID and add trailer
NEW_ID=$(openssl rand -hex 4)
NEW_MSG=$(git log -1 --format=%B | git interpret-trailers --trailer "Taspr-Commit-Id: $NEW_ID")
git commit --amend --no-edit -m "$NEW_MSG"
`;
}

/**
 * Inject Taspr-Commit-Id trailers into commits that don't have them.
 * Uses git rebase with --exec to add IDs non-interactively.
 *
 * @returns Information about the operation
 */
export async function injectMissingIds(options: GitOptions = {}): Promise<InjectIdsResult> {
  const { cwd } = options;

  // Get commits with trailers parsed
  const commits = await getStackCommitsWithTrailers(options);

  // Find commits without IDs
  const needsId = commits.filter((c) => !c.trailers["Taspr-Commit-Id"]);

  if (needsId.length === 0) {
    return { modifiedCount: 0, rebasePerformed: false };
  }

  // Get merge base for rebase
  const mergeBase = await getMergeBase(options);

  // Create temporary script
  const scriptPath = join(tmpdir(), `taspr-inject-id-${Date.now()}.sh`);
  const script = createIdInjectionScript();

  try {
    await writeFile(scriptPath, script);
    await chmod(scriptPath, "755");

    // Run rebase with --exec
    // GIT_SEQUENCE_EDITOR=true prevents the editor from opening
    const result = cwd
      ? await $`GIT_SEQUENCE_EDITOR=true git -C ${cwd} rebase -i --exec ${scriptPath} ${mergeBase}`
          .quiet()
          .nothrow()
      : await $`GIT_SEQUENCE_EDITOR=true git rebase -i --exec ${scriptPath} ${mergeBase}`
          .quiet()
          .nothrow();

    if (result.exitCode !== 0) {
      throw new Error(`Rebase failed: ${result.stderr.toString()}`);
    }

    return { modifiedCount: needsId.length, rebasePerformed: true };
  } finally {
    // Clean up script
    try {
      await unlink(scriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }
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
 * This preserves commit messages (including Taspr trailers).
 *
 * @returns Result indicating success or conflict details
 */
export async function rebaseOntoMain(options: GitOptions = {}): Promise<RebaseResult> {
  const { cwd } = options;
  const defaultBranchRef = await getDefaultBranchRef();

  // Count commits in stack before rebase
  const commits = await getStackCommits(options);
  const commitCount = commits.length;

  // Attempt rebase
  const result = cwd
    ? await $`git -C ${cwd} rebase ${defaultBranchRef}`.quiet().nothrow()
    : await $`git rebase ${defaultBranchRef}`.quiet().nothrow();

  if (result.exitCode === 0) {
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
  throw new Error(`Rebase failed: ${result.stderr.toString()}`);
}
