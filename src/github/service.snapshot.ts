/**
 * Snapshot-based GitHub Service for Testing.
 *
 * This service wraps the real GitHub service and provides record/replay
 * functionality for test isolation and speed.
 *
 * RECORD mode (GITHUB_INTEGRATION_TESTS=1):
 * - Calls the real GitHub service
 * - Records responses to snapshot files
 * - Saves with test context (testFile, testName, testId)
 *
 * REPLAY mode (default):
 * - Reads from snapshot files
 * - Substitutes test IDs dynamically
 * - Returns recorded responses without hitting GitHub
 *
 * Key feature: Dynamic test ID substitution allows different test runs
 * to use the same recorded snapshots with different unique IDs.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GitHubService } from "./service.ts";
import { isGitHubIntegrationEnabled } from "./service.ts";
import { createDefaultGitHubService } from "./service.default.ts";
import { getSnapshotContext, getSnapshotPath, type SnapshotContext } from "./snapshot-context.ts";
import { asserted } from "../utils/assert.ts";

/**
 * Error thrown when a snapshot is not found in replay mode.
 * The test wrapper should catch this and skip the test gracefully.
 */
export class SnapshotNotFoundError extends Error {
  constructor(
    public method: string,
    public testName: string,
  ) {
    super(`Snapshot not found for ${method} in test "${testName}"`);
    this.name = "SnapshotNotFoundError";
  }
}

/** A recorded method call with its result */
interface SnapshotEntry {
  /** Test context when recorded */
  testContext: string;
  /** The test ID when recorded (for substitution) */
  recordedTestId: string;
  /** The method name called */
  method: string;
  /** The arguments (serialized) */
  args: unknown[];
  /** The result (serialized) */
  result: unknown;
  /** Whether the result was an error */
  isError: boolean;
  /** Error class name if isError */
  errorClass?: string;
  /** Timestamp when recorded */
  timestamp: string;
}

/** Snapshot-level context recorded alongside entries */
export interface SnapshotFileContext {
  /** GitHub repo owner (e.g., "happycollision") */
  owner: string;
  /** GitHub repo name (e.g., "spry-check") */
  repo: string;
}

/** The complete snapshot file structure */
interface SnapshotFile {
  /** Version for future compatibility */
  version: 1;
  /** Context from the recording environment */
  context?: SnapshotFileContext;
  /** Array of recorded entries */
  entries: SnapshotEntry[];
}

/** In-memory cache of loaded snapshots */
const snapshotCache = new Map<string, SnapshotFile>();

/** Track which test files have been cleared this recording session */
const clearedForRecording = new Set<string>();

/**
 * Load a snapshot file from disk or cache.
 */
async function loadSnapshots(testFile: string): Promise<SnapshotFile> {
  const path = getSnapshotPath(testFile);

  // Check cache first
  if (snapshotCache.has(path)) {
    return asserted(snapshotCache.get(path));
  }

  // Try to load from disk
  try {
    const content = await readFile(path, "utf-8");
    const file = JSON.parse(content) as SnapshotFile;
    snapshotCache.set(path, file);
    return file;
  } catch {
    // File doesn't exist - create empty structure
    const empty: SnapshotFile = { version: 1, entries: [] };
    snapshotCache.set(path, empty);
    return empty;
  }
}

/**
 * Save a snapshot file to disk.
 */
async function saveSnapshots(testFile: string, file: SnapshotFile): Promise<void> {
  const path = getSnapshotPath(testFile);

  // Ensure directory exists
  await mkdir(dirname(path), { recursive: true });

  // Write with nice formatting for readable diffs
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf-8");

  // Update cache
  snapshotCache.set(path, file);
}

/**
 * Record a snapshot entry.
 */
