import type { GitRunner } from "../lib/context.ts";
import type { CommitInfo, CommitTrailers } from "./types.ts";
import type { CommitWithTrailers } from "./stack.ts";

export interface TrailerOptions {
  cwd?: string;
}

export async function parseTrailers(
  commitBody: string,
  git: GitRunner,
  options?: TrailerOptions,
): Promise<CommitTrailers> {
  if (!commitBody.trim()) return {};

  const result = await git.run(["interpret-trailers", "--parse"], {
    stdin: commitBody,
    cwd: options?.cwd,
  });

  if (result.exitCode !== 0) {
    throw new Error(`git interpret-trailers --parse failed: ${result.stderr}`);
  }

  if (!result.stdout.trim()) return {};

  const trailers: CommitTrailers = {};
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (key) trailers[key] = value;
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

export async function parseCommitTrailers(
  commits: CommitInfo[],
  git: GitRunner,
  options?: TrailerOptions,
): Promise<CommitWithTrailers[]> {
  return Promise.all(
    commits.map(async (commit) => ({
      hash: commit.hash,
      subject: commit.subject,
      body: commit.body,
      // `interpret-trailers --parse` needs a full message (subject + blank
      // line + body) to recognize trailers. `commit.body` is body-only, so
      // reconstitute the full message before parsing.
      trailers: await parseTrailers(reconstructMessage(commit), git, options),
    })),
  );
}

function reconstructMessage(commit: CommitInfo): string {
  if (!commit.body) return commit.subject;
  return `${commit.subject}\n\n${commit.body}`;
}
