import type { GitRunner } from "../../tests/lib/context.ts";
import type { CommitInfo } from "../parse/types.ts";

export interface QueryOptions {
  cwd?: string;
}

// --- Task 5: branch state queries ---

export async function getCurrentBranch(
  git: GitRunner,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: options?.cwd,
  });
  return result.stdout.trim();
}

export async function isDetachedHead(
  git: GitRunner,
  options?: QueryOptions,
): Promise<boolean> {
  return (await getCurrentBranch(git, options)) === "HEAD";
}

// --- Task 6: utility queries ---

export async function hasUncommittedChanges(
  git: GitRunner,
  options?: QueryOptions,
): Promise<boolean> {
  const result = await git.run(["status", "--porcelain"], {
    cwd: options?.cwd,
  });
  return result.stdout.trim().length > 0;
}

export async function getFullSha(
  git: GitRunner,
  ref: string,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", ref], { cwd: options?.cwd });
  return result.stdout.trim();
}

export async function getShortSha(
  git: GitRunner,
  ref: string,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", "--short", ref], {
    cwd: options?.cwd,
  });
  return result.stdout.trim();
}

export async function getCommitMessage(
  git: GitRunner,
  commit: string,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["log", "-1", "--format=%B", commit], {
    cwd: options?.cwd,
  });
  return result.stdout.replace(/\n+$/, "");
}

// --- Task 7: stack queries ---

export async function getMergeBase(
  git: GitRunner,
  trunkRef: string,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["merge-base", "HEAD", trunkRef], {
    cwd: options?.cwd,
  });
  return result.stdout.trim();
}

function parseCommitLog(output: string): CommitInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const records = trimmed.split("\x01").filter((r) => r.trim().length > 0);
  return records.map((record) => {
    const fields = record.split("\x00");
    const hash = (fields[0] ?? "").trim();
    const subject = (fields[1] ?? "").trim();
    const body = (fields[2] ?? "").replace(/\n+$/, "");
    return { hash, subject, body, trailers: {} };
  });
}

export async function getStackCommits(
  git: GitRunner,
  trunkRef: string,
  options?: QueryOptions,
): Promise<CommitInfo[]> {
  const base = await getMergeBase(git, trunkRef, options);
  const result = await git.run(
    ["log", "--reverse", "--format=%H%x00%s%x00%B%x01", `${base}..HEAD`],
    { cwd: options?.cwd },
  );
  return parseCommitLog(result.stdout);
}

export async function getStackCommitsForBranch(
  git: GitRunner,
  branch: string,
  trunkRef: string,
  options?: QueryOptions,
): Promise<CommitInfo[]> {
  const result = await git.run(
    [
      "log",
      "--reverse",
      "--format=%H%x00%s%x00%B%x01",
      `${trunkRef}..${branch}`,
    ],
    { cwd: options?.cwd },
  );
  return parseCommitLog(result.stdout);
}
