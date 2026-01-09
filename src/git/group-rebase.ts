import type { GitOptions } from "./commands.ts";
import { getMergeBase, getStackCommitsWithTrailers, getCurrentBranch } from "./commands.ts";
import { generateCommitId } from "../core/id.ts";
import { asserted } from "../utils/assert.ts";
import {
  setGroupTitle,
  deleteGroupTitle,
  deleteGroupTitles,
  readGroupTitles,
  writeGroupTitles,
} from "./group-titles.ts";
import {
  getCommitMessage,
  rewriteCommitChain,
  finalizeRewrite,
  rebasePlumbing,
} from "./plumbing.ts";
import { addTrailers } from "./trailers.ts";

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
 * Remove group trailers (Spry-Group and legacy Spry-Group-Title) from a message.
 */
function stripGroupTrailers(message: string): string {
  return message
    .split("\n")
    .filter((line) => !line.startsWith("Spry-Group:") && !line.startsWith("Spry-Group-Title:"))
    .join("\n")
    .replace(/\n+$/, ""); // Trim trailing newlines
}

/**
 * Apply a group specification to the current stack.
 * Uses git plumbing when possible.
 *
 * The spec contains:
 * - order: Optional new order of commits (by hash or Spry-Commit-Id)
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
  for (const commit of commits) {
    const id = commit.trailers["Spry-Commit-Id"];
    if (id) {
      idToHash.set(id, commit.hash);
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

    // Add Spry-Group trailer to ALL commits in the group
    for (const commitHash of group.commits) {
      const existing = trailerMap.get(commitHash) ?? {};
      trailerMap.set(commitHash, {
        ...existing,
        "Spry-Group": groupId,
      });
    }
  }

  // Check which commits currently have group trailers (to remove them)
  const commitsWithGroupTrailers = new Set<string>();
  for (const commit of commits) {
    if (commit.trailers["Spry-Group"] || commit.trailers["Spry-Group-Title"]) {
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

  // Get current branch and tip for finalization
  const branch = await getCurrentBranch(options);
  const oldTip = asserted(currentHashes.at(-1));

  let finalTip: string;

  if (needsReorder) {
    // Need to reorder - use plumbing rebase
    const mergeBase = await getMergeBase(options);

    const rebaseResult = await rebasePlumbing(mergeBase, newOrder, options);

    if (!rebaseResult.ok) {
      // Conflict during reorder - return error
      return {
        success: false,
        error: "Conflict during reorder",
        conflictFile: rebaseResult.conflictInfo,
      };
    }

    // Now we have a new commit chain in the new order
    // Build a mapping from original hashes to new hashes
    const hashMapping = rebaseResult.mapping;

    // Build rewrites for message changes on the new commits
    const rewrites = new Map<string, string>();
    for (const originalHash of newOrder) {
      const newHash = asserted(hashMapping.get(originalHash));
      const originalMessage = await getCommitMessage(newHash, options);

      // Strip existing group trailers if this commit had them
      let baseMessage = commitsWithGroupTrailers.has(originalHash)
        ? stripGroupTrailers(originalMessage)
        : originalMessage;

      // Add new trailers if specified
      const newTrailers = trailerMap.get(originalHash);
      if (newTrailers) {
        baseMessage = await addTrailers(baseMessage, newTrailers);
      }

      // Only add to rewrites if message needs to change
      const needsChange = commitsWithGroupTrailers.has(originalHash) || newTrailers !== undefined;
      if (needsChange && baseMessage !== originalMessage) {
        rewrites.set(newHash, baseMessage);
      }
    }

    // If we have message changes, apply them to the reordered chain
    if (rewrites.size > 0) {
      const newHashes = newOrder.map((h) => asserted(hashMapping.get(h)));
      const chainResult = await rewriteCommitChain(newHashes, rewrites, options);
      finalTip = chainResult.newTip;
    } else {
      finalTip = rebaseResult.newTip;
    }
  } else {
    // No reorder needed - just message changes
    const rewrites = new Map<string, string>();

    for (const commit of commits) {
      const needsRemovalFlag = commitsWithGroupTrailers.has(commit.hash);
      const newTrailers = trailerMap.get(commit.hash);

      if (needsRemovalFlag || newTrailers) {
        let message = await getCommitMessage(commit.hash, options);

        // Strip existing group trailers
        if (needsRemovalFlag) {
          message = stripGroupTrailers(message);
        }

        // Add new trailers
        if (newTrailers) {
          message = await addTrailers(message, newTrailers);
        }

        rewrites.set(commit.hash, message);
      }
    }

    const chainResult = await rewriteCommitChain(currentHashes, rewrites, options);
    finalTip = chainResult.newTip;
  }

  // Finalize: update branch ref
  await finalizeRewrite(branch, oldTip, finalTip, options);

  // Save group titles to ref storage if operation succeeded
  if (groupTitlesToSave.length > 0) {
    const existingTitles = await readGroupTitles(options);
    for (const { id, name } of groupTitlesToSave) {
      existingTitles[id] = name;
    }
    await writeGroupTitles(existingTitles, options);
  }

  return { success: true };
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

export interface DissolveOptions extends GitOptions {
  /**
   * If specified, this commit (by hash) will be assigned the group's ID as its
   * Spry-Commit-Id, allowing it to inherit the group's PR association.
   *
   * This is only needed when the group has an open PR and you want a specific
   * commit to keep that PR. If the commit that originally donated its ID to
   * the group is NOT the one being assigned, it will get a new ID to avoid
   * conflicts.
   *
   * If not specified, all commits keep their original IDs (safe when no PR exists).
   */
  assignGroupIdToCommit?: string;
}

