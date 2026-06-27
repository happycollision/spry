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

export async function listRemoteBranches(
  git: GitRunner,
  remote: string,
  prefix: string,
  opts?: { cwd?: string },
): Promise<Set<string>> {
  const result = await git.run(["ls-remote", "--heads", remote, `${prefix}/*`], { cwd: opts?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-remote failed: ${result.stderr.trim()}`);
  }
  const set = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const ref = trimmed.slice(tab + 1);
    if (ref.startsWith("refs/heads/")) {
      set.add(ref.slice("refs/heads/".length));
    }
  }
  return set;
}
