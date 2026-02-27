import type { GitRunner } from "../../tests/lib/context.ts";
import type { CommitTrailers } from "./types.ts";

export async function parseTrailers(commitBody: string, git: GitRunner): Promise<CommitTrailers> {
  if (!commitBody.trim()) return {};

  const result = await git.run(["interpret-trailers", "--parse"], {
    stdin: commitBody,
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