/**
 * Dissolve a specific group by removing its trailers.
 * Uses git plumbing (no working directory modifications for message-only changes).
 *
 * When a group is dissolved:
 * - If `assignGroupIdToCommit` is specified, that commit gets the group ID as its
 *   Spry-Commit-Id (inheriting the group's PR). If a different commit originally
 *   donated its ID to the group, that commit gets a new ID to avoid conflicts.
 * - If `assignGroupIdToCommit` is NOT specified, all commits keep their original
 *   Spry-Commit-Ids (the commit that donated its ID keeps it).
 */
export async function dissolveGroup(
  groupId: string,
  options: DissolveOptions = {},
): Promise<ReorderResult> {
  const { assignGroupIdToCommit, ...gitOptions } = options;
  const commits = await getStackCommitsWithTrailers(gitOptions);

  // Find commits belonging to this group
  const groupCommits = commits.filter((c) => c.trailers["Spry-Group"] === groupId);

  if (groupCommits.length === 0) {
    return { success: false, error: `Group ${groupId} not found` };
  }

  // Build rewrites map
  const rewrites = new Map<string, string>();

  for (const commit of commits) {
    // Check if this commit belongs to the group we're dissolving
    if (commit.trailers["Spry-Group"] === groupId) {
      const commitId = commit.trailers["Spry-Commit-Id"];
      let message = await getCommitMessage(commit.hash, gitOptions);

      // Remove group trailers
      message = message
        .split("\n")
        .filter(
          (line) => line !== `Spry-Group: ${groupId}` && !line.startsWith("Spry-Group-Title:"),
        )
        .join("\n")
        .replace(/\n+$/, "");

      if (assignGroupIdToCommit && commit.hash === assignGroupIdToCommit) {
        // This commit is being assigned the group ID (inheriting the PR)
        // Remove existing Spry-Commit-Id and add new one with group ID
        message = message
          .split("\n")
          .filter((line) => !line.startsWith("Spry-Commit-Id:"))
          .join("\n")
          .replace(/\n+$/, "");
        message = await addTrailers(message, { "Spry-Commit-Id": groupId });
      } else if (assignGroupIdToCommit && commitId === groupId) {
        // This commit originally donated its ID to the group, but a DIFFERENT
        // commit is being assigned the group ID. Generate a new ID to avoid conflicts.
        const newId = generateCommitId();
        message = message
          .split("\n")
          .filter((line) => !line.startsWith("Spry-Commit-Id:"))
          .join("\n")
          .replace(/\n+$/, "");
        message = await addTrailers(message, { "Spry-Commit-Id": newId });
      }
      // else: Just remove group trailers, keep existing Spry-Commit-Id

      rewrites.set(commit.hash, message);
    }
  }

  // Get current branch and tip for finalization
  const branch = await getCurrentBranch(gitOptions);
  const allHashes = commits.map((c) => c.hash);
  const oldTip = asserted(allHashes.at(-1));

  // Rewrite the commit chain
  const result = await rewriteCommitChain(allHashes, rewrites, gitOptions);

  // Finalize
  await finalizeRewrite(branch, oldTip, result.newTip, gitOptions);

  // Delete group title from ref storage
  await deleteGroupTitle(groupId, gitOptions);

  return { success: true };
}

