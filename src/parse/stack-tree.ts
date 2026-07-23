// src/parse/stack-tree.ts
import type { EnrichedUnit } from "../gh/enrich.ts";
import type { PRInfo } from "../gh/pr.ts";
import type { StackTree, StackTreeNode, StackTreeCommit, PrStateInfo } from "./types.ts";

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

/** Pure: serializes enriched, parsed units into the nested output tree for `sp view --json`. */
export function buildStackTree(enriched: EnrichedUnit[]): StackTree {
  const stack: StackTreeNode[] = enriched.map(({ unit, pr }) => {
    if (unit.type === "group") {
      return {
        type: "group",
        id: unit.id,
        title: unit.title ?? null,
        pr: prState(pr),
        commits: memberCommits(unit.commitIds, unit.commits, unit.subjects),
      };
    }
    return {
      type: "commit",
      id: unit.id,
      sha: unit.commits[0] ?? "",
      subject: unit.subjects[0] ?? "",
      pr: prState(pr),
    };
  });
  return { stack };
}
