import type { PRInfo } from "./pr.ts";
import type { GitRunner } from "../lib/context.ts";
import { isAlreadyGone } from "./push.ts";

export interface PRCacheEntry extends PRInfo {
  branch: string;
  cachedAt: string; // ISO 8601
}

// Keyed by unit ID (e.g. "aaa11111"), NOT branch name — unit IDs have no slashes,
// making them safe as git tree entry names without encoding.
export type PRCache = Record<string, PRCacheEntry>;

export const PR_CACHE_REF = "refs/spry/prs";

interface GitOpts {
  cwd?: string;
  stdin?: string;
}

export async function loadPRCache(git: GitRunner, opts?: GitOpts): Promise<PRCache> {
  const ls = await git.run(["ls-tree", PR_CACHE_REF], opts);
  if (ls.exitCode !== 0) return {};

  const cache: PRCache = {};
  for (const line of ls.stdout.trim().split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const unitId = line.slice(tab + 1);
    const cat = await git.run(["cat-file", "blob", `${PR_CACHE_REF}:${unitId}`], opts);
    if (cat.exitCode !== 0)
      throw new Error(`loadPRCache: cat-file failed for ${unitId}: ${cat.stderr}`);
    try {
      cache[unitId] = JSON.parse(cat.stdout.trim()) as PRCacheEntry;
    } catch {
      // Skip malformed entries
    }
  }
  return cache;
}

export async function savePRCache(git: GitRunner, cache: PRCache, opts?: GitOpts): Promise<void> {
  const entries: string[] = [];

  for (const [unitId, entry] of Object.entries(cache)) {
    const content = JSON.stringify(entry);
    const blob = await git.run(["hash-object", "-w", "--stdin"], { ...opts, stdin: content });
    if (blob.exitCode !== 0) throw new Error(`savePRCache: hash-object failed: ${blob.stderr}`);
    entries.push(`100644 blob ${blob.stdout.trim()}\t${unitId}`);
  }

  if (entries.length === 0) {
    // Delete the ref to clear the cache; ignore error if ref doesn't exist
    await git.run(["update-ref", "-d", PR_CACHE_REF], opts);
    return;
  }

  const treeInput = entries.join("\n") + "\n";
  const tree = await git.run(["mktree"], { ...opts, stdin: treeInput });
  if (tree.exitCode !== 0) throw new Error(`savePRCache: mktree failed: ${tree.stderr}`);

  const commitArgs = ["commit-tree", tree.stdout.trim(), "-m", "update pr cache"];
  const parent = await git.run(["rev-parse", "--verify", PR_CACHE_REF], opts);
  if (parent.exitCode === 0) commitArgs.push("-p", parent.stdout.trim());
  const commit = await git.run(commitArgs, opts);
  if (commit.exitCode !== 0) throw new Error(`savePRCache: commit-tree failed: ${commit.stderr}`);

  const ref = await git.run(["update-ref", PR_CACHE_REF, commit.stdout.trim()], opts);
  if (ref.exitCode !== 0) throw new Error(`savePRCache: update-ref failed: ${ref.stderr}`);
}

export async function fetchPRCache(
  git: GitRunner,
  remote: string,
  opts?: GitOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const refspec = `${PR_CACHE_REF}:${PR_CACHE_REF}`;
  const result = await git.run(["fetch", remote, refspec], opts);
  if (result.exitCode === 0) return { ok: true };
  if (result.stderr.includes("couldn't find remote ref")) return { ok: true };
  return { ok: false, warning: result.stderr.trim() };
}

export async function pushPRCache(
  git: GitRunner,
  remote: string,
  opts?: GitOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const refspec = `${PR_CACHE_REF}:${PR_CACHE_REF}`;
  const result = await git.run(["push", remote, refspec], opts);
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, warning: result.stderr.trim() };
}

/**
 * Delete the PR cache ref on the remote. Used when the local cache has been
 * emptied (`savePRCache` deletes the local ref in that case, so there is no
 * source ref to push — only a deletion to propagate). Best-effort like
 * {@link pushPRCache}; an already-gone remote ref is benign (nothing to delete).
 */
export async function deletePRCacheRemote(
  git: GitRunner,
  remote: string,
  opts?: GitOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const result = await git.run(["push", remote, `:${PR_CACHE_REF}`], opts);
  if (result.exitCode === 0 || isAlreadyGone(result.stderr)) return { ok: true };
  return { ok: false, warning: result.stderr.trim() };
}
