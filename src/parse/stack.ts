import type {
  CommitTrailers,
  PRUnit,
  GroupTitles,
  CommitGroupMap,
  CommitMergeGroupMap,
  StackParseResult,
} from "./types.ts";

export interface CommitWithTrailers {
  hash: string;
  subject: string;
  body: string;
  trailers: CommitTrailers;
  // Parent SHAs (from the first-parent walk). 2+ parents => a merge commit.
  parents?: string[];
  // For a merge commit: its side-branch member commits, oldest-first.
  mergeMembers?: CommitWithTrailers[];
}

// The merge-aware stack model: the FIRST-PARENT sequence of the stack, where each
// node is either a plain commit or a merge (nesting its member commits). This is
// the read-side representation the --apply validator (step 4) and the StackTree
// builder (step 5) consume; PR grouping (parseStack/detectPRUnits) operates on the
// flattened member list independently.
export interface StackModelPlain {
  type: "commit";
  commit: CommitWithTrailers;
}

export interface StackModelMerge {
  type: "merge";
  // The materialized merge commit itself (its SHA, subject, message live here).
  merge: CommitWithTrailers;
  // Resolved merge-group id (from the CommitMergeGroupMap via member ids), or null
  // when the merge commit exists in history but no MergeGroupRecord matches it.
  mergeGroupId: string | null;
  // The side-branch member commits, oldest-first.
  members: CommitWithTrailers[];
}

export type StackModelNode = StackModelPlain | StackModelMerge;

function commitId(commit: CommitWithTrailers): string | undefined {
  return commit.trailers["Spry-Commit-Id"];
}

/** True when a commit is a materialized merge (2+ parents, or members attached). */
function isMergeCommit(commit: CommitWithTrailers): boolean {
  return (commit.parents?.length ?? 0) >= 2 || (commit.mergeMembers?.length ?? 0) > 0;
}

/**
 * The stable merge-group id its members agree on: the single id every RECORDED
 * member maps to in `mergeGroups`. Returns undefined when members disagree or
 * none are recorded (caller falls back to a SHA-derived id). Partial recording
 * (some members recorded, all agreeing) still resolves — matches buildStackModel.
 */
function resolveMergeGroupId(
  members: CommitWithTrailers[],
  mergeGroups: CommitMergeGroupMap,
): string | undefined {
  const seen = new Set<string>();
  for (const m of members) {
    const id = commitId(m);
    const gid = id ? mergeGroups[id] : undefined;
    if (gid) seen.add(gid);
  }
  return seen.size === 1 ? [...seen][0] : undefined;
}

/** The 8-char short hash used as a fallback unit id when no Spry-Commit-Id exists. */
function shortHash(commit: CommitWithTrailers): string {
  return commit.hash.slice(0, 8);
}

/**
 * Build the merge-aware stack model from the FIRST-PARENT commit sequence.
 *
 * `firstParentCommits` is the outer line (oldest-first) as returned by the
 * first-parent stack walk; a commit with `mergeMembers` set (2+ parents) is a
 * merge commit and its `mergeMembers` are its side-branch commits. `mergeGroups`
 * maps a member's Spry-Commit-Id to its merge-group id.
 *
 * A merge commit is matched to a merge-group id by looking up its members in
 * `mergeGroups`; when the members carry a consistent id it is used, otherwise the
 * node's `mergeGroupId` is null (the merge exists in history but is unrecorded —
 * self-heals on the next `sp group`).
 */
export function buildStackModel(
  firstParentCommits: CommitWithTrailers[],
  mergeGroups: CommitMergeGroupMap = {},
): StackModelNode[] {
  const nodes: StackModelNode[] = [];
  for (const commit of firstParentCommits) {
    if (isMergeCommit(commit)) {
      const members = commit.mergeMembers ?? [];
      // Resolve the merge-group id from members: the id every recorded member
      // agrees on. null if members disagree or none are recorded.
      const mergeGroupId = resolveMergeGroupId(members, mergeGroups) ?? null;
      nodes.push({ type: "merge", merge: commit, mergeGroupId, members });
    } else {
      nodes.push({ type: "commit", commit });
    }
  }
  return nodes;
}