async function recordSnapshot(
  context: SnapshotContext,
  method: string,
  args: unknown[],
  result: unknown,
  isError: boolean,
  errorClass?: string,
): Promise<void> {
  const path = getSnapshotPath(context.testFile);

  // On first recording for this file, clear all existing entries
  // This ensures stale entries from deleted/renamed tests are removed
  if (!clearedForRecording.has(path)) {
    clearedForRecording.add(path);
    const existing = snapshotCache.get(path);
    snapshotCache.set(path, { version: 1, context: existing?.context, entries: [] });
  }

  const file = await loadSnapshots(context.testFile);

  const entry: SnapshotEntry = {
    testContext: context.testName,
    recordedTestId: context.testId,
    method,
    args,
    result,
    isError,
    errorClass,
    timestamp: new Date().toISOString(),
  };

  // Remove any existing entry for this test/method combo (re-recording)
  const existingIndex = file.entries.findIndex(
    (e) =>
      e.testContext === context.testName &&
      e.method === method &&
      normalizeArgs(e.args, e.recordedTestId) === normalizeArgs(args, context.testId),
  );

  if (existingIndex >= 0) {
    file.entries[existingIndex] = entry;
  } else {
    file.entries.push(entry);
  }

  await saveSnapshots(context.testFile, file);
}

/**
 * Find a matching snapshot entry.
 */
async function findSnapshot(
  context: SnapshotContext,
  method: string,
  args: unknown[],
): Promise<SnapshotEntry | null> {
  const file = await loadSnapshots(context.testFile);

  // First, find entries matching test context and method
  const candidates = file.entries.filter(
    (e) => e.testContext === context.testName && e.method === method,
  );

  if (candidates.length === 0) {
    return null;
  }

  // If only one candidate, return it
  if (candidates.length === 1) {
    return asserted(candidates[0]);
  }

  // Multiple candidates - try to match by args (normalizing test IDs)
  const normalizedArgs = normalizeArgs(args, context.testId);
  for (const candidate of candidates) {
    const candidateNormalizedArgs = normalizeArgs(candidate.args, candidate.recordedTestId);
    if (candidateNormalizedArgs === normalizedArgs) {
      return candidate;
    }
  }

  // No exact match - return first candidate
  return asserted(candidates[0]);
}

/**
 * Normalize args by replacing test IDs with a placeholder.
 * This allows matching snapshots recorded with different test IDs.
 */
function normalizeArgs(args: unknown[], testId: string): string {
  const json = JSON.stringify(args);
  // Replace all occurrences of the test ID with a placeholder
  return json.replace(new RegExp(escapeRegExp(testId), "g"), "__TEST_ID__");
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Substitute test IDs in a result value.
 * Replaces the recorded test ID with the current test ID.
 */
function substituteTestId(value: unknown, recordedId: string, currentId: string): unknown {
  if (typeof value === "string") {
    return value.replace(new RegExp(escapeRegExp(recordedId), "g"), currentId);
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteTestId(item, recordedId, currentId));
  }

  // Map needs special handling - check before generic object check
  if (value instanceof Map) {
    const result = new Map();
    for (const [key, val] of value) {
      const newKey = substituteTestId(key, recordedId, currentId);
      const newVal = substituteTestId(val, recordedId, currentId);
      result.set(newKey, newVal);
    }
    return result;
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteTestId(val, recordedId, currentId);
    }
    return result;
  }

  return value;
}

/**
 * Convert serialized Map back to Map object.
 * Maps are serialized as arrays of [key, value] pairs.
 */
function deserializeResult(result: unknown, method: string): unknown {
  // Methods that return Map<string, PRInfo | null>
  if (method === "findPRsByBranches" && Array.isArray(result)) {
    return new Map(result as Array<[string, unknown]>);
  }
  return result;
}

/**
 * Serialize a result for storage.
 * Maps are converted to arrays for JSON compatibility.
 */
function serializeResult(result: unknown): unknown {
  if (result instanceof Map) {
    return Array.from(result.entries());
  }
  return result;
}

/**
 * Create a snapshot method wrapper.
 * Returns a function that records or replays based on mode.
 */
