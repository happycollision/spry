import { $ } from "bun";
import type { GitOptions } from "./commands.ts";

export interface ConflictResult {
  /** Status of the conflict check */
  status: "clean" | "warning" | "conflict";
  /** Files that overlap between commits */
  files?: string[];
  /** Specific conflict locations (e.g., "auth.ts:15-22") */
  conflictLines?: string[];
}

/**
 * Cache for file lists during a TUI session.
 * Key is commit hash, value is list of files modified by that commit.
 */
const fileCache = new Map<string, string[]>();

/**
 * Clear the file cache. Call this when starting a new TUI session.
 */
export function clearFileCache(): void {
  fileCache.clear();
}

/**
 * Get files modified by a commit.
 * Results are cached for the duration of the TUI session.
 */
export async function getCommitFiles(hash: string, options: GitOptions = {}): Promise<string[]> {
  // Check cache first
  const cached = fileCache.get(hash);
  if (cached) {
    return cached;
  }

  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} diff-tree --no-commit-id --name-only -r ${hash}`.nothrow().text()
    : await $`git diff-tree --no-commit-id --name-only -r ${hash}`.nothrow().text();

  const files = result
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);

  // Cache the result
  fileCache.set(hash, files);

  return files;
}

/**
 * Check if two commits modify overlapping files.
 * This is a fast check that doesn't simulate the actual merge.
 */
export async function checkFileOverlap(
  commitA: string,
  commitB: string,
  options: GitOptions = {},
): Promise<string[]> {
  const [filesA, filesB] = await Promise.all([
    getCommitFiles(commitA, options),
    getCommitFiles(commitB, options),
  ]);

  const setA = new Set(filesA);
  return filesB.filter((f) => setA.has(f));
}

/**
 * Parse conflict information from git merge-tree output.
 * The output contains lines like:
 * CONFLICT (content): Merge conflict in <file>
 */
export function parseConflictOutput(output: string): { files: string[]; lines: string[] } {
  const files: string[] = [];
  const lines: string[] = [];

  // Match CONFLICT lines
  const conflictRegex = /CONFLICT \([^)]+\): (?:Merge conflict in|Add\/add|Rename\/rename) (.+)/g;
  let match;

  while ((match = conflictRegex.exec(output)) !== null) {
    const file = match[1]?.trim();
    if (file && !files.includes(file)) {
      files.push(file);
    }
  }

  // Try to extract line numbers from diff hunks
  // Format: @@ -start,count +start,count @@
  const hunkRegex = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/g;
  while ((match = hunkRegex.exec(output)) !== null) {
    // We don't have the file context here, so we'll skip detailed line info
  }

  // For now, just return files without line details
  // Line-level conflict detection would require more complex parsing
  return { files, lines };
}

/**
 * Simulate a merge between two commits to detect actual conflicts.
 * Uses git merge-tree which doesn't modify the working tree.
 *
 * @param base - Common ancestor commit
 * @param commitA - First commit to merge
 * @param commitB - Second commit to merge
 * @param overlappingFiles - Files known to overlap (for context)
 */
export async function simulateMerge(
  base: string,
  commitA: string,
  commitB: string,
  overlappingFiles: string[],
  options: GitOptions = {},
): Promise<ConflictResult> {
  const { cwd } = options;

  // Use git merge-tree to simulate the merge
  // Note: git merge-tree (old version) takes 3 trees
  // git merge-tree --write-tree (new version, Git 2.38+) is different
  // We'll use the traditional 3-way merge-tree for compatibility
  const result = cwd
    ? await $`git -C ${cwd} merge-tree ${base} ${commitA} ${commitB}`.nothrow().text()
    : await $`git merge-tree ${base} ${commitA} ${commitB}`.nothrow().text();

  // Check for conflict markers in the output
  if (result.includes("<<<<<<<") || result.includes("CONFLICT")) {
    const { files, lines } = parseConflictOutput(result);
    return {
      status: "conflict",
      files: files.length > 0 ? files : overlappingFiles,
      conflictLines: lines.length > 0 ? lines : undefined,
    };
  }

  // Files overlap but no actual conflict
  if (overlappingFiles.length > 0) {
    return {
      status: "warning",
      files: overlappingFiles,
    };
  }

  return { status: "clean" };
}

/**
 * Predict if moving commitA past commitB would cause a conflict.
 * Uses a hybrid approach:
 * 1. Fast file-level check to see if they touch the same files
 * 2. If they do, use git merge-tree for precise conflict detection
 *
 * @param commitA - The commit being moved
 * @param commitB - The commit it's being moved past
 * @param mergeBase - Common ancestor for merge simulation
 */
export async function predictConflict(
  commitA: string,
  commitB: string,
  mergeBase: string,
  options: GitOptions = {},
): Promise<ConflictResult> {
  // Step 1: Fast file overlap check
  const overlapping = await checkFileOverlap(commitA, commitB, options);

  if (overlapping.length === 0) {
    return { status: "clean" };
  }

  // Step 2: Precise merge simulation
  return simulateMerge(mergeBase, commitA, commitB, overlapping, options);
}

/**
 * Check conflicts for a proposed reordering of commits.
 * Returns conflict information for each adjacent pair that would conflict.
 *
 * @param currentOrder - Current commit hashes (oldest first)
 * @param newOrder - Proposed new order (oldest first)
 * @param mergeBase - Common ancestor for merge simulation
 */
export async function checkReorderConflicts(
  currentOrder: string[],
  newOrder: string[],
  mergeBase: string,
  options: GitOptions = {},
): Promise<Map<string, ConflictResult>> {
  const conflicts = new Map<string, ConflictResult>();

  // Find commits that moved relative to each other
  for (let i = 0; i < newOrder.length; i++) {
    for (let j = i + 1; j < newOrder.length; j++) {
      const commitI = newOrder[i];
      const commitJ = newOrder[j];

      if (!commitI || !commitJ) {
        continue;
      }

      // Check if their relative order changed
      const origPosI = currentOrder.indexOf(commitI);
      const origPosJ = currentOrder.indexOf(commitJ);

      if (origPosI !== -1 && origPosJ !== -1 && origPosI > origPosJ) {
        // commitI was after commitJ, now it's before - check for conflict
        const result = await predictConflict(commitI, commitJ, mergeBase, options);
        if (result.status !== "clean") {
          conflicts.set(`${commitI}:${commitJ}`, result);
        }
      }
    }
  }

  return conflicts;
}

/**
 * Format a conflict result for display in the TUI.
 */
export function formatConflictIndicator(result: ConflictResult): string {
  switch (result.status) {
    case "clean":
      return "✓";
    case "warning":
      return `⚠️ ${result.files?.join(", ") || "files overlap"}`;
    case "conflict":
      if (result.conflictLines && result.conflictLines.length > 0) {
        return `✗ CONFLICT (${result.conflictLines.join(", ")})`;
      }
      return `✗ CONFLICT (${result.files?.join(", ") || "merge conflict"})`;
    default:
      return "";
  }
}
