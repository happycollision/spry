import type { GitRunner } from "../lib/context.ts";
import type { CommitInfo } from "../parse/types.ts";

export interface QueryOptions {
  cwd?: string;
}

// --- Task 5: branch state queries ---

export async function getCurrentBranch(git: GitRunner, options?: QueryOptions): Promise<string> {
  const result = await git.run(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: options?.cwd,
  });
  return result.stdout.trim();
}

export async function isDetachedHead(git: GitRunner, options?: QueryOptions): Promise<boolean> {
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

// Format: hash \0 subject \0 body \0 parents \x01. The trailing %P (parents) field
// lets the stack walk see topology — a commit with 2+ parents is a merge commit.
const STACK_LOG_FORMAT = "%H%x00%s%x00%b%x00%P%x01";

function parseCommitLog(output: string): CommitInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const records = trimmed.split("\x01").filter((r) => r.trim().length > 0);
  return records.map((record) => {
    const fields = record.split("\x00");
    const hash = (fields[0] ?? "").trim();
    const subject = (fields[1] ?? "").trim();
    const body = (fields[2] ?? "").replace(/\n+$/, "");
    const parentsRaw = (fields[3] ?? "").trim();
    const parents = parentsRaw ? parentsRaw.split(/\s+/) : [];
    return { hash, subject, body, trailers: {}, parents };
  });
}

// Walk the FIRST-PARENT line of the stack. On a linear stack this is identical to
// a plain `base..HEAD` walk; on a stack containing materialized merge commits it
// yields only the outer trunk line (plain commits + merge commits), excluding each
// merge's second-parent side branch. Use getMergeMembers to expand a merge's
// members.
export async function getStackCommits(
  git: GitRunner,
  trunkRef: string,
  options?: QueryOptions,
): Promise<CommitInfo[]> {
  const base = await getMergeBase(git, trunkRef, options);
  const result = await git.run(
    ["log", "--first-parent", "--reverse", `--format=${STACK_LOG_FORMAT}`, `${base}..HEAD`],
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
      "--first-parent",
      "--reverse",
      `--format=${STACK_LOG_FORMAT}`,
      `${trunkRef}..${branch}`,
    ],
    { cwd: options?.cwd },
  );
  return parseCommitLog(result.stdout);
}

// Expand a merge commit's side-branch members: the commits reachable from its
// SECOND parent but not its first (oldest-first). Returns the member CommitInfos
// (with their own parents populated). Returns [] if the commit is not a merge.
export async function getMergeMembers(
  git: GitRunner,
  mergeSha: string,
  options?: QueryOptions,
): Promise<CommitInfo[]> {
  const parentsResult = await git.run(["rev-list", "--parents", "-n", "1", mergeSha], {
    cwd: options?.cwd,
  });
  // Output: "<sha> <parent1> <parent2> ...". Fewer than 2 parents => not a merge.
  const shas = parentsResult.stdout.trim().split(/\s+/);
  const firstParent = shas[1];
  const secondParent = shas[2];
  if (!firstParent || !secondParent) return [];
  const result = await git.run(
    ["log", "--reverse", `--format=${STACK_LOG_FORMAT}`, `${firstParent}..${secondParent}`],
    { cwd: options?.cwd },
  );
  return parseCommitLog(result.stdout);
}