/**
 * Add group trailers to a commit (used for fixing split groups).
 * Uses git plumbing (no working directory modifications).
 * Adds Spry-Group trailer and saves title to ref storage.
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

  // Build rewrites map - only the target commit needs changes
  const rewrites = new Map<string, string>();
  let message = await getCommitMessage(targetCommit.hash, options);
  message = await addTrailers(message, { "Spry-Group": groupId });
  rewrites.set(targetCommit.hash, message);

  // Get current branch and tip for finalization
  const branch = await getCurrentBranch(options);
  const allHashes = commits.map((c) => c.hash);
  const oldTip = asserted(allHashes.at(-1));

  // Rewrite the commit chain
  const result = await rewriteCommitChain(allHashes, rewrites, options);

  // Finalize
  await finalizeRewrite(branch, oldTip, result.newTip, options);

  // Save title to ref storage
  await setGroupTitle(groupId, groupTitle, options);

  return { success: true };
}

/**
 * Remove group trailers from a specific commit.
 * Uses git plumbing (no working directory modifications).
 * Removes Spry-Group and any legacy Spry-Group-Title.
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

  // Build rewrites map - only the target commit needs changes
  const rewrites = new Map<string, string>();
  let message = await getCommitMessage(targetCommit.hash, options);

  // Remove group trailers
  message = message
    .split("\n")
    .filter((line) => line !== `Spry-Group: ${groupId}` && !line.startsWith("Spry-Group-Title:"))
    .join("\n")
    .replace(/\n+$/, "");

  rewrites.set(targetCommit.hash, message);

  // Get current branch and tip for finalization
  const branch = await getCurrentBranch(options);
  const allHashes = commits.map((c) => c.hash);
  const oldTip = asserted(allHashes.at(-1));

  // Rewrite the commit chain
  const result = await rewriteCommitChain(allHashes, rewrites, options);

  // Finalize
  await finalizeRewrite(branch, oldTip, result.newTip, options);

  return { success: true };
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
    if (commit.trailers["Spry-Group"] === groupId) {
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
 * Uses git plumbing (no working directory modifications).
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
    (c) => c.trailers["Spry-Group"] || c.trailers["Spry-Group-Title"],
  );
  const groupIdsToDelete = new Set<string>();
  for (const commit of commitsWithGroupTrailers) {
    const groupId = commit.trailers["Spry-Group"];
    if (groupId) {
      groupIdsToDelete.add(groupId);
    }
  }

  if (commitsWithGroupTrailers.length === 0) {
    // Still clear titles from ref storage
    await writeGroupTitles({}, options);
    return { success: true };
  }

  // Build rewrites map
  const rewrites = new Map<string, string>();

  for (const commit of commits) {
    const hasGroupTrailers = commit.trailers["Spry-Group"] || commit.trailers["Spry-Group-Title"];

    if (hasGroupTrailers) {
      let message = await getCommitMessage(commit.hash, options);

      // Remove all group trailers
      message = message
        .split("\n")
        .filter((line) => !line.startsWith("Spry-Group:") && !line.startsWith("Spry-Group-Title:"))
        .join("\n")
        .replace(/\n+$/, "");

      rewrites.set(commit.hash, message);
    }
  }

  // Get current branch and tip for finalization
  const branch = await getCurrentBranch(options);
  const allHashes = commits.map((c) => c.hash);
  const oldTip = asserted(allHashes.at(-1));

  // Rewrite the commit chain
  const result = await rewriteCommitChain(allHashes, rewrites, options);

  // Finalize
  await finalizeRewrite(branch, oldTip, result.newTip, options);

  // Clear group titles from ref storage
  await deleteGroupTitles([...groupIdsToDelete], options);

  return { success: true };
}
