/**
 * Default GitHub Service Implementation.
 *
 * This is the production implementation that delegates to the existing
 * functions in api.ts and pr.ts. All GitHub operations go through the
 * gh CLI with rate limiting.
 */

import type { GitHubService } from "./service.ts";
import { getGitHubUsername } from "./api.ts";
import {
  findPRByBranch,
  findPRsByBranches,
  getPRChecksStatus,
  getPRReviewStatus,
  getPRCommentStatus,
  getPRMergeStatus,
  getPRState,
  getPRBody,
  getPRBaseBranch,
  createPR,
  retargetPR,
  updatePRBody,
  closePR,
  type CreatePROptions,
} from "./pr.ts";

/**
 * Create the default (production) GitHub service.
 * Delegates all operations to existing implementations.
 */
export function createDefaultGitHubService(): GitHubService {
  return {
    // User/Auth
    getUsername: () => getGitHubUsername(),

    // PR Queries
    findPRByBranch: (branch: string, options?: { includeAll?: boolean }) =>
      findPRByBranch(branch, options),

    findPRsByBranches: (branches: string[], options?: { includeAll?: boolean }) =>
      findPRsByBranches(branches, options),

    getPRChecksStatus: (prNumber: number, repo?: string) => getPRChecksStatus(prNumber, repo),

    getPRReviewStatus: (prNumber: number, repo?: string) => getPRReviewStatus(prNumber, repo),

    getPRCommentStatus: (prNumber: number, repo?: string) => getPRCommentStatus(prNumber, repo),

    getPRMergeStatus: (prNumber: number) => getPRMergeStatus(prNumber),

    getPRState: (prNumber: number) => getPRState(prNumber),

    getPRBody: (prNumber: number) => getPRBody(prNumber),

    getPRBaseBranch: (prNumber: number) => getPRBaseBranch(prNumber),

    // PR Mutations
    createPR: (options: CreatePROptions) => createPR(options),

    retargetPR: (prNumber: number, newBase: string) => retargetPR(prNumber, newBase),

    updatePRBody: (prNumber: number, body: string) => updatePRBody(prNumber, body),

    closePR: (prNumber: number, comment?: string) => closePR(prNumber, comment),
  };
}
