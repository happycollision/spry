/**
 * Global registry for test context used by the snapshot GitHub service.
 *
 * This module provides the "glue" between the test harness (which knows the
 * test name and unique ID) and the GitHub service (which needs this context
 * for snapshot matching and ID substitution).
 *
 * The context is set in two stages:
 * 1. registerRepoContext() - called by repoManager in beforeEach with the uniqueId
 * 2. setTestMetadata() - called by the test wrapper with testFile and testName
 *
 * The snapshot service uses getSnapshotContext() to retrieve this information
 * for recording/replaying GitHub API responses.
 */

import { join, dirname } from "node:path";

/** Complete context needed for snapshot operations */
export interface SnapshotContext {
  /** The test file name (e.g., "pr.test.ts") */
  testFile: string;
  /** The test name (e.g., "creates PR for feature branch") */
  testName: string;
  /** The unique test ID (e.g., "happy-penguin-x3f") */
  testId: string;
}

/** Partial context during registration */
interface PartialContext {
  testFile?: string;
  testName?: string;
  testId?: string;
}

/** The global context - accumulated in stages */
let context: PartialContext = {};

/**
 * Register the repo context (unique ID) for the current test.
 * Called by repoManager in beforeEach when using GitHub repos.
 */
export function registerRepoContext(uniqueId: string): void {
  context.testId = uniqueId;
}

/**
 * Set the test metadata (file and name).
 * Called by the withGitHubSnapshots wrapper before test execution.
 */
export function setTestMetadata(testFile: string, testName: string): void {
  context.testFile = testFile;
  context.testName = testName;
}

/**
 * Get the complete snapshot context.
 * Returns null if the context is incomplete.
 */
export function getSnapshotContext(): SnapshotContext | null {
  if (!context.testFile || !context.testName || !context.testId) {
    return null;
  }
  return {
    testFile: context.testFile,
    testName: context.testName,
    testId: context.testId,
  };
}

/**
 * Clear all snapshot context.
 * Called in afterEach to reset state between tests.
 */
export function clearSnapshotContext(): void {
  context = {};
}

/**
 * Get the snapshot file path for a test file.
 * Converts "pr.test.ts" to "tests/snapshots/pr.json"
 *
 * @param testFile - The test file name (e.g., "pr.test.ts")
 * @returns Absolute path to the snapshot file
 */
export function getSnapshotPath(testFile: string): string {
  // Remove .test.ts or .test.js suffix
  const baseName = testFile.replace(/\.test\.(ts|js)$/, "");
  // Get the project root (assuming we're running from the project directory)
  const projectRoot = process.cwd();
  return join(projectRoot, "tests", "snapshots", `${baseName}.json`);
}

/**
 * Get the directory for snapshot files.
 * Creates the directory if it doesn't exist.
 */
export function getSnapshotDir(): string {
  const projectRoot = process.cwd();
  return join(projectRoot, "tests", "snapshots");
}
