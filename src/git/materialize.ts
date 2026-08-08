import type { GitRunner } from "../lib/context.ts";
import { createCommit, getTree, mergeTree, type PlumbingOptions } from "./plumbing.ts";

// Materialize/unmerge plumbing for merge groups.
//
// A merge group is a contiguous run of commits that should appear in branch
// history under a real merge commit. Materializing rewrites the branch so that
// the group's commits live on a second-parent side branch and a merge commit
// joins them back onto the trunk line; unmerging is the inverse. Both are pure
// git-plumbing operations (commit-tree + merge-tree) — no working tree is
// touched here; the caller moves the branch ref and resets if desired (see
// finalizeRewrite in plumbing.ts).
//
// DETERMINISM: the synthesized merge commit's author/committer identity and date
// are PINNED (not wall-clock), so re-materializing an unchanged group regenerates
// the identical merge SHA. Replayed member/above commits keep their own original
// author+committer env (via the 3-way replay), same as rebasePlumbing.

export interface PlanNodePlain {
  type: "commit";
  // The original commit SHA to replay.
  sha: string;
}

export interface PlanNodeMerge {
  type: "merge";
  // The group's member commit SHAs, oldest-first (the original commits to replay
  // onto the merge parent to form the side branch).
  members: string[];
  // The merge commit's message (subject + optional body).
  message: string;
}

export type PlanNode = PlanNodePlain | PlanNodeMerge;

export type MaterializeResult =
  | { ok: true; newTip: string; mergeShas: string[] }
  | { ok: false; conflictSha: string; conflictInfo: string };

// Pinned identity/date for synthesized merge commits. A fixed epoch keeps the
// merge SHA stable across regenerations of an unchanged group. (The members and
// above-commits keep their own real author/committer env, so their history is
// unchanged; only the merge node itself is synthetic.)
const MERGE_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "spry",
  GIT_AUTHOR_EMAIL: "spry@local",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "spry",
  GIT_COMMITTER_EMAIL: "spry@local",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

async function authorCommitterEnv(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<Record<string, string>> {
  const result = await git.run(
    ["log", "-1", "--format=%an%x00%ae%x00%ai%x00%cn%x00%ce%x00%ci", commit],
    { cwd: options?.cwd },
  );
  const [aName, aEmail, aDate, cName, cEmail, cDate] = result.stdout.trim().split("\x00");
  return {
    GIT_AUTHOR_NAME: aName ?? "",
    GIT_AUTHOR_EMAIL: aEmail ?? "",
    GIT_AUTHOR_DATE: aDate ?? "",
    GIT_COMMITTER_NAME: cName ?? "",
    GIT_COMMITTER_EMAIL: cEmail ?? "",
    GIT_COMMITTER_DATE: cDate ?? "",
  };
}

async function firstParent(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string> {
  // The original parent used as the merge-base for the 3-way replay. A root
  // commit (no parent) uses the empty-tree sentinel so merge-tree still works.
  const res = await git.run(["rev-parse", "--verify", `${commit}^`], { cwd: options?.cwd });
  if (res.exitCode !== 0) {
    const empty = await git.run(["hash-object", "-t", "tree", "--stdin"], {
      cwd: options?.cwd,
      stdin: "",
    });
    return empty.stdout.trim();
  }
  return res.stdout.trim();
}

async function messageOf(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string> {
  const r = await git.run(["log", "-1", "--format=%B", commit], { cwd: options?.cwd });
  return r.stdout.replace(/\n+$/, "");
}

// Replay one original commit onto `onto` via a 3-way merge (base = its original
// parent), preserving its tree changes and its own author/committer env. Returns
// the new SHA, or a conflict.
type ReplayResult = { ok: true; sha: string } | { ok: false; conflictInfo: string };

async function replayOnto(
  git: GitRunner,
  onto: string,
  original: string,
  options?: PlumbingOptions,
): Promise<ReplayResult> {
  const base = await firstParent(git, original, options);
  const merged = await mergeTree(git, base, onto, original, options);
  if (!merged.ok) return { ok: false, conflictInfo: merged.conflictInfo };
  const env = await authorCommitterEnv(git, original, options);
  const message = await messageOf(git, original, options);
  const sha = await createCommit(git, merged.tree, [onto], message, env, options);
  return { ok: true, sha };
}

/**
 * Rebuild a branch from `base` according to `plan`, materializing merge nodes as
 * real merge commits.
 *
 * For a plain node: replay its commit onto the running tip (3-way merge, so any
 * lower changes are carried — never reuse the old tree verbatim).
 *
 * For a merge node:
 *   1. replay each member onto the running tip, forming a re-rooted side branch;
 *   2. build the merge commit: commit-tree <sideTipTree> -p <tip> -p <sideTip>,
 *      pinned env, with the node's message;
 *   3. continue the trunk line from the merge commit.
 *
 * The merge commit's tree equals the re-rooted side tip's tree (the group's final
 * state), so the merge introduces no content diff of its own.
 */
export async function materialize(
  git: GitRunner,
  base: string,
  plan: PlanNode[],
  options?: PlumbingOptions,
): Promise<MaterializeResult> {
  let tip = base;
  const mergeShas: string[] = [];

  for (const node of plan) {
    if (node.type === "commit") {
      const r = await replayOnto(git, tip, node.sha, options);
      if (!r.ok) return { ok: false, conflictSha: node.sha, conflictInfo: r.conflictInfo };
      tip = r.sha;
      continue;
    }

    // merge node: replay members onto tip to form the side branch.
    const mergeParent = tip;
    let sideTip = tip;
    for (const member of node.members) {
      const r = await replayOnto(git, sideTip, member, options);
      if (!r.ok) return { ok: false, conflictSha: member, conflictInfo: r.conflictInfo };
      sideTip = r.sha;
    }
    // Build the merge commit joining the side branch back onto the trunk line.
    const sideTree = await getTree(git, sideTip, options);
    const mergeSha = await createCommit(
      git,
      sideTree,
      [mergeParent, sideTip],
      node.message,
      MERGE_ENV,
      options,
    );
    mergeShas.push(mergeSha);
    tip = mergeSha;
  }

  return { ok: true, newTip: tip, mergeShas };
}
