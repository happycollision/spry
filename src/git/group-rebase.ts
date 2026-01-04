import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink, chmod, writeFile } from "node:fs/promises";
import type { GitOptions } from "./commands.ts";
import { getMergeBase, getStackCommitsWithTrailers } from "./commands.ts";
import { generateCommitId } from "../core/id.ts";
import {
  setGroupTitle,
  deleteGroupTitle,
  deleteGroupTitles,
  readGroupTitles,
  writeGroupTitles,
} from "./group-titles.ts";

/**
 * Run an interactive rebase with a custom sequence editor script.
 * Uses --no-autosquash to prevent fixup!/amend! commits from being auto-reordered.
 *
 * @param script - Shell script content for GIT_SEQUENCE_EDITOR
 * @param mergeBase - The merge base to rebase onto
 * @param options - Git options (cwd)
 * @returns Result with success status and optional error/conflict info
 */
async function runInteractiveRebase(
  script: string,
  mergeBase: string,
  options: GitOptions = {},
): Promise<ReorderResult> {
  const { cwd } = options;
  const scriptPath = join(tmpdir(), `taspr-rebase-${Date.now()}.sh`);

  try {
    await writeFile(scriptPath, script);
    await chmod(scriptPath, "755");

    const result = cwd
      ? await $`GIT_SEQUENCE_EDITOR=${scriptPath} git -C ${cwd} rebase -i --no-autosquash ${mergeBase}`
          .quiet()
          .nothrow()
      : await $`GIT_SEQUENCE_EDITOR=${scriptPath} git rebase -i --no-autosquash ${mergeBase}`
          .quiet()
          .nothrow();

    if (result.exitCode !== 0) {
      // Check for conflict
      const statusResult = cwd
        ? await $`git -C ${cwd} status --porcelain`.text()
        : await $`git status --porcelain`.text();

      const conflictMatch = statusResult.match(/^(?:UU|AA|DD|AU|UA|DU|UD) (.+)$/m);

      if (conflictMatch?.[1]) {
        return {
          success: false,
          error: "Rebase conflict",
          conflictFile: conflictMatch[1],
        };
      }

      return { success: false, error: result.stderr.toString() };
    }

    return { success: true };
  } finally {
    try {
      await unlink(scriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Create a rebase sequence editor script from todo lines.
 */
function createRebaseScript(todoLines: string[]): string {
  return `#!/bin/bash
set -e
TODO_FILE="$1"

cat > "$TODO_FILE" << 'TODOEOF'
${todoLines.join("\n")}
TODOEOF
`;
}

export interface GroupAssignment {
  /** Commit hashes in this group (oldest first) */
  commits: string[];
  /** User-provided group name */
  name: string;
  /** Optional existing group ID to preserve (for repair operations) */
  id?: string;
}

export interface GroupSpec {
  /** New order of commit hashes (oldest first). If omitted, order is unchanged. */
  order?: string[];
  /** Groups to create */
  groups: GroupAssignment[];
}

export interface ReorderResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** If there was a conflict, the first conflicting file */
  conflictFile?: string;
}

/**
 * Check if two arrays have the same elements in the same order.
 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, i) => val === b[i]);
}

/**
 * Apply a group specification to the current stack.
 * This is the main entry point for both interactive and non-interactive modes.
 *
 * The spec contains:
 * - order: Optional new order of commits (by hash or Taspr-Commit-Id)
 * - groups: Array of {commits: string[], name: string} to create groups
 *
 * @param spec - The group specification
 * @param options - Git options
 */
export async function applyGroupSpec(
  spec: GroupSpec,
  options: GitOptions = {},
): Promise<ReorderResult> {
  // Get current commits
  const commits = await getStackCommitsWithTrailers(options);
  if (commits.length === 0) {
    return { success: true };
  }

  const currentHashes = commits.map((c) => c.hash);
  const currentOrder = [...currentHashes];

  // Build ID to hash mapping for resolving references
  const idToHash = new Map<string, string>();
  const hashToId = new Map<string, string>();
  for (const commit of commits) {
    const id = commit.trailers["Taspr-Commit-Id"];
    if (id) {
      idToHash.set(id, commit.hash);
      hashToId.set(commit.hash, id);
    }
    // Also allow short hash references
    idToHash.set(commit.hash.slice(0, 7), commit.hash);
    idToHash.set(commit.hash.slice(0, 8), commit.hash);
    idToHash.set(commit.hash, commit.hash);
  }

  // Resolve order references to full hashes
  let newOrder = currentOrder;
  if (spec.order && spec.order.length > 0) {
    newOrder = spec.order.map((ref) => {
      const resolved = idToHash.get(ref);
      if (!resolved) {
        throw new Error(`Unknown commit reference: ${ref}`);
      }
      return resolved;
    });
  }

  // Resolve group commit references to full hashes
  const resolvedGroups: GroupAssignment[] = spec.groups.map((g) => ({
    name: g.name,
    id: g.id, // Preserve existing ID if provided
    commits: g.commits.map((ref) => {
      const resolved = idToHash.get(ref);
      if (!resolved) {
        throw new Error(`Unknown commit reference in group "${g.name}": ${ref}`);
      }
      return resolved;
    }),
  }));

  // Validate that group commits are contiguous in the new order
  for (const group of resolvedGroups) {
    if (group.commits.length <= 1) {
      continue; // Single-commit groups are always valid
    }

    // Find positions of group commits in the new order
    const positions = group.commits.map((hash) => newOrder.indexOf(hash));

    // Check for any commits not found in the order
    if (positions.some((p) => p === -1)) {
      throw new Error(`Group "${group.name}" contains commits not in the stack`);
    }

    // Sort positions and check they are consecutive
    const sortedPositions = [...positions].sort((a, b) => a - b);
    for (let i = 1; i < sortedPositions.length; i++) {
      const current = sortedPositions[i];
      const previous = sortedPositions[i - 1];
      if (current !== undefined && previous !== undefined && current !== previous + 1) {
        throw new Error(`Group "${group.name}" has non-contiguous commits`);
      }
    }
  }

  // Build the trailer map: which trailers to add to which commits
  // Key is commit hash, value is trailers to add
  const trailerMap = new Map<string, Record<string, string>>();

  // Track group titles to save to ref storage
  const groupTitlesToSave: Array<{ id: string; name: string }> = [];

  for (const group of resolvedGroups) {
    if (group.commits.length === 0) {
      continue;
    }

    // Use existing ID if provided (for repair operations), otherwise generate new
    const groupId = group.id ?? generateCommitId();

    // Track title to save to ref storage
    groupTitlesToSave.push({ id: groupId, name: group.name });

    // Add Taspr-Group trailer to ALL commits in the group (no longer adding title trailer)
    for (const commitHash of group.commits) {
      const existing = trailerMap.get(commitHash) ?? {};
      trailerMap.set(commitHash, {
        ...existing,
        "Taspr-Group": groupId,
      });
    }
  }

  // Check which commits currently have group trailers (to remove them)
  // Also check for legacy Taspr-Group-Title trailers that need cleanup
  const commitsWithGroupTrailers = new Set<string>();
  for (const commit of commits) {
    if (commit.trailers["Taspr-Group"] || commit.trailers["Taspr-Group-Title"]) {
      commitsWithGroupTrailers.add(commit.hash);
    }
  }

  // Check if we need to do anything
  const needsReorder = !arraysEqual(currentOrder, newOrder);
  const needsTrailers = trailerMap.size > 0;
  const needsRemoval = commitsWithGroupTrailers.size > 0;

  if (!needsReorder && !needsTrailers && !needsRemoval) {
    return { success: true };
  }

  // Get merge base
  const mergeBase = await getMergeBase(options);

  // Build the new todo content
  const todoLines: string[] = [];
  for (const hash of newOrder) {
    todoLines.push(`pick ${hash}`);

    const needsRemoval = commitsWithGroupTrailers.has(hash);
    const newTrailers = trailerMap.get(hash);

    if (needsRemoval || newTrailers) {
      // Build the exec command
      // First, remove existing group trailers (grep -v)
      // Then, add new trailers if any
      let cmd = "NEW_MSG=$(git log -1 --format=%B";

      // Always strip existing group trailers first (Taspr-Group: and Taspr-Group-Title:)
      cmd += ' | grep -v -e "^Taspr-Group:" -e "^Taspr-Group-Title:"';

      // Then add new trailers if specified
      if (newTrailers) {
        const trailerArgs = Object.entries(newTrailers)
          .map(([k, v]) => `--trailer "${k}: ${v}"`)
          .join(" ");
        cmd += ` | git interpret-trailers ${trailerArgs}`;
      }

      cmd += ') && git commit --amend --no-edit -m "$NEW_MSG"';

      todoLines.push(`exec ${cmd}`);
    }
  }

  const result = await runInteractiveRebase(createRebaseScript(todoLines), mergeBase, options);

  // Save group titles to ref storage if rebase succeeded
  if (result.success && groupTitlesToSave.length > 0) {
    const existingTitles = await readGroupTitles(options);
    for (const { id, name } of groupTitlesToSave) {
      existingTitles[id] = name;
    }
    await writeGroupTitles(existingTitles, options);
  }

  return result;
}

/**
 * Parse a JSON group spec string.
 */
export function parseGroupSpec(json: string): GroupSpec {
  const parsed = JSON.parse(json);

  // Validate structure
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Group spec must be an object");
  }

  const spec: GroupSpec = {
    groups: [],
  };

  if (parsed.order !== undefined) {
    if (!Array.isArray(parsed.order)) {
      throw new Error("order must be an array");
    }
    spec.order = parsed.order;
  }

  if (parsed.groups !== undefined) {
    if (!Array.isArray(parsed.groups)) {
      throw new Error("groups must be an array");
    }

    for (const g of parsed.groups) {
      if (typeof g !== "object" || g === null) {
        throw new Error("Each group must be an object");
      }
      if (!Array.isArray(g.commits)) {
        throw new Error("Each group must have a commits array");
      }
      if (typeof g.name !== "string") {
        throw new Error("Each group must have a name string");
      }

      spec.groups.push({
        commits: g.commits,
        name: g.name,
      });
    }
  }

  return spec;
}

/**
 * Dissolve a specific group by removing its trailers.
 */
export async function dissolveGroup(
  groupId: string,
  options: GitOptions = {},
): Promise<ReorderResult> {
  const commits = await getStackCommitsWithTrailers(options);

  // Find commits belonging to this group
  const groupCommits = commits.filter((c) => c.trailers["Taspr-Group"] === groupId);

  if (groupCommits.length === 0) {
    return { success: false, error: `Group ${groupId} not found` };
  }

  const mergeBase = await getMergeBase(options);

  // Build todo with exec commands to remove group trailers
  const todoLines: string[] = [];
  for (const commit of commits) {
    todoLines.push(`pick ${commit.hash}`);

    // Check if this commit belongs to the group we're dissolving
    if (commit.trailers["Taspr-Group"] === groupId) {
      // Remove Taspr-Group trailer (and legacy Taspr-Group-Title if present)
      todoLines.push(
        `exec NEW_MSG=$(git log -1 --format=%B | grep -v -e "^Taspr-Group: ${groupId}$" -e "^Taspr-Group-Title:") && git commit --amend --no-edit -m "$NEW_MSG"`,
      );
    }
  }

  const result = await runInteractiveRebase(createRebaseScript(todoLines), mergeBase, options);

  // Delete group title from ref storage if rebase succeeded
  if (result.success) {
    await deleteGroupTitle(groupId, options);
  }

  return result;
}

/**
 * Abort an in-progress rebase.
 */
export async function abortRebase(options: GitOptions = {}): Promise<void> {
  const { cwd } = options;
  if (cwd) {
    await $`git -C ${cwd} rebase --abort`.quiet().nothrow();
  } else {
    await $`git rebase --abort`.quiet().nothrow();
  }
}

/**
 * Add group trailers to a commit (used for fixing split groups).
 * Adds Taspr-Group trailer and saves title to ref storage.
 */
export async function addGroupTrailers(
  commitHash: string,
  groupId: string,
  groupTitle: string,
  options: GitOptions = {},
): Promise<ReorderResult> {
  const commits = await getStackCommitsWithTrailers(options);

  const targetCommit = commits.find((c) => c.hash === commitHash || c.hash.startsWith(commitHash));
  if (!targetCommit) {
    return { success: false, error: `Commit ${commitHash} not found in stack` };
  }

  const mergeBase = await getMergeBase(options);

  // Build todo with exec command to add the trailer
  const todoLines: string[] = [];
  for (const commit of commits) {
    todoLines.push(`pick ${commit.hash}`);

    if (commit.hash === targetCommit.hash) {
      // Add Taspr-Group trailer only (title goes to ref storage)
      const cmd = `NEW_MSG=$(git log -1 --format=%B | git interpret-trailers --trailer "Taspr-Group: ${groupId}") && git commit --amend --no-edit -m "$NEW_MSG"`;
      todoLines.push(`exec ${cmd}`);
    }
  }

  const result = await runInteractiveRebase(createRebaseScript(todoLines), mergeBase, options);

  // Save title to ref storage if rebase succeeded
  if (result.success) {
    await setGroupTitle(groupId, groupTitle, options);
  }

  return result;
}

/**
 * Remove group trailers from a specific commit.
 * Removes Taspr-Group and any legacy Taspr-Group-Title.
 */
export async function removeGroupTrailers(
  commitHash: string,
  groupId: string,
  options: GitOptions = {},
): Promise<ReorderResult> {
  const commits = await getStackCommitsWithTrailers(options);

  const targetCommit = commits.find((c) => c.hash === commitHash || c.hash.startsWith(commitHash));
  if (!targetCommit) {
    return { success: false, error: `Commit ${commitHash} not found in stack` };
  }

  const mergeBase = await getMergeBase(options);

  // Build todo with exec command to remove the trailers
  const todoLines: string[] = [];
  for (const commit of commits) {
    todoLines.push(`pick ${commit.hash}`);

    if (commit.hash === targetCommit.hash) {
      // Remove Taspr-Group and any legacy Taspr-Group-Title trailers
      todoLines.push(
        `exec NEW_MSG=$(git log -1 --format=%B | grep -v -e "^Taspr-Group: ${groupId}$" -e "^Taspr-Group-Title:") && git commit --amend --no-edit -m "$NEW_MSG"`,
      );
    }
  }

  return runInteractiveRebase(createRebaseScript(todoLines), mergeBase, options);
}

/**
 * Update group title in ref storage.
 * No longer modifies commit trailers - titles are stored in refs.
 */
export async function updateGroupTitleInRef(
  groupId: string,
  newTitle: string,
  options: GitOptions = {},
): Promise<void> {
  await setGroupTitle(groupId, newTitle, options);
}

/**
 * Merge a split group by reordering commits to be contiguous.
 * Moves all group commits together after the last interrupting commit.
 */
export async function mergeSplitGroup(
  groupId: string,
  options: GitOptions = {},
): Promise<ReorderResult> {
  const commits = await getStackCommitsWithTrailers(options);

  // Get title from ref storage
  const titles = await readGroupTitles(options);
  const groupTitle = titles[groupId];

  // Find all commits in the group and their positions
  const groupCommitHashes: string[] = [];
  const nonGroupCommitHashes: string[] = [];
  let firstCommitSubject = "";

  for (const commit of commits) {
    if (commit.trailers["Taspr-Group"] === groupId) {
      groupCommitHashes.push(commit.hash);
      if (!firstCommitSubject) {
        firstCommitSubject = commit.subject;
      }
    } else {
      nonGroupCommitHashes.push(commit.hash);
    }
  }

  if (groupCommitHashes.length === 0) {
    return { success: false, error: `Group ${groupId} not found` };
  }

  // New order: non-group commits first, then all group commits together
  // This preserves relative order within each set
  const newOrder = [...nonGroupCommitHashes, ...groupCommitHashes];

  // Use applyGroupSpec with the new order and preserve the original group ID
  // Group ID preservation is critical - it determines the branch name and PR association
  // Use title from ref storage, fall back to first commit subject
  return applyGroupSpec(
    {
      order: newOrder,
      groups: [
        {
          commits: groupCommitHashes,
          name: groupTitle || firstCommitSubject || "Unnamed Group",
          id: groupId,
        },
      ],
    },
    options,
  );
}

/**
 * Remove all group trailers from all commits in the stack.
 * Used by --fix to repair invalid group configurations.
 * Also clears all group titles from ref storage.
 */
export async function removeAllGroupTrailers(options: GitOptions = {}): Promise<ReorderResult> {
  const commits = await getStackCommitsWithTrailers(options);

  if (commits.length === 0) {
    // Still clear titles from ref storage
    await writeGroupTitles({}, options);
    return { success: true };
  }

  // Find commits that have any group trailers and collect group IDs to delete
  const commitsWithGroupTrailers = commits.filter(
    (c) => c.trailers["Taspr-Group"] || c.trailers["Taspr-Group-Title"],
  );
  const groupIdsToDelete = new Set<string>();
  for (const commit of commitsWithGroupTrailers) {
    const groupId = commit.trailers["Taspr-Group"];
    if (groupId) {
      groupIdsToDelete.add(groupId);
    }
  }

  if (commitsWithGroupTrailers.length === 0) {
    // Still clear titles from ref storage
    await writeGroupTitles({}, options);
    return { success: true };
  }

  const mergeBase = await getMergeBase(options);

  // Build todo with exec commands to remove all group trailers
  const todoLines: string[] = [];
  for (const commit of commits) {
    todoLines.push(`pick ${commit.hash}`);

    const hasGroupTrailers = commit.trailers["Taspr-Group"] || commit.trailers["Taspr-Group-Title"];

    if (hasGroupTrailers) {
      // Remove Taspr-Group and Taspr-Group-Title trailers
      todoLines.push(
        `exec NEW_MSG=$(git log -1 --format=%B | grep -v -e "^Taspr-Group:" -e "^Taspr-Group-Title:") && git commit --amend --allow-empty --no-edit -m "$NEW_MSG"`,
      );
    }
  }

  const result = await runInteractiveRebase(createRebaseScript(todoLines), mergeBase, options);

  // Clear group titles from ref storage if rebase succeeded
  if (result.success) {
    await deleteGroupTitles([...groupIdsToDelete], options);
  }

  return result;
}
