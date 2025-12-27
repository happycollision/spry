import { $ } from "bun";
import type { GitOptions } from "./commands.ts";

export interface WorkingTreeStatus {
  isDirty: boolean;
  hasUnstagedChanges: boolean;
  hasStagedChanges: boolean;
  hasUntrackedFiles: boolean;
}

/**
 * Get detailed working tree status.
 */
export async function getWorkingTreeStatus(options: GitOptions = {}): Promise<WorkingTreeStatus> {
  const { cwd } = options;
  const result = cwd
    ? await $`git -C ${cwd} status --porcelain`.text()
    : await $`git status --porcelain`.text();

  const lines = result.split("\n").filter((l) => l.length > 0);

  return {
    isDirty: lines.length > 0,
    // Second column shows unstaged changes (M, D, etc.) - space means no change
    hasUnstagedChanges: lines.some((l) => l[1] !== " " && l[1] !== "?"),
    // First column shows staged changes - space or ? means not staged
    hasStagedChanges: lines.some((l) => l[0] !== " " && l[0] !== "?"),
    hasUntrackedFiles: lines.some((l) => l.startsWith("??")),
  };
}

export class DirtyWorkingTreeError extends Error {
  constructor(public status: WorkingTreeStatus) {
    const parts: string[] = [];
    if (status.hasStagedChanges) parts.push("staged changes");
    if (status.hasUnstagedChanges) parts.push("unstaged changes");

    super(`Cannot sync with uncommitted changes: ${parts.join(" and ")}`);
    this.name = "DirtyWorkingTreeError";
  }
}

/**
 * Require a clean working tree for rebase operations.
 * Throws DirtyWorkingTreeError if there are staged or unstaged changes.
 * Untracked files are allowed (they don't affect rebase).
 */
export async function requireCleanWorkingTree(options: GitOptions = {}): Promise<void> {
  const status = await getWorkingTreeStatus(options);

  if (status.hasStagedChanges || status.hasUnstagedChanges) {
    throw new DirtyWorkingTreeError(status);
  }
}
