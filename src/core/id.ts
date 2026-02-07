import { randomBytes } from "crypto";
import { isSnapshotMode } from "../github/snapshot-context.ts";

/**
 * Counter for deterministic commit IDs in snapshot mode.
 * Each subprocess starts at 0 (module reloaded per process).
 */
let deterministicCounter = 0;

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
 * so that branch names are consistent across record/replay runs.
 */
export function generateCommitId(): string {
  if (isSnapshotMode()) {
    deterministicCounter++;
    return deterministicCounter.toString(16).padStart(8, "0");
  }
  return randomBytes(4).toString("hex");
}
