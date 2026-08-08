import type { MergeGroupRecord, MergeGroupRecords, CommitMergeGroupMap } from "../parse/types.ts";
import { remoteSpryRef } from "../lib/refs-seam.ts";

interface GitOpts {
  cwd?: string;
  stdin?: string;
}

interface GitRunner {
  run(
    args: string[],
    opts?: GitOpts,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// Merge-group records live on their OWN ref, independent of refs/spry/groups (PR
// groups). This keeps the two grouping axes decoupled: a merge group's membership
// is not tied to any PR group's membership. Mirrors the storage shape of
// src/git/group-titles.ts (a flat tree of one JSON blob per id).
const MERGE_GROUPS_REF = "refs/spry/merge-groups";

// Maps each member Spry-Commit-Id to its merge-group id. Analogue of
// buildCommitGroupMap (src/git/group-titles.ts) for the merge axis.
export function buildCommitMergeGroupMap(records: MergeGroupRecords): CommitMergeGroupMap {
  const map: CommitMergeGroupMap = {};
  for (const [mergeGroupId, record] of Object.entries(records)) {
    for (const commitId of record.members) {
      map[commitId] = mergeGroupId;
    }
  }
  return map;
}

export async function loadMergeGroupRecords(
  git: GitRunner,
  opts?: GitOpts,
): Promise<MergeGroupRecords> {
  const ls = await git.run(["ls-tree", MERGE_GROUPS_REF], opts);
  // Non-zero means the ref doesn't exist yet — normal on first use.
  if (ls.exitCode !== 0) return {};

  const records: MergeGroupRecords = {};
  for (const line of ls.stdout.trim().split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const mergeGroupId = line.slice(tab + 1);
    const cat = await git.run(["cat-file", "blob", `${MERGE_GROUPS_REF}:${mergeGroupId}`], opts);
    if (cat.exitCode !== 0)
      throw new Error(`loadMergeGroupRecords: cat-file failed for ${mergeGroupId}: ${cat.stderr}`);
    try {
      records[mergeGroupId] = JSON.parse(cat.stdout.trim()) as MergeGroupRecord;
    } catch {
      // Skip malformed entries — don't crash on corrupt or legacy plain-text blobs
    }
  }
  return records;
}

export async function saveMergeGroupRecord(
  git: GitRunner,
  mergeGroupId: string,
  record: MergeGroupRecord,
  opts?: GitOpts,
): Promise<void> {
  const content = JSON.stringify(record);

  // Write blob
  const blob = await git.run(["hash-object", "-w", "--stdin"], { ...opts, stdin: content });
  if (blob.exitCode !== 0)
    throw new Error(`saveMergeGroupRecord: hash-object failed: ${blob.stderr}`);
  const blobSha = blob.stdout.trim();

  // Read existing tree entries (excluding this id)
  const existing: string[] = [];
  const ls = await git.run(["ls-tree", MERGE_GROUPS_REF], opts);
  if (ls.exitCode === 0) {
    for (const line of ls.stdout.trim().split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab !== -1 && line.slice(tab + 1) !== mergeGroupId) existing.push(line);
    }
  }

  // Build new tree
  const newEntry = `100644 blob ${blobSha}\t${mergeGroupId}`;
  const treeInput = [...existing, newEntry].join("\n") + "\n";
  const tree = await git.run(["mktree"], { ...opts, stdin: treeInput });
  if (tree.exitCode !== 0) throw new Error(`saveMergeGroupRecord: mktree failed: ${tree.stderr}`);
  const treeSha = tree.stdout.trim();

  // Create commit (with parent if ref exists)
  const commitArgs = ["commit-tree", treeSha, "-m", `set merge-group record: ${mergeGroupId}`];
  const parent = await git.run(["rev-parse", "--verify", MERGE_GROUPS_REF], opts);
  if (parent.exitCode === 0) commitArgs.push("-p", parent.stdout.trim());
  const commit = await git.run(commitArgs, opts);
  if (commit.exitCode !== 0)
    throw new Error(`saveMergeGroupRecord: commit-tree failed: ${commit.stderr}`);

  // Update ref
  const ref = await git.run(["update-ref", MERGE_GROUPS_REF, commit.stdout.trim()], opts);
  if (ref.exitCode !== 0) throw new Error(`saveMergeGroupRecord: update-ref failed: ${ref.stderr}`);
}

export async function saveAllMergeGroupRecords(
  git: GitRunner,
  records: MergeGroupRecords,
  opts?: GitOpts,
): Promise<void> {
  const entries: string[] = [];

  for (const [mergeGroupId, record] of Object.entries(records)) {
    const content = JSON.stringify(record);
    const blob = await git.run(["hash-object", "-w", "--stdin"], { ...opts, stdin: content });
    if (blob.exitCode !== 0)
      throw new Error(`saveAllMergeGroupRecords: hash-object failed: ${blob.stderr}`);
    entries.push(`100644 blob ${blob.stdout.trim()}\t${mergeGroupId}`);
  }

  const treeInput = entries.length > 0 ? entries.join("\n") + "\n" : "";
  const tree = await git.run(["mktree"], { ...opts, stdin: treeInput });
  if (tree.exitCode !== 0)
    throw new Error(`saveAllMergeGroupRecords: mktree failed: ${tree.stderr}`);
  const treeSha = tree.stdout.trim();

  const commitArgs = ["commit-tree", treeSha, "-m", "update merge-group records"];
  const parent = await git.run(["rev-parse", "--verify", MERGE_GROUPS_REF], opts);
  if (parent.exitCode === 0) commitArgs.push("-p", parent.stdout.trim());
  const commit = await git.run(commitArgs, opts);
  if (commit.exitCode !== 0)
    throw new Error(`saveAllMergeGroupRecords: commit-tree failed: ${commit.stderr}`);

  const ref = await git.run(["update-ref", MERGE_GROUPS_REF, commit.stdout.trim()], opts);
  if (ref.exitCode !== 0)
    throw new Error(`saveAllMergeGroupRecords: update-ref failed: ${ref.stderr}`);
}

export async function fetchMergeGroupRecords(
  git: GitRunner,
  remote: string,
  opts?: GitOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  // Remote side goes through the test seam (identity in production).
  const refspec = `${remoteSpryRef(MERGE_GROUPS_REF)}:${MERGE_GROUPS_REF}`;
  const result = await git.run(["fetch", remote, refspec], opts);
  if (result.exitCode === 0) return { ok: true };
  if (result.stderr.includes("couldn't find remote ref")) return { ok: true };
  return { ok: false, warning: result.stderr.trim() };
}

export async function pushMergeGroupRecords(
  git: GitRunner,
  remote: string,
  opts?: GitOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  // Remote side goes through the test seam (identity in production).
  const refspec = `${MERGE_GROUPS_REF}:${remoteSpryRef(MERGE_GROUPS_REF)}`;
  const result = await git.run(["push", remote, refspec], opts);
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, warning: result.stderr.trim() };
}
