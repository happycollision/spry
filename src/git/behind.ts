import type { GitRunner } from "../lib/context.ts";
import { getFullSha, getMergeBase } from "./queries.ts";

export interface BehindOptions {
  cwd?: string;
}

export interface FetchResult {
  ok: boolean;
  stderr: string;
}

export async function fetchRemote(
  git: GitRunner,
  remote: string,
  options?: BehindOptions,
): Promise<FetchResult> {
  const result = await git.run(["fetch", remote], { cwd: options?.cwd });
  return {
    ok: result.exitCode === 0,
    stderr: result.stderr,
  };
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
