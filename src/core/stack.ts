import type { CommitInfo, PRUnit, StackParseResult } from "../types.ts";
import type { CommitTrailers } from "../git/trailers.ts";
import type { GroupTitles } from "../git/group-titles.ts";

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
 * Singles: commits without Taspr-Group trailer
 * Groups: contiguous commits with the same Taspr-Group trailer
 *
 * @param commits - Commits with parsed trailers
 * @param titles - Optional group titles from ref storage (falls back to first commit subject)
 */
export function detectPRUnits(commits: CommitWithTrailers[], titles: GroupTitles = {}): PRUnit[] {
  const units: PRUnit[] = [];
  let currentGroup: PRUnit | null = null;

  for (const commit of commits) {
    const commitId = commit.trailers["Taspr-Commit-Id"];
    const groupId = commit.trailers["Taspr-Group"];

    if (groupId) {
      // This commit belongs to a group
      if (currentGroup && currentGroup.id === groupId) {
        // Continue current group
        if (commitId) {
          currentGroup.commitIds.push(commitId);
        }
        currentGroup.commits.push(commit.hash);
        currentGroup.subjects.push(commit.subject);
      } else {
        // Start a new group (close previous if exists)
        if (currentGroup) {
          units.push(currentGroup);
        }
        // Use title from ref storage, fall back to first commit subject
        const title: string = titles[groupId] ?? commit.subject;
        currentGroup = {
          type: "group",
          id: groupId,
          title,
          commitIds: commitId ? [commitId] : [],
          commits: [commit.hash],
          subjects: [commit.subject],
        };
      }
    } else {
      // Single commit - close any current group first
      if (currentGroup) {
        units.push(currentGroup);
        currentGroup = null;
      }
      units.push({
        type: "single",
        id: commitId || commit.hash.slice(0, 8),
        title: commit.subject,
        commitIds: commitId ? [commitId] : [],
        commits: [commit.hash],
        subjects: [commit.subject],
      });
    }
  }

  // Don't forget the last group
  if (currentGroup) {
    units.push(currentGroup);
  }

  return units;
}

/**
 * Parse stack with validation for group integrity.
 * Returns a result type that includes validation errors for:
 * - Split groups (non-contiguous commits with same Taspr-Group)
 *
 * @param commits - Commits with parsed trailers
 * @param titles - Optional group titles from ref storage (falls back to first commit subject)
 */
export function parseStack(
  commits: CommitWithTrailers[],
  titles: GroupTitles = {},
): StackParseResult {
  // Track group positions for validation
  const groupPositions = new Map<string, number[]>();
  const groupCommits = new Map<string, string[]>(); // groupId -> commit hashes

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    if (!commit) continue;

    const groupId = commit.trailers["Taspr-Group"];

    if (groupId) {
      // Track position
      const positions = groupPositions.get(groupId) || [];
      positions.push(i);
      groupPositions.set(groupId, positions);

      // Track commits
      const hashes = groupCommits.get(groupId) || [];
      hashes.push(commit.hash);
      groupCommits.set(groupId, hashes);
    }
  }

  // Check for split groups (non-contiguous positions)
  for (const [groupId, positions] of groupPositions) {
    if (positions.length < 2) continue;

    // Check if positions are contiguous
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      if (prev !== undefined && curr !== undefined && curr !== prev + 1) {
        // Found a gap - collect interrupting commits
        const interruptingCommits: string[] = [];
        for (let j = prev + 1; j < curr; j++) {
          const interruptingCommit = commits[j];
          if (interruptingCommit) {
            interruptingCommits.push(interruptingCommit.hash);
          }
        }

        // Get title from ref storage, fall back to first commit subject
        const firstCommitHash = groupCommits.get(groupId)?.[0];
        const firstCommit = commits.find((c) => c.hash === firstCommitHash);
        const groupTitle: string = titles[groupId] ?? firstCommit?.subject ?? "Unknown";

        return {
          ok: false,
          error: "split-group",
          group: {
            id: groupId,
            title: groupTitle,
            commits: groupCommits.get(groupId) || [],
          },
          interruptingCommits,
        };
      }
    }
  }

  // Validation passed, return PRUnits
  return { ok: true, units: detectPRUnits(commits, titles) };
}