/**
 * Flatten a merge-aware stack model back to a plain oldest-first commit list, with
 * each merge's members spliced in place of the merge commit. This is what PR
 * grouping (parseStack/detectPRUnits) walks — a merge group's members are
 * contiguous and belong to a single PR unit, so PR detection is unaffected by
 * whether they are materialized as a merge.
 */
export function flattenStackModel(nodes: StackModelNode[]): CommitWithTrailers[] {
  const out: CommitWithTrailers[] = [];
  for (const node of nodes) {
    if (node.type === "merge") out.push(...node.members);
    else out.push(node.commit);
  }
  return out;
}

export function detectPRUnits(
  commits: CommitWithTrailers[],
  titles: GroupTitles = {},
  commitGroups: CommitGroupMap = {},
  mergeGroups: CommitMergeGroupMap = {},
): PRUnit[] {
  const units: PRUnit[] = [];
  let currentGroup: PRUnit | null = null;

  const flushGroup = () => {
    if (currentGroup) {
      units.push(currentGroup);
      currentGroup = null;
    }
  };

  for (const commit of commits) {
    // A materialized merge commit (2+ parents / members set) is its own PR unit:
    // it carries no Spry-Commit-Id and is identified by its members. Handle it
    // before the id/group logic so it never falls into the degenerate else path.
    if (isMergeCommit(commit)) {
      // KNOWN LIMITATION (spry-1574.8): this unconditionally closes any open PR
      // group before the merge unit. A merge nested INSIDE a PR group (which the
      // type model allows — see StackTreeGroup.commits) is therefore mis-split
      // here on the first-parent path. Unreachable until Task 4 wires member
      // enrichment; must be resolved there.
      flushGroup();
      const members = commit.mergeMembers ?? [];
      const memberIds = members.map((m) => commitId(m)).filter((id): id is string => !!id);
      // Resolve the stable merge-group id: the id every recorded member agrees on.
      const mergeGroupId = resolveMergeGroupId(members, mergeGroups);
      units.push({
        type: "single",
        id: mergeGroupId ?? shortHash(commit),
        title: commit.subject,
        commitIds: memberIds,
        commits: [commit.hash],
        subjects: [commit.subject],
        ...(members.length > 0 ? { mergeMembers: members } : {}),
      });
      continue;
    }

    const currentCommitId = commitId(commit);
    const groupId = currentCommitId ? commitGroups[currentCommitId] : undefined;

    if (groupId) {
      if (currentGroup && currentGroup.id === groupId) {
        if (currentCommitId) currentGroup.commitIds.push(currentCommitId);
        currentGroup.commits.push(commit.hash);
        currentGroup.subjects.push(commit.subject);
      } else {
        flushGroup();
        currentGroup = {
          type: "group",
          id: groupId,
          title: titles[groupId],
          commitIds: currentCommitId ? [currentCommitId] : [],
          commits: [commit.hash],
          subjects: [commit.subject],
        };
      }
    } else {
      flushGroup();
      units.push({
        type: "single",
        id: currentCommitId || shortHash(commit),
        title: commit.subject,
        commitIds: currentCommitId ? [currentCommitId] : [],
        commits: [commit.hash],
        subjects: [commit.subject],
      });
    }
  }

  flushGroup();
  return units;
}

export function parseStack(
  commits: CommitWithTrailers[],
  titles: GroupTitles = {},
  commitGroups: CommitGroupMap = {},
  mergeGroups: CommitMergeGroupMap = {},
): StackParseResult {
  const groupPositions = new Map<string, number[]>();
  const groupCommits = new Map<string, string[]>();

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    if (!commit) continue;
    const commitId = commit.trailers["Spry-Commit-Id"];
    const groupId = commitId ? commitGroups[commitId] : undefined;
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

  return { ok: true, units: detectPRUnits(commits, titles, commitGroups, mergeGroups) };
}
