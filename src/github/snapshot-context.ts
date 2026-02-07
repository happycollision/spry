/**
 * Global registry for test context used by the snapshot GitHub service.
 *
 * This module provides the "glue" between the test harness (which knows the
 * test name and unique ID) and the GitHub service (which needs this context
 * for snapshot matching and ID substitution).
 *
 * Context can be set in two ways:
 *
 * **In-process mode** (for tests that call getGitHubService() directly):
 * 1. registerRepoContext() - called by repoManager in beforeEach with the uniqueId
 * 2. setTestMetadata() - called by the test wrapper with testFile and testName
 *
 * **Subprocess mode** (for tests that run sp CLI via runSpry()):
 * Context is passed via two environment variables:
 * - SPRY_SNAPSHOT: JSON object with { mode, file, test, testId, subprocess }
 * - SPRY_SNAPSHOT_ROOT: project root for resolving snapshot file paths
 */

import { join } from "node:path";

/**
 * Capture project root at module load time.
 * In subprocess mode, use SPRY_SNAPSHOT_ROOT (passed by the test process)
 * because the subprocess cwd is the test repo, not the project root.
 * In the test process, use process.cwd() which is the project root.
 */
const PROJECT_ROOT = process.env.SPRY_SNAPSHOT_ROOT ?? process.cwd();

/** Complete context needed for snapshot operations */
export interface SnapshotContext {
  /** The test file name (e.g., "pr.test.ts") */
  testFile: string;
  /** The test name (e.g., "creates PR for feature branch") */
  testName: string;
  /** The unique test ID (e.g., "happy-penguin-x3f") */
  testId: string;
  /** Subprocess index (undefined for in-process calls) */
  subprocess?: number;
}

/** Partial context during registration */
interface PartialContext {
  testFile?: string;
  testName?: string;
  testId?: string;
}

/** The global context - accumulated in stages */
let context: PartialContext = {};

/** Subprocess counter for tracking which CLI invocation this is */
let subprocessCounter = 0;

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
 *
 * In subprocess mode (SPRY_SNAPSHOT set), reads from the env var.
 * Otherwise, reads from the in-process global context.
 */
export function getSnapshotContext(): SnapshotContext | null {
  // Subprocess mode: context comes from SPRY_SNAPSHOT JSON env var
  const snapshotEnv = process.env.SPRY_SNAPSHOT;
  if (snapshotEnv) {
    try {
      const parsed = JSON.parse(snapshotEnv) as {
        mode?: string;
        file?: string;
        test?: string;
        testId?: string;
        subprocess?: number;
      };

      if (parsed.file && parsed.test && parsed.testId) {
        return {
          testFile: parsed.file,
          testName: parsed.test,
          testId: parsed.testId,
          subprocess: parsed.subprocess,
        };
      }
    } catch {
      // Invalid JSON - fall through to in-process mode
    }
    return null;
  }

  // In-process mode: context from global state
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
 * Get the next subprocess index and increment the counter.
 * Called by runSpry() to assign a unique index to each CLI invocation.
 */
export function nextSubprocessIndex(): number {
  return subprocessCounter++;
}

/**
 * Reset the subprocess counter.
 * Called in afterEach to reset between tests.
 */
export function resetSubprocessCounter(): void {
  subprocessCounter = 0;
}

/**
 * Get the snapshot mode from the SPRY_SNAPSHOT env var.
 * Returns "record", "replay", or null if not in snapshot mode.
 */
export function getSnapshotMode(): "record" | "replay" | null {
  const snapshotEnv = process.env.SPRY_SNAPSHOT;
  if (!snapshotEnv) return null;
  try {
    const parsed = JSON.parse(snapshotEnv) as { mode?: string };
    if (parsed.mode === "record" || parsed.mode === "replay") {
      return parsed.mode;
    }
  } catch {
    // Invalid JSON
  }
  return null;
}

/**
 * Check if we're in any snapshot mode (subprocess).
 */
export function isSnapshotMode(): boolean {
  return !!process.env.SPRY_SNAPSHOT;
}

/**
 * Get the project root directory.
 * Uses SPRY_SNAPSHOT_ROOT in subprocess mode, process.cwd() otherwise.
 */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
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
  // Use PROJECT_ROOT captured at module load time (not process.cwd())
  return join(PROJECT_ROOT, "tests", "snapshots", `${baseName}.json`);
}
