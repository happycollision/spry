import type { CommitTrailers, PRUnit, GroupTitles, StackParseResult } from "./types.ts";

export interface CommitWithTrailers {
  hash: string;
  subject: string;
  body: string;
  trailers: CommitTrailers;
}

export function detectPRUnits(commits: CommitWithTrailers[], titles: GroupTitles = {}): PRUnit[] {
  const units: PRUnit[] = [];
  let currentGroup: PRUnit | null = null;

  for (const commit of commits) {
    const commitId = commit.trailers["Spry-Commit-Id"];
    const groupId = commit.trailers["Spry-Group"];

    if (groupId) {
      if (currentGroup && currentGroup.id === groupId) {
        if (commitId) currentGroup.commitIds.push(commitId);
        currentGroup.commits.push(commit.hash);
        currentGroup.subjects.push(commit.subject);
      } else {
        if (currentGroup) units.push(currentGroup);
        currentGroup = {
          type: "group",
          id: groupId,
          title: titles[groupId],
          commitIds: commitId ? [commitId] : [],
          commits: [commit.hash],
          subjects: [commit.subject],
        };
      }
    } else {
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

  if (currentGroup) units.push(currentGroup);
  return units;
}

export function parseStack(
  commits: CommitWithTrailers[],
  titles: GroupTitles = {},
): StackParseResult {
  const groupPositions = new Map<string, number[]>();
  const groupCommits = new Map<string, string[]>();

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    if (!commit) continue;
    const groupId = commit.trailers["Spry-Group"];
    if (groupId) {
      const positions = groupPositions.get(groupId) || [];
      positions.push(i);
      groupPositions.set(groupId, positions);
      const hashes = groupCommits.get(groupId) || [];
      hashes.push(commit.hash);
      groupCommits.set(groupId, hashes);
    }
  }

  for (const [groupId, positions] of groupPositions) {
    if (positions.length < 2) continue;
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      if (prev === undefined || curr === undefined) continue;
      if (curr !== prev + 1) {
        const interruptingCommits: string[] = [];
        for (let j = prev + 1; j < curr; j++) {
          const c = commits[j];
          if (c) interruptingCommits.push(c.hash);
        }
        const firstHash = groupCommits.get(groupId)?.[0];
        const firstCommit = commits.find((c) => c.hash === firstHash);
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

  return { ok: true, units: detectPRUnits(commits, titles) };
}
