import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink, chmod, writeFile } from "node:fs/promises";
import type { GitOptions } from "./commands.ts";
import { getMergeBase, getStackCommitsWithTrailers } from "./commands.ts";
import { generateCommitId } from "../core/id.ts";

export interface GroupAssignment {
  /** Commit hashes in this group (oldest first) */
  commits: string[];
  /** User-provided group name */
  name: string;
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
  const { cwd } = options;

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

  for (const group of resolvedGroups) {
    const firstCommit = group.commits[0];
    const lastCommit = group.commits[group.commits.length - 1];

    if (!firstCommit || !lastCommit) {
      continue;
    }

    const groupId = generateCommitId();

    if (firstCommit === lastCommit) {
      // Single-commit group
      const existing = trailerMap.get(firstCommit) ?? {};
      trailerMap.set(firstCommit, {
        ...existing,
        "Taspr-Group-Start": groupId,
        "Taspr-Group-Title": group.name,
        "Taspr-Group-End": groupId,
      });
    } else {
      // Multi-commit group
      const existingFirst = trailerMap.get(firstCommit) ?? {};
      trailerMap.set(firstCommit, {
        ...existingFirst,
        "Taspr-Group-Start": groupId,
        "Taspr-Group-Title": group.name,
      });

      const existingLast = trailerMap.get(lastCommit) ?? {};
      trailerMap.set(lastCommit, {
        ...existingLast,
        "Taspr-Group-End": groupId,
      });
    }
  }

