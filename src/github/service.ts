/**
 * GitHub Service Interface and Dependency Injection.
 *
 * This module provides:
 * - GitHubService interface that abstracts all GitHub operations
 * - DI functions for getting/setting the service instance
 * - Automatic selection of appropriate service based on environment
 *
 * Usage:
 * ```typescript
 * import { getGitHubService } from "./service.ts";
 *
 * const result = await getGitHubService().createPR({
 *   title: "My PR",
 *   head: "feature-branch",
 *   base: "main"
 * });
 * ```
 *
 * In tests, the service is automatically replaced with a snapshot service
 * that records/replays GitHub API responses.
 */

import type {
  PRInfo,
  CreatePROptions,
  ChecksStatus,
  ReviewDecision,
  CommentStatus,
  PRMergeStatus,
  LandResult,
} from "./pr.ts";
import { asserted } from "../utils/assert.ts";

/** User PR info returned by listUserPRs */
export interface UserPR {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
  url: string;
}

/**
 * The GitHub service interface.
 * All GitHub operations should go through this interface.
 */
export interface GitHubService {
  // User/Auth
  getUsername(): Promise<string>;

  // PR Queries
  findPRByBranch(branch: string, options?: { includeAll?: boolean }): Promise<PRInfo | null>;
  findPRsByBranches(
    branches: string[],
    options?: { includeAll?: boolean },
  ): Promise<Map<string, PRInfo | null>>;
  getPRChecksStatus(prNumber: number, repo?: string): Promise<ChecksStatus>;
  getPRReviewStatus(prNumber: number, repo?: string): Promise<ReviewDecision>;
  getPRCommentStatus(prNumber: number, repo?: string): Promise<CommentStatus>;
  getPRMergeStatus(prNumber: number): Promise<PRMergeStatus>;
  getPRState(prNumber: number): Promise<"OPEN" | "CLOSED" | "MERGED">;
  getPRBody(prNumber: number): Promise<string>;
  getPRBaseBranch(prNumber: number): Promise<string>;
  getPRChecksAndReviewStatus(
    prNumber: number,
    repo?: string,
  ): Promise<{ checks: ChecksStatus; review: ReviewDecision }>;

  // PR Mutations
  createPR(options: CreatePROptions): Promise<{ number: number; url: string }>;
  retargetPR(prNumber: number, newBase: string): Promise<void>;
  updatePRBody(prNumber: number, body: string): Promise<void>;
  closePR(prNumber: number, comment?: string): Promise<void>;

  // PR Landing
  landPR(prNumber: number, targetBranch: string): Promise<LandResult>;
  waitForPRState(
    prNumber: number,
    expectedState: "OPEN" | "CLOSED" | "MERGED",
    maxWaitMs?: number,
    pollIntervalMs?: number,
  ): Promise<boolean>;

  // User PRs
  listUserPRs(username: string): Promise<UserPR[]>;
}

// DI state
let githubService: GitHubService | null = null;

/**
 * Check if we're running in a test environment.
 * Detects both in-process tests (BUN_TEST) and subprocess snapshot mode.
 */
function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    (typeof Bun !== "undefined" && !!Bun.env.BUN_TEST) ||
    !!process.env.SPRY_SNAPSHOT_MODE
  );
}

/**
 * Check if GitHub integration tests are enabled.
 * When enabled, the snapshot service records to disk.
 * When disabled, the snapshot service replays from disk.
 *
 * Also checks SPRY_SNAPSHOT_MODE for subprocess mode.
 */
export function isGitHubIntegrationEnabled(): boolean {
  if (process.env.SPRY_SNAPSHOT_MODE === "record") return true;
  if (process.env.SPRY_SNAPSHOT_MODE === "replay") return false;
  return process.env.GITHUB_INTEGRATION_TESTS === "1";
}

/**
 * Get the current GitHub service instance.
 *
 * In production, returns the default service (real gh CLI calls).
 * In tests, returns the snapshot service (record/replay).
 * Can be overridden with setGitHubService().
 */
export function getGitHubService(): GitHubService {
  if (githubService) {
    return githubService;
  }

  // Lazy import to avoid circular dependencies
  if (isTestEnvironment()) {
    // Import snapshot service dynamically
    const { createSnapshotGitHubService } = require("./service.snapshot.ts");
    githubService = createSnapshotGitHubService();
  } else {
    // Import default service dynamically
    const { createDefaultGitHubService } = require("./service.default.ts");
    githubService = createDefaultGitHubService();
  }

  return asserted(githubService);
}

/**
 * Set the GitHub service instance.
 * Useful for tests that need to inject a mock service.
 */
export function setGitHubService(service: GitHubService): void {
  githubService = service;
}

/**
 * Reset the GitHub service to allow re-initialization.
 * Useful in tests to reset between test runs.
 */
export function resetGitHubService(): void {
  githubService = null;
}
