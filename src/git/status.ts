import type { GitRunner } from "../../tests/lib/context.ts";

export interface StatusOptions {
  cwd?: string;
}

export interface WorkingTreeStatus {
  isDirty: boolean;
  hasUnstagedChanges: boolean;
  hasStagedChanges: boolean;
  hasUntrackedFiles: boolean;
}

export async function getWorkingTreeStatus(
  git: GitRunner,
  options?: StatusOptions,
): Promise<WorkingTreeStatus> {
  const result = await git.run(["status", "--porcelain"], {
    cwd: options?.cwd,
  });

  const lines = result.stdout
    .split("\n")
    .filter((line) => line.length > 0);

  let hasUnstagedChanges = false;
  let hasStagedChanges = false;
  let hasUntrackedFiles = false;

  for (const line of lines) {
    const index = line[0];
    const worktree = line[1];

    if (line.startsWith("??")) {
      hasUntrackedFiles = true;
    } else {
      if (worktree !== " " && worktree !== "?") {
        hasUnstagedChanges = true;
      }
      if (index !== " " && index !== "?") {
        hasStagedChanges = true;
      }
    }
  }

  return {
    isDirty: lines.length > 0,
    hasUnstagedChanges,
    hasStagedChanges,
    hasUntrackedFiles,
  };
}

export async function requireCleanWorkingTree(
  git: GitRunner,
  options?: StatusOptions,
): Promise<void> {
  const status = await getWorkingTreeStatus(git, options);
  if (status.hasStagedChanges || status.hasUnstagedChanges) {
    throw new Error(
      "Cannot proceed: there are uncommitted changes in the working tree",
    );
  }
}
