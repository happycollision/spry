import type { GitRunner } from "../lib/context.ts";

export interface PushOptions {
  cwd?: string;
  remote: string;
  sha: string;
  branch: string;
  forceWithLease: boolean;
}

export type PushResult =
  | { ok: true }
  | { ok: false; reason: "rejected" | "stale-ref"; stderr: string };

const STALE_REF_PATTERNS = [/stale info/i, /rejected.*non-fast-forward/i];

export async function pushBranch(git: GitRunner, opts: PushOptions): Promise<PushResult> {
  const refspec = `${opts.sha}:refs/heads/${opts.branch}`;
  const args = ["push", opts.remote, refspec];
  if (opts.forceWithLease) args.push("--force-with-lease");
  const result = await git.run(args, { cwd: opts.cwd });
  if (result.exitCode === 0) return { ok: true };
  const stderr = result.stderr;
  if (STALE_REF_PATTERNS.some((p) => p.test(stderr))) {
    return { ok: false, reason: "stale-ref", stderr };
  }
  return { ok: false, reason: "rejected", stderr };
}

export interface DeleteRemoteBranchOptions {
  cwd?: string;
  remote: string;
  branch: string;
}

export type DeleteRemoteBranchResult = { ok: true } | { ok: false; stderr: string };

export async function deleteRemoteBranch(
  git: GitRunner,
  opts: DeleteRemoteBranchOptions,
): Promise<DeleteRemoteBranchResult> {
  const result = await git.run(["push", opts.remote, "--delete", opts.branch], { cwd: opts.cwd });
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, stderr: result.stderr };
}

// Deleting a remote ref that is already gone upstream is benign — the ref is
// already in the state we want (an enumerate-then-vanish race, a stale tracking
// ref that survived a pruning fetch, or GitHub's "auto-delete head branches on
// merge" having removed it already). git reports this as
// `error: unable to delete '<name>': remote ref does not exist`.
const ALREADY_GONE = /remote ref does not exist/i;

export function isAlreadyGone(stderr: string): boolean {
  return ALREADY_GONE.test(stderr);
}

// Returns a map of remote branch name → tip SHA for every branch under `prefix`.
// The SHA lets callers skip a push when the remote tip already matches the local
// tip. The map still answers "does this branch exist?" via `.has(branch)`, so it
// is a drop-in for the previous `Set<string>` at every call site.
export async function listRemoteBranches(
  git: GitRunner,
  remote: string,
  prefix: string,
  opts?: { cwd?: string },
): Promise<Map<string, string>> {
  const result = await git.run(["ls-remote", "--heads", remote, `${prefix}/*`], { cwd: opts?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-remote failed: ${result.stderr.trim()}`);
  }
  const map = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const sha = trimmed.slice(0, tab).trim();
    const ref = trimmed.slice(tab + 1);
    if (ref.startsWith("refs/heads/")) {
      map.set(ref.slice("refs/heads/".length), sha);
    }
  }
  return map;
}
