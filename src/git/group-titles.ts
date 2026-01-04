import { $ } from "bun";
import type { GitOptions } from "./commands.ts";

/**
 * Group titles storage in git refs.
 *
 * Titles are stored in refs/taspr/<github-username>/group-titles as a JSON blob.
 * This decouples PR titles from commit trailers, allowing:
 * - Titles to be changed without rebasing
 * - Sync across machines via taspr sync
 * - Per-user namespace to avoid conflicts
 */

export type GroupTitles = Record<string, string>;

/**
 * Get the current GitHub username via gh cli.
 * Caches the result for the duration of the process.
 */
let cachedUsername: string | null = null;

export async function getGitHubUsername(): Promise<string> {
  if (cachedUsername) {
    return cachedUsername;
  }

  const result = await $`gh api user --jq .login`.nothrow().text();
  const username = result.trim();

  if (!username) {
    throw new Error("Could not determine GitHub username. Is `gh` authenticated?");
  }

  cachedUsername = username;
  return username;
}

/**
 * Get the ref path for group titles for the current user.
 */
export async function getGroupTitlesRef(): Promise<string> {
  const username = await getGitHubUsername();
  return `refs/taspr/${username}/group-titles`;
}

/**
 * Read all group titles from the ref storage.
 * Returns an empty object if the ref doesn't exist or is corrupted.
 */
export async function readGroupTitles(options: GitOptions = {}): Promise<GroupTitles> {
  const { cwd } = options;
  const ref = await getGroupTitlesRef();

  try {
    const result = cwd
      ? await $`git -C ${cwd} cat-file blob ${ref}`.nothrow().text()
      : await $`git cat-file blob ${ref}`.nothrow().text();

    if (!result.trim()) {
      return {};
    }

    const parsed = JSON.parse(result);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("Warning: Group titles ref contains invalid JSON, returning empty object");
      return {};
    }

    return parsed as GroupTitles;
  } catch {
    // Ref doesn't exist or JSON is corrupted
    return {};
  }
}

/**
 * Write all group titles to the ref storage.
 */
export async function writeGroupTitles(
  titles: GroupTitles,
  options: GitOptions = {},
): Promise<void> {
  const { cwd } = options;
  const ref = await getGroupTitlesRef();
  const json = JSON.stringify(titles, null, 2);
  const input = Buffer.from(json);

  // Write blob and get hash
  const hashResult = cwd
    ? await $`git -C ${cwd} hash-object -w --stdin < ${input}`.quiet().text()
    : await $`git hash-object -w --stdin < ${input}`.quiet().text();

  const hash = hashResult.trim();

  // Update ref to point to the new blob
  if (cwd) {
    await $`git -C ${cwd} update-ref ${ref} ${hash}`.quiet();
  } else {
    await $`git update-ref ${ref} ${hash}`.quiet();
  }
}

/**
 * Get a single group title.
 * Returns undefined if not found.
 */
export async function getGroupTitle(
  groupId: string,
  options: GitOptions = {},
): Promise<string | undefined> {
  const titles = await readGroupTitles(options);
  return titles[groupId];
}

/**
 * Set a single group title.
 */
export async function setGroupTitle(
  groupId: string,
  title: string,
  options: GitOptions = {},
): Promise<void> {
  const titles = await readGroupTitles(options);
  titles[groupId] = title;
  await writeGroupTitles(titles, options);
}

/**
 * Delete a single group title.
 */
export async function deleteGroupTitle(groupId: string, options: GitOptions = {}): Promise<void> {
  const titles = await readGroupTitles(options);
  delete titles[groupId];
  await writeGroupTitles(titles, options);
}

/**
 * Delete multiple group titles at once.
 */
export async function deleteGroupTitles(
  groupIds: string[],
  options: GitOptions = {},
): Promise<void> {
  const titles = await readGroupTitles(options);
  for (const id of groupIds) {
    delete titles[id];
  }
  await writeGroupTitles(titles, options);
}

/**
 * Push group titles to remote.
 */
export async function pushGroupTitles(options: GitOptions = {}): Promise<void> {
  const { cwd } = options;
  const ref = await getGroupTitlesRef();

  // Check if ref exists before pushing
  const checkResult = cwd
    ? await $`git -C ${cwd} rev-parse --verify ${ref}`.quiet().nothrow()
    : await $`git rev-parse --verify ${ref}`.quiet().nothrow();

  if (checkResult.exitCode !== 0) {
    // Ref doesn't exist, nothing to push
    return;
  }

  if (cwd) {
    await $`git -C ${cwd} push origin ${ref}`.quiet().nothrow();
  } else {
    await $`git push origin ${ref}`.quiet().nothrow();
  }
}

/**
 * Fetch group titles from remote.
 */
export async function fetchGroupTitles(options: GitOptions = {}): Promise<void> {
  const { cwd } = options;
  const ref = await getGroupTitlesRef();

  // Fetch the ref from remote (ignore errors if ref doesn't exist on remote)
  // Use quiet() to suppress stderr when ref doesn't exist
  if (cwd) {
    await $`git -C ${cwd} fetch origin ${ref}:${ref}`.quiet().nothrow();
  } else {
    await $`git fetch origin ${ref}:${ref}`.quiet().nothrow();
  }
}

/**
 * Purge orphaned titles - remove titles for groups that no longer exist.
 * Takes a list of current group IDs from the stack.
 */
export async function purgeOrphanedTitles(
  currentGroupIds: string[],
  options: GitOptions = {},
): Promise<string[]> {
  const titles = await readGroupTitles(options);
  const currentSet = new Set(currentGroupIds);
  const orphaned: string[] = [];

  for (const groupId of Object.keys(titles)) {
    if (!currentSet.has(groupId)) {
      orphaned.push(groupId);
      delete titles[groupId];
    }
  }

  if (orphaned.length > 0) {
    await writeGroupTitles(titles, options);
  }

  return orphaned;
}
