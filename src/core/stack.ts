import type { CommitInfo, PRUnit } from "../types.ts";
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
