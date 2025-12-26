import { $ } from "bun";
import type { GitOptions } from "./commands.ts";

export interface CommitTrailers {
  "Taspr-Commit-Id"?: string;
  "Taspr-Group-Start"?: string;
  "Taspr-Group-Title"?: string;
  "Taspr-Group-End"?: string;
  [key: string]: string | undefined;
}

/**
 * Parse trailers from a commit message body using git interpret-trailers.
 * If a key appears multiple times, the last value wins (git's behavior).
 */
export async function parseTrailers(commitBody: string): Promise<CommitTrailers> {
  if (!commitBody.trim()) {
    return {};
  }

  // Use Buffer for stdin redirection with Bun shell
  const input = Buffer.from(commitBody);
  const result = await $`git interpret-trailers --parse < ${input}`
    .nothrow()
    .text();

  if (!result.trim()) {
    return {};
  }

  const trailers: CommitTrailers = {};

  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match "Key: Value" format - the first colon separates key from value
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (key) {
      trailers[key] = value;
    }
  }

  return trailers;
}

/**
 * Get trailers for a specific commit by hash.
 */
export async function getCommitTrailers(
  commitHash: string,
  options: GitOptions = {}
): Promise<CommitTrailers> {
  const { cwd } = options;

  // Get the commit body (full message)
  const body = cwd
    ? await $`git -C ${cwd} log -1 --format=%B ${commitHash}`.text()
    : await $`git log -1 --format=%B ${commitHash}`.text();

  return parseTrailers(body);
}
