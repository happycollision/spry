/**
 * Utilities for detecting existing PRs when grouping commits.
 */

import { findPRByBranch, type PRInfo } from "../github/pr.ts";
import { getBranchName, type BranchNameConfig } from "../github/branches.ts";

export interface CommitWithPR {
  /** Commit hash */
  hash: string;
  /** Spry-Commit-Id from trailer */
  commitId: string;
  /** Commit subject */
  subject: string;
  /** PR info if an open PR exists */
  pr: PRInfo;
  /** Branch name for the PR */
  branchName: string;
}

/**
 * Detect which commits have existing open PRs.
 *
 * @param commits - Array of {hash, commitId, subject} for commits being grouped
 * @param branchConfig - Branch name configuration
 * @returns Array of commits that have open PRs
 */
export async function detectExistingPRs(
  commits: Array<{ hash: string; commitId: string; subject: string }>,
  branchConfig: BranchNameConfig,
): Promise<CommitWithPR[]> {
  const results: CommitWithPR[] = [];

  for (const commit of commits) {
    if (!commit.commitId) {
      continue; // No commit ID means no branch/PR exists
    }

    const branchName = getBranchName(commit.commitId, branchConfig);
    const pr = await findPRByBranch(branchName);

    if (pr?.state === "OPEN") {
      results.push({
        hash: commit.hash,
        commitId: commit.commitId,
        subject: commit.subject,
        pr,
        branchName,
      });
    }
  }

  return results;
}
