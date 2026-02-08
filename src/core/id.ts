import { randomBytes } from "crypto";
import { isSnapshotMode } from "../github/snapshot-context.ts";

/**
 * Counter for deterministic commit IDs in snapshot mode.
 * Each subprocess starts at 0 (module reloaded per process).
 */
let deterministicCounter = 0;

/**
 * Cached seed derived from the SPRY_SNAPSHOT env var.
 * Keyed by the raw env var string so it re-computes when the env changes
 * (e.g., between tests in the same process).
 */
let cachedSeed: { envKey: string; value: number } | null = null;

/**
 * Simple string hash (djb2). Returns a positive 32-bit integer.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Get the per-test seed from SPRY_SNAPSHOT env var.
 * Uses test name + subprocess index so that:
 * - Same test in record/replay → same seed → same IDs
 * - Different tests → different seeds → no ID collisions
 *
 * Re-derives the seed whenever the env var changes (handles
 * in-process test runners that update SPRY_SNAPSHOT between tests).
 */
function getSnapshotSeed(): number {
  const snapshotEnv = process.env.SPRY_SNAPSHOT ?? "";

  if (cachedSeed !== null && cachedSeed.envKey === snapshotEnv) {
    return cachedSeed.value;
  }

  // Reset counter only when the seed is actually *changing* (not on first init).
  // In subprocess mode the module is fresh, so cachedSeed starts null and no
  // reset occurs. In in-process mode, a different SPRY_SNAPSHOT between tests
  // triggers the reset so IDs start from 1 again.
  if (cachedSeed !== null) {
    deterministicCounter = 0;
  }

  let value = 0;
  if (snapshotEnv) {
    try {
      const parsed = JSON.parse(snapshotEnv) as { test?: string; subprocess?: number };
      const testName = parsed.test ?? "";
      const subprocess = parsed.subprocess ?? 0;
      value = hashString(`${testName}:${subprocess}`);
    } catch {
      // Invalid JSON, fall through
    }
  }

  cachedSeed = { envKey: snapshotEnv, value };
  return value;
}

/**
 * Generates a unique 8-character hex ID for commit tracking.
 *
 * Properties:
 * - 8 hex characters = 32 bits = 4 billion possibilities
 * - Collision risk negligible for active stacks (typically < 50 commits)
 * - Once PRs merge, their IDs leave the active set
 *
 * Used for:
 * - Spry-Commit-Id: Assigned to every commit
 * - Spry-Group-Start / Spry-Group-End: Marks group boundaries
 *
 * In snapshot mode (SPRY_SNAPSHOT env var), generates deterministic IDs
 * based on the test context (test name + subprocess index) so that:
 * - Branch names are consistent across record/replay runs
 * - Different tests produce different IDs (no cross-test collisions)
 */
export function generateCommitId(): string {
  if (isSnapshotMode()) {
    deterministicCounter++;
    const seed = getSnapshotSeed();
    return ((seed + deterministicCounter) >>> 0).toString(16).padStart(8, "0");
  }
  return randomBytes(4).toString("hex");
}
