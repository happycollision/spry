import { $ } from "bun";
import type { CommitInfo } from "../types.ts";
import { parseTrailers } from "./trailers.ts";
import type { CommitWithTrailers } from "../core/stack.ts";

export interface GitOptions {
  cwd?: string;
}

/**
 * Get the merge-base between HEAD and origin/main.
 * This is the commit where the current branch diverged from main.
 */
export async function getMergeBase(options: GitOptions = {}): Promise<string> {
  const { cwd } = options;
  try {
    const result = cwd
      ? await $`git -C ${cwd} merge-base HEAD origin/main`.text()
      : await $`git merge-base HEAD origin/main`.text();
    return result.trim();
  } catch {
    // Check if origin/main exists
    const remoteCheck = cwd
      ? await $`git -C ${cwd} rev-parse --verify origin/main 2>/dev/null`.nothrow()
      : await $`git rev-parse --verify origin/main 2>/dev/null`.nothrow();
    if (remoteCheck.exitCode !== 0) {
      throw new Error(
        "No origin/main branch found. Please ensure you have a remote named 'origin' with a 'main' branch."
      );
    }
    throw new Error("Failed to find merge-base with origin/main");
  }
}

/**
 * Get all commits in the stack (between merge-base and HEAD).
 * Returns commits in oldest-to-newest order (bottom of stack first).
 */
export async function getStackCommits(options: GitOptions = {}): Promise<CommitInfo[]> {
  const { cwd } = options;
  const mergeBase = await getMergeBase(options);

  // Get commits with null-byte separators for reliable parsing
  // %H = hash, %s = subject, %B = full body (includes subject)
  // Using %x00 for null bytes between fields, %x01 as record separator
  const result = cwd
    ? await $`git -C ${cwd} log --reverse --format=%H%x00%s%x00%B%x01 ${mergeBase}..HEAD`.text()
    : await $`git log --reverse --format=%H%x00%s%x00%B%x01 ${mergeBase}..HEAD`.text();

  if (!result.trim()) {
    return [];
  }

  const commits: CommitInfo[] = [];

  // Split by record separator and filter empty entries
  const records = result.split('\x01').filter(r => r.trim());

  for (const record of records) {
    const [hashRaw, subject, body] = record.split('\x00');
    if (hashRaw && subject !== undefined && body !== undefined) {
      commits.push({
        hash: hashRaw.trim(),
        subject,
        body,
        trailers: {}, // Trailers will be parsed by the trailers module
      });
    }
  }

  return commits;
}

/**
 * Check if there are uncommitted changes in the working tree.
 */
export async function hasUncommittedChanges(options: GitOptions = {}): Promise<boolean> {
  const { cwd } = options;
  const result = cwd
    ? await $`git -C ${cwd} status --porcelain`.text()
    : await $`git status --porcelain`.text();
  return result.trim().length > 0;
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(options: GitOptions = {}): Promise<string> {
  const { cwd } = options;
  const result = cwd
    ? await $`git -C ${cwd} rev-parse --abbrev-ref HEAD`.text()
    : await $`git rev-parse --abbrev-ref HEAD`.text();
  return result.trim();
}

/**
 * Get all commits in the stack with their trailers parsed.
 * Returns commits in oldest-to-newest order (bottom of stack first).
 */
export async function getStackCommitsWithTrailers(
  options: GitOptions = {}
): Promise<CommitWithTrailers[]> {
  const commits = await getStackCommits(options);

  const commitsWithTrailers: CommitWithTrailers[] = await Promise.all(
    commits.map(async (commit) => {
      const trailers = await parseTrailers(commit.body);
      return {
        ...commit,
        trailers,
      };
    })
  );

  return commitsWithTrailers;
}