function createSnapshotMethod<Args extends unknown[], Return>(
  method: string,
  realFn: (...args: Args) => Promise<Return>,
): (...args: Args) => Promise<Return> {
  return async (...args: Args): Promise<Return> => {
    const context = getSnapshotContext();

    // If no context, fall back to real service (outside test wrapper)
    if (!context) {
      return realFn(...args);
    }

    if (isGitHubIntegrationEnabled()) {
      // RECORD mode - call real service and record result
      try {
        const result = await realFn(...args);
        await recordSnapshot(context, method, args, serializeResult(result), false);
        return result;
      } catch (error) {
        // Record errors too
        if (error instanceof Error) {
          await recordSnapshot(context, method, args, error.message, true, error.constructor.name);
        }
        throw error;
      }
    } else {
      // REPLAY mode - find and return snapshot
      const snapshot = await findSnapshot(context, method, args);

      if (!snapshot) {
        throw new SnapshotNotFoundError(method, context.testName);
      }

      // Substitute test IDs in result
      const rawResult = deserializeResult(snapshot.result, method);
      const result = substituteTestId(rawResult, snapshot.recordedTestId, context.testId);

      if (snapshot.isError) {
        // Reconstruct error
        const error = new Error(result as string);
        error.name = snapshot.errorClass || "Error";
        throw error;
      }

      return result as Return;
    }
  };
}

/**
 * Create the snapshot GitHub service.
 * This service wraps the real service with record/replay functionality.
 */
export function createSnapshotGitHubService(): GitHubService {
  const realService = createDefaultGitHubService();

  return {
    // User/Auth
    getUsername: createSnapshotMethod("getUsername", () => realService.getUsername()),

    // PR Queries
    findPRByBranch: createSnapshotMethod("findPRByBranch", (branch, options) =>
      realService.findPRByBranch(branch, options),
    ),

    findPRsByBranches: createSnapshotMethod("findPRsByBranches", (branches, options) =>
      realService.findPRsByBranches(branches, options),
    ),

    getPRChecksStatus: createSnapshotMethod("getPRChecksStatus", (prNumber, repo) =>
      realService.getPRChecksStatus(prNumber, repo),
    ),

    getPRReviewStatus: createSnapshotMethod("getPRReviewStatus", (prNumber, repo) =>
      realService.getPRReviewStatus(prNumber, repo),
    ),

    getPRCommentStatus: createSnapshotMethod("getPRCommentStatus", (prNumber, repo) =>
      realService.getPRCommentStatus(prNumber, repo),
    ),

    getPRMergeStatus: createSnapshotMethod("getPRMergeStatus", (prNumber) =>
      realService.getPRMergeStatus(prNumber),
    ),

    getPRState: createSnapshotMethod("getPRState", (prNumber) => realService.getPRState(prNumber)),

    getPRBody: createSnapshotMethod("getPRBody", (prNumber) => realService.getPRBody(prNumber)),

    getPRBaseBranch: createSnapshotMethod("getPRBaseBranch", (prNumber) =>
      realService.getPRBaseBranch(prNumber),
    ),

    // PR Mutations
    createPR: createSnapshotMethod("createPR", (options) => realService.createPR(options)),

    retargetPR: createSnapshotMethod("retargetPR", (prNumber, newBase) =>
      realService.retargetPR(prNumber, newBase),
    ),

    updatePRBody: createSnapshotMethod("updatePRBody", (prNumber, body) =>
      realService.updatePRBody(prNumber, body),
    ),

    closePR: createSnapshotMethod("closePR", (prNumber, comment) =>
      realService.closePR(prNumber, comment),
    ),
  };
}

/**
 * Flush any pending snapshot writes.
 * Call this at the end of a test run to ensure all snapshots are saved.
 */
export async function flushSnapshots(): Promise<void> {
  // Currently we write immediately, but this could be used for batching
}

/**
 * Clear the snapshot cache.
 * Useful for tests that need to reload from disk.
 */
export function clearSnapshotCache(): void {
  snapshotCache.clear();
}

/**
 * Set the context (owner/repo) on a snapshot file.
 * Called in record mode after the GitHub fixture is created.
 * The context is persisted on the next `saveSnapshots()` call.
 */
export async function setSnapshotFileContext(
  testFile: string,
  context: SnapshotFileContext,
): Promise<void> {
  const file = await loadSnapshots(testFile);
  file.context = context;
  await saveSnapshots(testFile, file);
}

/**
 * Load the context from a snapshot file.
 * Returns null if the file doesn't exist or has no context.
 */
export function loadSnapshotContext(testFile: string): SnapshotFileContext | null {
  const path = getSnapshotPath(testFile);
  try {
    const content = require("fs").readFileSync(path, "utf-8");
    const file = JSON.parse(content) as SnapshotFile;
    return file.context ?? null;
  } catch {
    return null;
  }
}
