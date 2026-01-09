import type { ConflictResult } from "../git/conflict-predict.ts";

/**
 * Represents a commit displayed in the TUI.
 */
export interface CommitDisplay {
  /** Full commit hash */
  hash: string;
  /** Short commit hash (8 chars) */
  shortHash: string;
  /** Commit subject line */
  subject: string;
  /** Spry-Commit-Id if present */
  commitId?: string;
  /** Original group assignment from trailers */
  originalGroup?: string;
}

/**
 * Group letter type - A through Z or null for ungrouped.
 */
export type GroupLetter = string | null;

/**
 * Conflict information for display.
 */
export interface ConflictDisplay {
  /** Commits involved */
  commitA: string;
  commitB: string;
  /** Conflict result */
  result: ConflictResult;
}

/**
 * State of the TUI.
 */
export interface TUIState {
  /** Commits in current order (may differ from original) */
  commits: CommitDisplay[];
  /** Original commit order (for detecting changes) */
  originalOrder: string[];
  /** Current cursor position (0-indexed) */
  cursor: number;
  /** Index of commit in move mode, null if not in move mode */
  moveMode: number | null;
  /** Group assignments by commit index */
  groups: Map<number, GroupLetter>;
  /** Known conflicts between commits */
  conflicts: Map<string, ConflictResult>;
  /** Whether there are unsaved changes */
  dirty: boolean;
}

/**
 * Group letters in order.
 */
const GROUP_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Create initial TUI state from commits.
 */
export function createInitialState(commits: CommitDisplay[]): TUIState {
  const groups = new Map<number, GroupLetter>();

  // Initialize groups from existing trailers
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    if (commit?.originalGroup) {
      groups.set(i, commit.originalGroup);
    } else {
      groups.set(i, null);
    }
  }

  return {
    commits: [...commits],
    originalOrder: commits.map((c) => c.hash),
    cursor: 0,
    moveMode: null,
    groups,
    conflicts: new Map(),
    dirty: false,
  };
}

/**
 * Move cursor up or down in normal mode.
 * In move mode, this swaps the commit position.
 */
export function moveCursor(state: TUIState, direction: "up" | "down"): TUIState {
  if (state.commits.length === 0) {
    return state;
  }

  if (state.moveMode !== null) {
    // In move mode - swap commits
    return swapCommit(state, direction);
  }

  // Normal mode - just move cursor
  const delta = direction === "up" ? -1 : 1;
  const newCursor = Math.max(0, Math.min(state.commits.length - 1, state.cursor + delta));

  if (newCursor === state.cursor) {
    return state;
  }

  return {
    ...state,
    cursor: newCursor,
  };
}

/**
 * Toggle move mode for the commit at cursor.
 */
export function toggleMoveMode(state: TUIState): TUIState {
  if (state.commits.length === 0) {
    return state;
  }

  if (state.moveMode !== null) {
    // Exit move mode
    return {
      ...state,
      moveMode: null,
    };
  }

  // Enter move mode for current cursor position
  return {
    ...state,
    moveMode: state.cursor,
  };
}

/**
 * Quick swap: swap the commit at cursor with an adjacent commit.
 * This is used for Alt+arrow temporary move mode - it doesn't require
 * entering move mode first.
 */
export function quickSwap(state: TUIState, direction: "up" | "down"): TUIState {
  if (state.commits.length === 0) {
    return state;
  }

  const currentIdx = state.cursor;
  const targetIdx = direction === "up" ? currentIdx - 1 : currentIdx + 1;

  // Check bounds
  if (targetIdx < 0 || targetIdx >= state.commits.length) {
    return state;
  }

  // Swap commits
  const newCommits = [...state.commits];
  const currentCommit = newCommits[currentIdx];
  const targetCommit = newCommits[targetIdx];
  if (currentCommit && targetCommit) {
    newCommits[currentIdx] = targetCommit;
    newCommits[targetIdx] = currentCommit;
  }

  // Swap group assignments
  const newGroups = new Map(state.groups);
  const groupA = newGroups.get(currentIdx);
  const groupB = newGroups.get(targetIdx);
  newGroups.set(currentIdx, groupB ?? null);
  newGroups.set(targetIdx, groupA ?? null);

  // Update state - cursor follows the commit
  return {
    ...state,
    commits: newCommits,
    cursor: targetIdx,
    groups: newGroups,
    dirty: true,
  };
}

/**
 * Swap the commit in move mode with an adjacent commit.
 */
function swapCommit(state: TUIState, direction: "up" | "down"): TUIState {
  if (state.moveMode === null) {
    return state;
  }

  const currentIdx = state.moveMode;
  const targetIdx = direction === "up" ? currentIdx - 1 : currentIdx + 1;

  // Check bounds
  if (targetIdx < 0 || targetIdx >= state.commits.length) {
    return state;
  }

  // Swap commits
  const newCommits = [...state.commits];
  const currentCommit = newCommits[currentIdx];
  const targetCommit = newCommits[targetIdx];
  if (currentCommit && targetCommit) {
    newCommits[currentIdx] = targetCommit;
    newCommits[targetIdx] = currentCommit;
  }

  // Swap group assignments
  const newGroups = new Map(state.groups);
  const groupA = newGroups.get(currentIdx);
  const groupB = newGroups.get(targetIdx);
  newGroups.set(currentIdx, groupB ?? null);
  newGroups.set(targetIdx, groupA ?? null);

  // Update state
  return {
    ...state,
    commits: newCommits,
    cursor: targetIdx,
    moveMode: targetIdx,
    groups: newGroups,
    dirty: true,
  };
}

