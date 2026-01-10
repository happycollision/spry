import { $ } from "bun";
import type { GitOptions } from "./commands.ts";
import type { TemplateLocation } from "./config.ts";
import { getGitHubUsername } from "./group-titles.ts";

/**
 * Stack settings storage in git refs.
 *
 * Settings are stored in refs/spry/<github-username>/stack-settings as a JSON blob.
 * This allows per-stack configuration that:
 * - Persists across machines via sp sync
 * - Per-user namespace to avoid conflicts
 * - Tracks content hashes to detect when PR bodies need updating
 */

export interface StackConfig {
  showStackLinks?: boolean;
  includePrTemplate?: boolean;
  prTemplateLocation?: TemplateLocation;
}

export interface StackSettings {
  /** Per-stack configuration, keyed by stack root unit ID */
  stacks: Record<string, StackConfig>;
  /** Content hashes for detecting body changes, keyed by unit ID */
  contentHashes: Record<string, string>;
}

/**
 * Get the ref path for stack settings for the current user.
 */
export async function getStackSettingsRef(): Promise<string> {
  const username = await getGitHubUsername();
  return `refs/spry/${username}/stack-settings`;
}

/**
 * Create an empty stack settings object.
 */
function emptyStackSettings(): StackSettings {
  return { stacks: {}, contentHashes: {} };
}

/**
 * Read all stack settings from the ref storage.
 * Returns an empty settings object if the ref doesn't exist or is corrupted.
 */
export async function readStackSettings(options: GitOptions = {}): Promise<StackSettings> {
  const { cwd } = options;
  const ref = await getStackSettingsRef();

  try {
    const result = cwd
      ? await $`git -C ${cwd} cat-file blob ${ref}`.nothrow().text()
      : await $`git cat-file blob ${ref}`.nothrow().text();

    if (!result.trim()) {
      return emptyStackSettings();
    }

    const parsed = JSON.parse(result);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("Warning: Stack settings ref contains invalid JSON, returning empty object");
      return emptyStackSettings();
    }

    // Ensure both keys exist
    return {
      stacks: parsed.stacks || {},
      contentHashes: parsed.contentHashes || {},
    };
  } catch {
    // Ref doesn't exist or JSON is corrupted
    return emptyStackSettings();
  }
}

/**
 * Write all stack settings to the ref storage.
 */
export async function writeStackSettings(
  settings: StackSettings,
  options: GitOptions = {},
): Promise<void> {
  const { cwd } = options;
  const ref = await getStackSettingsRef();
  const json = JSON.stringify(settings, null, 2);
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
 * Get configuration for a specific stack.
 * Returns undefined if no config exists for the stack.
 */
export async function getStackConfig(
  stackRootId: string,
  options: GitOptions = {},
): Promise<StackConfig | undefined> {
  const settings = await readStackSettings(options);
  return settings.stacks[stackRootId];
}

/**
 * Set configuration for a specific stack.
 */
export async function setStackConfig(
  stackRootId: string,
  config: StackConfig,
  options: GitOptions = {},
): Promise<void> {
  const settings = await readStackSettings(options);
  settings.stacks[stackRootId] = config;
  await writeStackSettings(settings, options);
}

/**
 * Delete configuration for a specific stack.
 */
export async function deleteStackConfig(
  stackRootId: string,
  options: GitOptions = {},
): Promise<void> {
  const settings = await readStackSettings(options);
  delete settings.stacks[stackRootId];
  await writeStackSettings(settings, options);
}

/**
 * Get the content hash for a unit (used to detect if PR body needs updating).
 * Returns undefined if no hash exists.
 */
export async function getContentHash(
  unitId: string,
  options: GitOptions = {},
): Promise<string | undefined> {
  const settings = await readStackSettings(options);
  return settings.contentHashes[unitId];
}

/**
 * Set the content hash for a unit.
 */
export async function setContentHash(
  unitId: string,
  hash: string,
  options: GitOptions = {},
): Promise<void> {
  const settings = await readStackSettings(options);
  settings.contentHashes[unitId] = hash;
  await writeStackSettings(settings, options);
}

/**
 * Set multiple content hashes at once (more efficient for batch updates).
 */
export async function setContentHashes(
  hashes: Record<string, string>,
  options: GitOptions = {},
): Promise<void> {
  const settings = await readStackSettings(options);
  Object.assign(settings.contentHashes, hashes);
  await writeStackSettings(settings, options);
}

/**
 * Delete the content hash for a unit.
 */
export async function deleteContentHash(unitId: string, options: GitOptions = {}): Promise<void> {
  const settings = await readStackSettings(options);
  delete settings.contentHashes[unitId];
  await writeStackSettings(settings, options);
}

/**
 * Push stack settings to remote.
 */
export async function pushStackSettings(options: GitOptions = {}): Promise<void> {
  const { cwd } = options;
  const ref = await getStackSettingsRef();

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
 * Fetch stack settings from remote.
 */
export async function fetchStackSettings(options: GitOptions = {}): Promise<void> {
  const { cwd } = options;
  const ref = await getStackSettingsRef();

  // Fetch the ref from remote (ignore errors if ref doesn't exist on remote)
  if (cwd) {
    await $`git -C ${cwd} fetch origin ${ref}:${ref}`.quiet().nothrow();
  } else {
    await $`git fetch origin ${ref}:${ref}`.quiet().nothrow();
  }
}

/**
 * Purge orphaned settings - remove configs and hashes for units that no longer exist.
 * Takes a list of current unit IDs from the stack.
 * Returns the IDs that were purged.
 */
export async function purgeOrphanedSettings(
  currentUnitIds: string[],
  options: GitOptions = {},
): Promise<{ stackIds: string[]; hashIds: string[] }> {
  const settings = await readStackSettings(options);
  const currentSet = new Set(currentUnitIds);
  const orphanedStackIds: string[] = [];
  const orphanedHashIds: string[] = [];

  // Purge orphaned stack configs
  for (const stackId of Object.keys(settings.stacks)) {
    if (!currentSet.has(stackId)) {
      orphanedStackIds.push(stackId);
      delete settings.stacks[stackId];
    }
  }

  // Purge orphaned content hashes
  for (const hashId of Object.keys(settings.contentHashes)) {
    if (!currentSet.has(hashId)) {
      orphanedHashIds.push(hashId);
      delete settings.contentHashes[hashId];
    }
  }

  if (orphanedStackIds.length > 0 || orphanedHashIds.length > 0) {
    await writeStackSettings(settings, options);
  }

  return { stackIds: orphanedStackIds, hashIds: orphanedHashIds };
}