  // Check which commits currently have group trailers (to remove them)
  const commitsWithGroupTrailers = new Set<string>();
  for (const commit of commits) {
    if (
      commit.trailers["Taspr-Group-Start"] ||
      commit.trailers["Taspr-Group-End"] ||
      commit.trailers["Taspr-Group-Title"]
    ) {
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

  // Create the rebase script
  // This script:
  // 1. Rewrites the todo to use the new order
  // 2. Adds exec commands after specific commits to add trailers
  const scriptPath = join(tmpdir(), `taspr-group-${Date.now()}.sh`);

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

      // Always strip existing group trailers first
      cmd += ' | grep -v "^Taspr-Group-"';

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

  const script = `#!/bin/bash
set -e
TODO_FILE="$1"

cat > "$TODO_FILE" << 'TODOEOF'
${todoLines.join("\n")}
TODOEOF
`;

  try {
    await writeFile(scriptPath, script);
    await chmod(scriptPath, "755");

    // Run the rebase
    const result = cwd
      ? await $`GIT_SEQUENCE_EDITOR=${scriptPath} git -C ${cwd} rebase -i ${mergeBase}`
          .quiet()
          .nothrow()
      : await $`GIT_SEQUENCE_EDITOR=${scriptPath} git rebase -i ${mergeBase}`.quiet().nothrow();

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
  const { cwd } = options;
  const commits = await getStackCommitsWithTrailers(options);

  // Find commits belonging to this group
  const groupCommits = commits.filter(
    (c) => c.trailers["Taspr-Group-Start"] === groupId || c.trailers["Taspr-Group-End"] === groupId,
  );

  if (groupCommits.length === 0) {
    return { success: false, error: `Group ${groupId} not found` };
  }

  const mergeBase = await getMergeBase(options);

  // Build todo with exec commands to remove group trailers
  const todoLines: string[] = [];
  for (const commit of commits) {
    todoLines.push(`pick ${commit.hash}`);

    // Check if this commit belongs to the group we're dissolving
    const isGroupStart = commit.trailers["Taspr-Group-Start"] === groupId;
    const isGroupEnd = commit.trailers["Taspr-Group-End"] === groupId;

    if (isGroupStart || isGroupEnd) {
      // Build a list of specific trailers to remove for this group only
      const trailersToRemove: string[] = [];
      if (isGroupStart) {
        trailersToRemove.push(`Taspr-Group-Start: ${groupId}`);
        // Title is always on the start commit
        const title = commit.trailers["Taspr-Group-Title"];
        if (title) {
          trailersToRemove.push(`Taspr-Group-Title: ${title}`);
        }
      }
      if (isGroupEnd) {
        trailersToRemove.push(`Taspr-Group-End: ${groupId}`);
      }

      // Use grep -v with exact patterns to remove only the specific trailers
      const grepPatterns = trailersToRemove.map((t) => `-e "^${t}$"`).join(" ");
      todoLines.push(
        `exec NEW_MSG=$(git log -1 --format=%B | grep -v ${grepPatterns}) && git commit --amend --no-edit -m "$NEW_MSG"`,
      );
    }
  }

  const scriptPath = join(tmpdir(), `taspr-dissolve-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -e
TODO_FILE="$1"

cat > "$TODO_FILE" << 'TODOEOF'
${todoLines.join("\n")}
TODOEOF
`;

  try {
    await writeFile(scriptPath, script);
    await chmod(scriptPath, "755");

    const result = cwd
      ? await $`GIT_SEQUENCE_EDITOR=${scriptPath} git -C ${cwd} rebase -i ${mergeBase}`
          .quiet()
          .nothrow()
      : await $`GIT_SEQUENCE_EDITOR=${scriptPath} git rebase -i ${mergeBase}`.quiet().nothrow();

    if (result.exitCode !== 0) {
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
 * Add a Taspr-Group-End trailer to a specific commit.
 * Used to close an unclosed group.
 */
export async function addGroupEnd(
  commitHash: string,
  groupId: string,
  options: GitOptions = {},
): Promise<ReorderResult> {
  const { cwd } = options;
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
      // Add Taspr-Group-End trailer
      const cmd = `NEW_MSG=$(git log -1 --format=%B | git interpret-trailers --trailer "Taspr-Group-End: ${groupId}") && git commit --amend --no-edit -m "$NEW_MSG"`;
      todoLines.push(`exec ${cmd}`);
    }
  }

  const scriptPath = join(tmpdir(), `taspr-add-end-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -e
TODO_FILE="$1"

cat > "$TODO_FILE" << 'TODOEOF'
${todoLines.join("\n")}
TODOEOF
`;

  try {
    await writeFile(scriptPath, script);
    await chmod(scriptPath, "755");

    const result = cwd
      ? await $`GIT_SEQUENCE_EDITOR=${scriptPath} git -C ${cwd} rebase -i ${mergeBase}`
          .quiet()
          .nothrow()
      : await $`GIT_SEQUENCE_EDITOR=${scriptPath} git rebase -i ${mergeBase}`.quiet().nothrow();

    if (result.exitCode !== 0) {
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
 * Remove Taspr-Group-Start and Taspr-Group-Title trailers from a specific commit.
 * Used to remove the start marker of an unclosed group.
 */
export async function removeGroupStart(
  commitHash: string,
  groupId: string,
  options: GitOptions = {},
): Promise<ReorderResult> {
  const { cwd } = options;
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
      // Remove Taspr-Group-Start and Taspr-Group-Title for this group
      const trailersToRemove: string[] = [`Taspr-Group-Start: ${groupId}`];
      const title = commit.trailers["Taspr-Group-Title"];
      if (title) {
        trailersToRemove.push(`Taspr-Group-Title: ${title}`);
      }
      const grepPatterns = trailersToRemove.map((t) => `-e "^${t}$"`).join(" ");
      todoLines.push(
        `exec NEW_MSG=$(git log -1 --format=%B | grep -v ${grepPatterns}) && git commit --amend --no-edit -m "$NEW_MSG"`,
      );
    }
  }

  const scriptPath = join(tmpdir(), `taspr-remove-start-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -e
TODO_FILE="$1"

cat > "$TODO_FILE" << 'TODOEOF'
${todoLines.join("\n")}
TODOEOF
`;

  try {
    await writeFile(scriptPath, script);
    await chmod(scriptPath, "755");

    const result = cwd
      ? await $`GIT_SEQUENCE_EDITOR=${scriptPath} git -C ${cwd} rebase -i ${mergeBase}`
          .quiet()
          .nothrow()
      : await $`GIT_SEQUENCE_EDITOR=${scriptPath} git rebase -i ${mergeBase}`.quiet().nothrow();

    if (result.exitCode !== 0) {
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
 * Add Taspr-Group-Start and Taspr-Group-Title trailers to a specific commit.
 * Used to add a start marker for an orphan group end.
 */
export async function addGroupStart(
  commitHash: string,
  groupId: string,
  groupTitle: string,
  options: GitOptions = {},
): Promise<ReorderResult> {
  const { cwd } = options;
  const commits = await getStackCommitsWithTrailers(options);

  const targetCommit = commits.find((c) => c.hash === commitHash || c.hash.startsWith(commitHash));
  if (!targetCommit) {
    return { success: false, error: `Commit ${commitHash} not found in stack` };
  }

  const mergeBase = await getMergeBase(options);

  // Build todo with exec command to add the trailers
  const todoLines: string[] = [];
  for (const commit of commits) {
    todoLines.push(`pick ${commit.hash}`);

    if (commit.hash === targetCommit.hash) {
      // Add Taspr-Group-Start and Taspr-Group-Title trailers
      const cmd = `NEW_MSG=$(git log -1 --format=%B | git interpret-trailers --trailer "Taspr-Group-Start: ${groupId}" --trailer "Taspr-Group-Title: ${groupTitle}") && git commit --amend --no-edit -m "$NEW_MSG"`;
      todoLines.push(`exec ${cmd}`);
    }
  }

  const scriptPath = join(tmpdir(), `taspr-add-start-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -e
TODO_FILE="$1"

cat > "$TODO_FILE" << 'TODOEOF'
${todoLines.join("\n")}
TODOEOF
`;

  try {
    await writeFile(scriptPath, script);
    await chmod(scriptPath, "755");

    const result = cwd
      ? await $`GIT_SEQUENCE_EDITOR=${scriptPath} git -C ${cwd} rebase -i ${mergeBase}`
          .quiet()
          .nothrow()
      : await $`GIT_SEQUENCE_EDITOR=${scriptPath} git rebase -i ${mergeBase}`.quiet().nothrow();

    if (result.exitCode !== 0) {
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
 * Remove Taspr-Group-End trailer from a specific commit.
 * Used to remove an orphan group end.
 */
export async function removeGroupEnd(
  commitHash: string,
  groupId: string,
  options: GitOptions = {},
): Promise<ReorderResult> {
  const { cwd } = options;
  const commits = await getStackCommitsWithTrailers(options);

  const targetCommit = commits.find((c) => c.hash === commitHash || c.hash.startsWith(commitHash));
  if (!targetCommit) {
    return { success: false, error: `Commit ${commitHash} not found in stack` };
  }

  const mergeBase = await getMergeBase(options);

  // Build todo with exec command to remove the trailer
  const todoLines: string[] = [];
  for (const commit of commits) {
    todoLines.push(`pick ${commit.hash}`);

    if (commit.hash === targetCommit.hash) {
      // Remove Taspr-Group-End for this group
      todoLines.push(
        `exec NEW_MSG=$(git log -1 --format=%B | grep -v -e "^Taspr-Group-End: ${groupId}$") && git commit --amend --no-edit -m "$NEW_MSG"`,
      );
    }
  }

  const scriptPath = join(tmpdir(), `taspr-remove-end-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -e
TODO_FILE="$1"

cat > "$TODO_FILE" << 'TODOEOF'
${todoLines.join("\n")}
TODOEOF
`;

  try {
    await writeFile(scriptPath, script);
    await chmod(scriptPath, "755");

    const result = cwd
      ? await $`GIT_SEQUENCE_EDITOR=${scriptPath} git -C ${cwd} rebase -i ${mergeBase}`
          .quiet()
          .nothrow()
      : await $`GIT_SEQUENCE_EDITOR=${scriptPath} git rebase -i ${mergeBase}`.quiet().nothrow();

    if (result.exitCode !== 0) {
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
 * Remove all group trailers from all commits in the stack.
 * Used by --fix to repair invalid group configurations.
 */
export async function removeAllGroupTrailers(options: GitOptions = {}): Promise<ReorderResult> {
  const { cwd } = options;
  const commits = await getStackCommitsWithTrailers(options);

  if (commits.length === 0) {
    return { success: true };
  }

  // Find commits that have any group trailers
  const commitsWithGroupTrailers = commits.filter(
    (c) =>
      c.trailers["Taspr-Group-Start"] ||
      c.trailers["Taspr-Group-End"] ||
      c.trailers["Taspr-Group-Title"],
  );

  if (commitsWithGroupTrailers.length === 0) {
    return { success: true };
  }

  const mergeBase = await getMergeBase(options);

  // Build todo with exec commands to remove all group trailers
  const todoLines: string[] = [];
  for (const commit of commits) {
    todoLines.push(`pick ${commit.hash}`);

    const hasGroupTrailers =
      commit.trailers["Taspr-Group-Start"] ||
      commit.trailers["Taspr-Group-End"] ||
      commit.trailers["Taspr-Group-Title"];

    if (hasGroupTrailers) {
      // Remove all Taspr-Group-* trailers
      todoLines.push(
        `exec NEW_MSG=$(git log -1 --format=%B | grep -v "^Taspr-Group-") && git commit --amend --allow-empty --no-edit -m "$NEW_MSG"`,
      );
    }
  }

  const scriptPath = join(tmpdir(), `taspr-fix-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -e
TODO_FILE="$1"

cat > "$TODO_FILE" << 'TODOEOF'
${todoLines.join("\n")}
TODOEOF
`;

  try {
    await writeFile(scriptPath, script);
    await chmod(scriptPath, "755");

    const result = cwd
      ? await $`GIT_SEQUENCE_EDITOR=${scriptPath} git -C ${cwd} rebase -i ${mergeBase}`
          .quiet()
          .nothrow()
      : await $`GIT_SEQUENCE_EDITOR=${scriptPath} git rebase -i ${mergeBase}`.quiet().nothrow();

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
