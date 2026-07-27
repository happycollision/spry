import type { GitRunner } from "../lib/context.ts";
import { getFullSha, getMergeBase } from "./queries.ts";

export interface BehindOptions {
  cwd?: string;
}

export interface FetchResult {
  ok: boolean;
  stderr: string;
}

export interface FetchRemoteOptions extends BehindOptions {
  /**
   * Explicit refspecs to fetch instead of the remote's configured defaults.
   * When omitted, `git fetch <remote>` pulls every ref the remote advertises
   * (the historical behavior, kept for callers like `sp rebase` that operate on
   * arbitrary branches). Passing a narrowed list — e.g. just trunk and the spry
   * branch prefix — avoids downloading unrelated refs on large repos while still
   * updating the remote-tracking refs the caller reads.
   */
  refspecs?: string[];
}

export async function fetchRemote(
  git: GitRunner,
  remote: string,
  options?: FetchRemoteOptions,
): Promise<FetchResult> {
  const refspecs = options?.refspecs ?? [];
  const result = await git.run(["fetch", remote, ...refspecs], { cwd: options?.cwd });
  return {
    ok: result.exitCode === 0,
    stderr: result.stderr,
  };
}

/**
 * Refspecs that update exactly the remote-tracking refs `sp sync` reads:
 * trunk (`refs/remotes/<remote>/<trunk>`, resolved by `trunkRef`) and every
 * spry unit branch (`refs/remotes/<remote>/<prefix>/*`, read by
 * `snapshotRemoteTips` and remote-branch existence checks). Force-updated
 * (`+`) to match a bare fetch's non-fast-forward handling of these
 * force-pushed branches.
 */
export function syncFetchRefspecs(remote: string, trunk: string, branchPrefix: string): string[] {
  return [
    `+refs/heads/${trunk}:refs/remotes/${remote}/${trunk}`,
    `+refs/heads/${branchPrefix}/*:refs/remotes/${remote}/${branchPrefix}/*`,
  ];
}

export async function isStackBehindTrunk(
  git: GitRunner,
  trunkRef: string,
  options?: BehindOptions,
): Promise<boolean> {
  const [trunkSha, mergeBase] = await Promise.all([
    getFullSha(git, trunkRef, options),
    getMergeBase(git, trunkRef, options),
  ]);
  return mergeBase !== trunkSha;
}

export async function isStackBehindTrunkForBranch(
  git: GitRunner,
  branch: string,
  trunkRef: string,
  options?: BehindOptions,
): Promise<boolean> {
  const result = await git.run(["merge-base", branch, trunkRef], { cwd: options?.cwd });
  const mergeBase = result.stdout.trim();
  const trunkSha = await getFullSha(git, trunkRef, options);
  return mergeBase !== trunkSha;
}
