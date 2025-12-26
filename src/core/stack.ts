import type { CommitInfo, PRUnit, StackParseResult, GroupInfo } from "../types.ts";
import type { CommitTrailers } from "../git/trailers.ts";

/**
 * Represents a commit with parsed trailers for stack detection.
 */
export interface CommitWithTrailers extends Omit<CommitInfo, "trailers"> {
  trailers: CommitTrailers;
}

/**
 * Detect PRUnits from a list of commits.
 * Returns an array of PRUnits in oldest-to-newest order.
 *
 * Singles: commits without group trailers
 * Groups: commits between Taspr-Group-Start and Taspr-Group-End
 */
export function detectPRUnits(commits: CommitWithTrailers[]): PRUnit[] {
  const units: PRUnit[] = [];
  let currentGroup: PRUnit | null = null;

  for (const commit of commits) {
    const commitId = commit.trailers["Taspr-Commit-Id"];
    const startId = commit.trailers["Taspr-Group-Start"];
    const endId = commit.trailers["Taspr-Group-End"];

    if (startId && !currentGroup) {
      // Start a new group
      currentGroup = {
        type: "group",
        id: startId,
        title: commit.trailers["Taspr-Group-Title"] || commit.subject,
        commitIds: commitId ? [commitId] : [],
        commits: [commit.hash],
      };
    } else if (currentGroup) {
      // Add to current group
      if (commitId) {
        currentGroup.commitIds.push(commitId);
      }
      currentGroup.commits.push(commit.hash);

      if (endId === currentGroup.id) {
        // End of group
        units.push(currentGroup);
        currentGroup = null;
      }
    } else {
      // Single commit
      units.push({
        type: "single",
        id: commitId || commit.hash.slice(0, 8),
        title: commit.subject,
        commitIds: commitId ? [commitId] : [],
        commits: [commit.hash],
      });
    }
  }

  // If there's an unclosed group, still include it (validation handles errors)
  if (currentGroup) {
    units.push(currentGroup);
  }

  return units;
}

/**
 * Parse stack with validation for group integrity.
 * Returns a result type that includes validation errors for:
 * - Unclosed groups (Start without End)
 * - Overlapping groups (Start inside another group)
 */
export function parseStack(commits: CommitWithTrailers[]): StackParseResult {
  let activeGroup: { id: string; title: string; startCommit: string } | null = null;

  for (const commit of commits) {
    const startId = commit.trailers["Taspr-Group-Start"];
    const endId = commit.trailers["Taspr-Group-End"];

    // Check for overlapping groups
    if (startId && activeGroup && startId !== activeGroup.id) {
      const group1: GroupInfo = {
        id: activeGroup.id,
        title: activeGroup.title,
        startCommit: activeGroup.startCommit,
      };
      const group2: GroupInfo = {
        id: startId,
        title: commit.trailers["Taspr-Group-Title"] || commit.subject,
        startCommit: commit.hash,
      };
      return {
        ok: false,
        error: "overlapping-groups",
        group1,
        group2,
        overlappingCommit: commit.hash,
      };
    }

    if (startId && !activeGroup) {
      activeGroup = {
        id: startId,
        title: commit.trailers["Taspr-Group-Title"] || commit.subject,
        startCommit: commit.hash,
      };
    }

    if (endId && activeGroup && endId === activeGroup.id) {
      activeGroup = null;
    }
  }

  // Check for unclosed group
  if (activeGroup) {
    return {
      ok: false,
      error: "unclosed-group",
      groupId: activeGroup.id,
      startCommit: activeGroup.startCommit,
      groupTitle: activeGroup.title,
    };
  }

  // Validation passed, return PRUnits
  return { ok: true, units: detectPRUnits(commits) };
}
