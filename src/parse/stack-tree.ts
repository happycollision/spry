// src/parse/stack-tree.ts
import type { EnrichedUnit } from "../gh/enrich.ts";
import type { Drift } from "../git/drift.ts";
import type { PRInfo } from "../gh/pr.ts";
import type {
  StackTree,
  StackTreeNode,
  StackTreeCommit,
  StackTreeMerge,
  StackTreeGroupChild,
  PrStateInfo,
  CommitMergeGroupMap,
} from "./types.ts";

function prState(pr: PRInfo | null): PrStateInfo | null {
  if (!pr) return null;
  return { number: pr.number, state: pr.state };
}

function memberCommits(ids: string[], hashes: string[], subjects: string[]): StackTreeCommit[] {
  return ids.map((id, i) => ({
    type: "commit",
    id,
    sha: hashes[i] ?? "",
    subject: subjects[i] ?? "",
  }));
}

/**
 * Wrap contiguous runs of commits that belong to the same merge group into a
 * `merge` node, preserving order. Commits with no merge group pass through as
 * plain commit nodes. `mergeGroups` maps a commit id to its merge-group id; a run
 * of adjacent commits sharing an id becomes one merge node carrying that id.
 */
export function wrapMergeNodes(
  commits: StackTreeCommit[],
  mergeGroups: CommitMergeGroupMap,
): StackTreeGroupChild[] {
  const out: StackTreeGroupChild[] = [];
  let i = 0;
  while (i < commits.length) {
    const c = commits[i];
    if (!c) {
      i++;
      continue;
    }
    const mgId = mergeGroups[c.id];
    if (!mgId) {
      out.push(c);
      i++;
      continue;
    }
    // Gather the contiguous run of commits sharing this merge-group id.
    const run: StackTreeCommit[] = [];
    while (i < commits.length) {
      const next = commits[i];
      if (!next || mergeGroups[next.id] !== mgId) break;
      run.push(next);
      i++;
    }
    const merge: StackTreeMerge = { type: "merge", id: mgId, commits: run };
    out.push(merge);
  }
  return out;
}

/**
 * Pure: serializes enriched, parsed units into the nested output tree for
 * `sp view --json`. When `mergeGroups` is provided, contiguous runs of commits
 * belonging to a merge group are wrapped into `merge` nodes — both at the top
 * level (a merge among top-level singles) and inside a PR group's commits.
 */
export function buildStackTree(
  enriched: EnrichedUnit[],
  drift: Drift[] = [],
  mergeGroups: CommitMergeGroupMap = {},
): StackTree {
  // Build each unit's representation in order. Top-level singles are buffered so a
  // merge run spanning several adjacent singles wraps correctly; a group flushes
  // the buffer and wraps within its own members.
  const stack: StackTreeNode[] = [];
  let pendingSingles: StackTreeCommit[] = [];
  const flushSingles = () => {
    if (pendingSingles.length === 0) return;
    for (const node of wrapMergeNodes(pendingSingles, mergeGroups)) stack.push(node);
    pendingSingles = [];
  };

  enriched.forEach(({ unit, pr }, i) => {
    const d = drift[i] ?? { localAhead: false, remoteAhead: false };
    if (unit.type === "group") {
      flushSingles();
      const members = memberCommits(unit.commitIds, unit.commits, unit.subjects);
      stack.push({
        type: "group",
        id: unit.id,
        title: unit.title ?? null,
        localAhead: d.localAhead,
        remoteAhead: d.remoteAhead,
        pr: prState(pr),
        commits: wrapMergeNodes(members, mergeGroups),
      });
      return;
    }
    pendingSingles.push({
      type: "commit",
      id: unit.id,
      sha: unit.commits[0] ?? "",
      subject: unit.subjects[0] ?? "",
      localAhead: d.localAhead,
      remoteAhead: d.remoteAhead,
      pr: prState(pr),
    });
  });
  flushSingles();

  return { stack };
}
