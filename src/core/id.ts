import { randomBytes } from "crypto";

/**
 * Generates a unique 8-character hex ID for commit tracking.
 *
 * Properties:
 * - 8 hex characters = 32 bits = 4 billion possibilities
 * - Collision risk negligible for active stacks (typically < 50 commits)
 * - Once PRs merge, their IDs leave the active set
 *
 * Used for:
 * - Taspr-Commit-Id: Assigned to every commit
 * - Taspr-Group-Start / Taspr-Group-End: Marks group boundaries
 */
export function generateCommitId(): string {
  return randomBytes(4).toString("hex");
}
