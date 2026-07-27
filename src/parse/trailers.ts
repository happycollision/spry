import type { GitRunner } from "../lib/context.ts";
import type { CommitInfo, CommitTrailers } from "./types.ts";
import type { CommitWithTrailers } from "./stack.ts";

export interface TrailerOptions {
  cwd?: string;
}

/**
 * A line git treats as a trailer: `Token: value`, token is a run of
 * letters/digits/hyphen. Mirrors the `TRAILER_LINE` convention in
 * `src/gh/pr-body.ts` (see the folded-trailer note there). Kept in sync with
 * that regex on purpose — both encode "what spry considers a trailer line".
 */
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/;

/**
 * Parse a commit's trailer block IN-PROCESS — no `git interpret-trailers`
 * subprocess. This is the hot read path: `sp sync` parses every commit's
 * trailers every run, and spawning git per commit cost ~0.03s each (~1s+ on a
 * 50-commit stack, plus process overhead). The trailers spry reads
 * (`Spry-Commit-Id`, `Co-Authored-By`, …) are simple, unfolded `Key: value`
 * lines, so an in-process parser is exact for them.
 *
 * Block detection matches git's rule as `stripTrailers` (src/gh/pr-body.ts)
 * encodes it: the trailer block is the run of consecutive trailer-lines at the
 * very end of the message (after trailing blanks are dropped), valid only when
 * that run is preceded by a blank line or the start of the message. If the last
 * paragraph is not all trailer-lines, there is no trailer block (matching
 * git's "a trailer paragraph is trailers-only" behavior for our inputs). Folded
 * (continuation) trailers are intentionally NOT supported — spry never emits
 * them; the same documented limitation as `stripTrailers`.
 */
export function parseTrailersSync(fullMessage: string): CommitTrailers {
  if (!fullMessage.trim()) return {};
  const lines = fullMessage.split("\n");

  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;

  let start = end;
  while (start > 0 && TRAILER_LINE.test(lines[start - 1] ?? "")) start--;

  // No trailer lines at the end, or the block is not preceded by a blank line
  // (i.e. it is glued to prose) → not a trailer block.
  if (start === end) return {};
  if (start > 0 && (lines[start - 1] ?? "").trim() !== "") return {};

  const trailers: CommitTrailers = {};
  for (let i = start; i < end; i++) {
    const m = TRAILER_LINE.exec(lines[i] ?? "");
    const key = m?.[1];
    if (!key) continue;
    // Last-wins on duplicate keys, matching the previous subprocess parser
    // (which overwrote `trailers[key]` as it iterated).
    trailers[key] = (m[2] ?? "").trim();
  }
  return trailers;
}

export async function addTrailers(
  message: string,
  trailers: Record<string, string>,
  git: GitRunner,
): Promise<string> {
  if (Object.keys(trailers).length === 0) return message;

  const args = ["interpret-trailers"];
  for (const [key, value] of Object.entries(trailers)) {
    args.push("--trailer", `${key}: ${value}`);
  }

  const normalizedMessage = message.endsWith("\n") ? message : message + "\n";
  const result = await git.run(args, { stdin: normalizedMessage });
  if (result.exitCode !== 0) {
    throw new Error(`git interpret-trailers failed: ${result.stderr}`);
  }
  return result.stdout.trimEnd();
}

export async function replaceCommitId(
  message: string,
  newId: string,
  git: GitRunner,
): Promise<string> {
  const normalized = message.endsWith("\n") ? message : message + "\n";
  const result = await git.run(
    [
      "interpret-trailers",
      "--if-exists",
      "replace",
      "--if-missing",
      "add",
      "--trailer",
      `Spry-Commit-Id: ${newId}`,
    ],
    { stdin: normalized },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git interpret-trailers (replace) failed: ${result.stderr}`);
  }
  return result.stdout.trimEnd();
}

/**
 * Async wrapper kept for the callers/tests that pass a `git` runner (e.g.
 * `src/git/rebase.ts`). Trailer parsing is now in-process — `git` is accepted
 * for signature compatibility but no longer used (no subprocess spawned).
 */
export async function parseTrailers(
  commitMessage: string,
  _git?: GitRunner,
  _options?: TrailerOptions,
): Promise<CommitTrailers> {
  return parseTrailersSync(commitMessage);
}

export function parseCommitTrailers(
  commits: CommitInfo[],
  _git?: GitRunner,
  _options?: TrailerOptions,
): CommitWithTrailers[] {
  // Trailers are parsed in-process from the message we already have — no git
  // subprocess per commit (the old hot-path cost on deep stacks).
  return commits.map((commit) => ({
    hash: commit.hash,
    subject: commit.subject,
    body: commit.body,
    // The sync parser needs a full message (subject + blank line + body) to
    // locate the trailer block; `commit.body` is body-only, so reconstitute.
    trailers: parseTrailersSync(reconstructMessage(commit)),
  }));
}

function reconstructMessage(commit: CommitInfo): string {
  if (!commit.body) return commit.subject;
  return `${commit.subject}\n\n${commit.body}`;
}
