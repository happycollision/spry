/**
 * Mock GitHub Service for Unit Tests.
 *
 * Provides a simple way to create mock GitHub services with
 * configurable behavior for unit tests that don't need full
 * snapshot recording/replay.
 *
 * Usage:
 * ```typescript
 * import { createMockGitHubService, setGitHubService } from "./service.ts";
 *
 * setGitHubService(createMockGitHubService({
 *   getUsername: async () => "testuser",
 *   findPRByBranch: async () => ({ number: 1, url: "...", state: "OPEN", title: "Test" }),
 * }));
 * ```
 */

import type { GitHubService, UserPR } from "./service.ts";
import type { PRInfo, ChecksStatus, ReviewDecision } from "./pr.ts";

/**
 * Default implementations that throw "not implemented" errors.
 * Tests should override only the methods they need.
 */
function notImplemented(method: string): () => never {
  return () => {
    throw new Error(`Mock GitHubService.${method}() not implemented`);
  };
}

/**
 * Create a mock GitHub service with optional method overrides.
 *
 * Any method not overridden will throw a "not implemented" error
 * when called, helping tests fail fast if unexpected methods are called.
 *
 * @param overrides - Partial implementation to use
 */
export function createMockGitHubService(overrides: Partial<GitHubService> = {}): GitHubService {
  return {
    // User/Auth
    getUsername: overrides.getUsername ?? notImplemented("getUsername"),

    // PR Queries
    findPRByBranch: overrides.findPRByBranch ?? notImplemented("findPRByBranch"),
    findPRsByBranches: overrides.findPRsByBranches ?? notImplemented("findPRsByBranches"),
    getPRChecksStatus: overrides.getPRChecksStatus ?? notImplemented("getPRChecksStatus"),
    getPRReviewStatus: overrides.getPRReviewStatus ?? notImplemented("getPRReviewStatus"),
    getPRCommentStatus: overrides.getPRCommentStatus ?? notImplemented("getPRCommentStatus"),
    getPRMergeStatus: overrides.getPRMergeStatus ?? notImplemented("getPRMergeStatus"),
    getPRState: overrides.getPRState ?? notImplemented("getPRState"),
    getPRBody: overrides.getPRBody ?? notImplemented("getPRBody"),
    getPRBaseBranch: overrides.getPRBaseBranch ?? notImplemented("getPRBaseBranch"),

    // PR Checks + Review (combined)
    getPRChecksAndReviewStatus:
      overrides.getPRChecksAndReviewStatus ?? notImplemented("getPRChecksAndReviewStatus"),

    // PR Mutations
    createPR: overrides.createPR ?? notImplemented("createPR"),
    retargetPR: overrides.retargetPR ?? notImplemented("retargetPR"),
    updatePRBody: overrides.updatePRBody ?? notImplemented("updatePRBody"),
    closePR: overrides.closePR ?? notImplemented("closePR"),

    // PR Landing
    landPR: overrides.landPR ?? notImplemented("landPR"),
    waitForPRState: overrides.waitForPRState ?? notImplemented("waitForPRState"),

    // User PRs
    listUserPRs: overrides.listUserPRs ?? notImplemented("listUserPRs"),
  };
}

/**
 * Create a "pass-through" mock that returns default values for all methods.
 * Useful for tests that don't care about GitHub interactions.
 */
export function createNoOpGitHubService(): GitHubService {
  return {
    getUsername: async () => "mockuser",
    findPRByBranch: async () => null,
    findPRsByBranches: async (branches) => {
      const map = new Map<string, PRInfo | null>();
      for (const branch of branches) {
        map.set(branch, null);
      }
      return map;
    },
    getPRChecksStatus: async () => "none" as ChecksStatus,
    getPRReviewStatus: async () => "none" as ReviewDecision,
    getPRCommentStatus: async () => ({ total: 0, resolved: 0 }),
    getPRMergeStatus: async () => ({
      checksStatus: "none" as ChecksStatus,
      reviewDecision: "none" as ReviewDecision,
      isReady: true,
    }),
    getPRState: async () => "OPEN",
    getPRBody: async () => "",
    getPRBaseBranch: async () => "main",
    getPRChecksAndReviewStatus: async () => ({
      checks: "none" as ChecksStatus,
      review: "none" as ReviewDecision,
    }),
    createPR: async (_options) => ({ number: 1, url: `https://github.com/owner/repo/pull/1` }),
    retargetPR: async () => {},
    updatePRBody: async () => {},
    closePR: async () => {},
    landPR: async () => ({ sha: "abc123", prClosed: true }),
    waitForPRState: async () => true,
    listUserPRs: async () => [] as UserPR[],
  };
}

/**
 * Create a mock that tracks all method calls for verification.
 */
export interface TrackedGitHubService extends GitHubService {
  /** Get all recorded method calls */
  getCalls(): Array<{ method: string; args: unknown[] }>;
  /** Clear recorded calls */
  clearCalls(): void;
  /** Check if a method was called */
  wasCalled(method: string): boolean;
  /** Get calls to a specific method */
  getCallsTo(method: string): unknown[][];
}

export function createTrackedGitHubService(
  base: GitHubService = createNoOpGitHubService(),
): TrackedGitHubService {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  function wrap<Args extends unknown[], Return>(
    method: string,
    fn: (...args: Args) => Promise<Return>,
  ): (...args: Args) => Promise<Return> {
    return async (...args: Args) => {
      calls.push({ method, args });
      return fn(...args);
    };
  }

  return {
    getUsername: wrap("getUsername", base.getUsername.bind(base)),
    findPRByBranch: wrap("findPRByBranch", base.findPRByBranch.bind(base)),
    findPRsByBranches: wrap("findPRsByBranches", base.findPRsByBranches.bind(base)),
    getPRChecksStatus: wrap("getPRChecksStatus", base.getPRChecksStatus.bind(base)),
    getPRReviewStatus: wrap("getPRReviewStatus", base.getPRReviewStatus.bind(base)),
    getPRCommentStatus: wrap("getPRCommentStatus", base.getPRCommentStatus.bind(base)),
    getPRMergeStatus: wrap("getPRMergeStatus", base.getPRMergeStatus.bind(base)),
    getPRState: wrap("getPRState", base.getPRState.bind(base)),
    getPRBody: wrap("getPRBody", base.getPRBody.bind(base)),
    getPRBaseBranch: wrap("getPRBaseBranch", base.getPRBaseBranch.bind(base)),
    createPR: wrap("createPR", base.createPR.bind(base)),
    retargetPR: wrap("retargetPR", base.retargetPR.bind(base)),
    updatePRBody: wrap("updatePRBody", base.updatePRBody.bind(base)),
    closePR: wrap("closePR", base.closePR.bind(base)),
    getPRChecksAndReviewStatus: wrap(
      "getPRChecksAndReviewStatus",
      base.getPRChecksAndReviewStatus.bind(base),
    ),
    landPR: wrap("landPR", base.landPR.bind(base)),
    waitForPRState: wrap("waitForPRState", base.waitForPRState.bind(base)),
    listUserPRs: wrap("listUserPRs", base.listUserPRs.bind(base)),

    getCalls: () => [...calls],
    clearCalls: () => {
      calls.length = 0;
    },
    wasCalled: (method) => calls.some((c) => c.method === method),
    getCallsTo: (method) => calls.filter((c) => c.method === method).map((c) => c.args),
  };
}