/**
 * Cycle group assignment for the commit at cursor.
 * Only works in normal mode.
 */
export function cycleGroup(state: TUIState, direction: "left" | "right"): TUIState {
  // Disabled in move mode
  if (state.moveMode !== null) {
    return state;
  }

  if (state.commits.length === 0) {
    return state;
  }

  const currentGroup = state.groups.get(state.cursor) ?? null;
  let newGroup: GroupLetter;

  if (direction === "left") {
    // Cycle backwards: A -> ungrouped, B -> A, etc.
    if (currentGroup === null) {
      newGroup = GROUP_LETTERS[GROUP_LETTERS.length - 1] ?? null; // Z
    } else {
      const idx = GROUP_LETTERS.indexOf(currentGroup);
      if (idx === 0) {
        newGroup = null; // Ungrouped
      } else {
        newGroup = GROUP_LETTERS[idx - 1] ?? null;
      }
    }
  } else {
    // Cycle forwards: ungrouped -> A, A -> B, etc.
    if (currentGroup === null) {
      newGroup = GROUP_LETTERS[0] ?? null; // A
    } else {
      const idx = GROUP_LETTERS.indexOf(currentGroup);
      if (idx === GROUP_LETTERS.length - 1) {
        newGroup = null; // Back to ungrouped
      } else {
        newGroup = GROUP_LETTERS[idx + 1] ?? null;
      }
    }
  }

  const newGroups = new Map(state.groups);
  newGroups.set(state.cursor, newGroup);

  return {
    ...state,
    groups: newGroups,
    dirty: true,
  };
}

/**
 * Get unique groups that are actually used.
 */
export function getUsedGroups(state: TUIState): Set<string> {
  const used = new Set<string>();
  for (const group of state.groups.values()) {
    if (group !== null) {
      used.add(group);
    }
  }
  return used;
}

/**
 * Get commits for each group.
 */
export function getGroupedCommits(state: TUIState): Map<string, number[]> {
  const grouped = new Map<string, number[]>();

  for (let i = 0; i < state.commits.length; i++) {
    const group = state.groups.get(i);
    if (group !== null && group !== undefined) {
      if (!grouped.has(group)) {
        grouped.set(group, []);
      }
      const indices = grouped.get(group);
      if (indices) {
        indices.push(i);
      }
    }
  }

  return grouped;
}

/**
 * Check if the current order differs from the original.
 */
export function hasOrderChanged(state: TUIState): boolean {
  if (state.commits.length !== state.originalOrder.length) {
    return true;
  }
  return state.commits.some((c, i) => c.hash !== state.originalOrder[i]);
}

/**
 * Check if any groups have been assigned.
 */
export function hasGroupAssignments(state: TUIState): boolean {
  for (const group of state.groups.values()) {
    if (group !== null) {
      return true;
    }
  }
  return false;
}

/**
 * Update conflict information for a pair of commits.
 */
export function setConflict(
  state: TUIState,
  commitA: string,
  commitB: string,
  result: ConflictResult,
): TUIState {
  const key = `${commitA}:${commitB}`;
  const newConflicts = new Map(state.conflicts);
  newConflicts.set(key, result);

  return {
    ...state,
    conflicts: newConflicts,
  };
}

/**
 * Get conflict result for a pair of commits.
 */
export function getConflict(
  state: TUIState,
  commitA: string,
  commitB: string,
): ConflictResult | undefined {
  return (
    state.conflicts.get(`${commitA}:${commitB}`) ?? state.conflicts.get(`${commitB}:${commitA}`)
  );
}

/**
 * Get summary of groups for display.
 */
export function getGroupSummary(state: TUIState): string {
  const grouped = getGroupedCommits(state);
  if (grouped.size === 0) {
    return "No groups";
  }

  const parts: string[] = [];
  const sortedGroups = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [group, indices] of sortedGroups) {
    parts.push(`${group} (${indices.length} commit${indices.length === 1 ? "" : "s"})`);
  }

  return `Groups: ${parts.join(", ")}`;
}

/**
 * Validation result for group assignments.
 */
export interface GroupValidationResult {
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** The group letter that has the error */
  invalidGroup?: string;
}

/**
 * Check if all group assignments are contiguous (no gaps).
 * Returns an error if any group has non-consecutive commits.
 */
export function validateGroupsContiguous(state: TUIState): GroupValidationResult {
  const grouped = getGroupedCommits(state);

  for (const [group, indices] of grouped) {
    if (indices.length <= 1) {
      continue; // Single-commit groups are always valid
    }

    // Check that indices are consecutive
    for (let i = 1; i < indices.length; i++) {
      const current = indices[i];
      const previous = indices[i - 1];
      if (current !== undefined && previous !== undefined && current !== previous + 1) {
        return {
          valid: false,
          error: `Group ${group} has non-contiguous commits`,
          invalidGroup: group,
        };
      }
    }
  }

  return { valid: true };
}
