import type { TUIState, GroupValidationResult } from "./state.ts";
import type { ConflictResult } from "../git/conflict-predict.ts";
import { getGroupSummary, getConflict, validateGroupsContiguous } from "./state.ts";
import { colors } from "./terminal.ts";

/**
 * Find if a commit at the given index has any conflict due to reordering.
 * Returns the most severe conflict if multiple exist.
 */
function findConflictForCommit(state: TUIState, index: number): ConflictResult | null {
  const commit = state.commits[index];
  if (!commit) return null;

  let worstConflict: ConflictResult | null = null;

  // Check this commit against all others for conflicts due to reordering
  for (let i = 0; i < state.commits.length; i++) {
    if (i === index) continue;

    const otherCommit = state.commits[i];
    if (!otherCommit) continue;

    // Get original positions
    const origPosThis = state.originalOrder.indexOf(commit.hash);
    const origPosOther = state.originalOrder.indexOf(otherCommit.hash);

    // Check if their relative order changed
    const currentlyBefore = index < i;
    const wasOriginallyBefore = origPosThis < origPosOther;

    if (currentlyBefore !== wasOriginallyBefore) {
      // Order changed - check for conflict
      const conflict = getConflict(state, commit.hash, otherCommit.hash);
      if (conflict && conflict.status !== "clean") {
        // Keep the worst conflict (conflict > warning)
        if (!worstConflict || conflict.status === "conflict") {
          worstConflict = conflict;
        }
      }
    }
  }

  return worstConflict;
}

const SEPARATOR = "─".repeat(55);

/**
 * Render the entire TUI screen.
 */
export function renderScreen(state: TUIState, defaultBranch: string): string {
  const lines: string[] = [];

  // Validate groups
  const validation = validateGroupsContiguous(state);

  // Header
  const modeIndicator = state.moveMode !== null ? colors.yellow(" [MOVE MODE]") : "";
  lines.push(`Group Editor - ${state.commits.length} commits${modeIndicator}`);
  lines.push("");

  // Origin indicator
  lines.push(`  → ${defaultBranch}`);
  lines.push("");

  // Commits
  for (let i = 0; i < state.commits.length; i++) {
    lines.push(renderCommitLine(state, i, validation));
  }

  lines.push("");
  lines.push(SEPARATOR);

  // Group summary
  lines.push(getGroupSummary(state));

  // Validation error
  if (!validation.valid && validation.error) {
    lines.push(colors.red(`⚠ ${validation.error}`));
  }

  // Help line
  lines.push(renderHelpLine(state, validation));

  return lines.join("\n");
}

/**
 * Render a single commit line.
 */
function renderCommitLine(
  state: TUIState,
  index: number,
  validation: GroupValidationResult,
): string {
  const commit = state.commits[index];
  if (!commit) {
    return "";
  }
  const group = state.groups.get(index) ?? null;
  const isCursor = index === state.cursor;
  const isMoving = index === state.moveMode;
  const isInvalidGroup = !validation.valid && group === validation.invalidGroup;

  // Build the line parts
  const parts: string[] = [];

  // Cursor/move indicator
  if (isMoving) {
    parts.push(colors.yellow("»"));
  } else if (isCursor) {
    parts.push(colors.cyan("→"));
  } else {
    parts.push(" ");
  }

  // Group indicator
  if (group !== null) {
    if (isInvalidGroup) {
      parts.push(` ${colors.red(group)}`);
    } else {
      parts.push(` ${colors.magenta(group)}`);
    }
  } else {
    parts.push(" ─");
  }

  // Commit hash
  const hashDisplay = commit.commitId || commit.shortHash;
  parts.push(` ${colors.dim(hashDisplay)}`);

  // Subject (truncated if needed)
  const prefixLen = 4 + hashDisplay.length + 2; // "» A hash  "
  const maxSubjectLen = Math.max(20, 70 - prefixLen);
  let subject = commit.subject;
  if (subject.length > maxSubjectLen) {
    subject = subject.slice(0, maxSubjectLen - 1) + "…";
  }

  // Apply styling based on state
  if (isMoving) {
    parts.push(`  ${colors.yellow(subject)}`);
  } else if (isCursor) {
    parts.push(`  ${colors.brightWhite(subject)}`);
  } else {
    parts.push(`  ${subject}`);
  }

  // Conflict indicator - show when commits have been reordered and conflict
  // Check if this commit has any conflict with another due to reordering
  const conflictInfo = findConflictForCommit(state, index);
  if (conflictInfo) {
    if (conflictInfo.status === "conflict") {
      parts.push(colors.red(`  ✗ CONFLICT`));
      if (conflictInfo.files && conflictInfo.files.length > 0) {
        parts.push(colors.dim(` (${conflictInfo.files[0]})`));
      }
    } else if (conflictInfo.status === "warning") {
      parts.push(colors.yellow(`  ⚠️`));
      if (conflictInfo.files && conflictInfo.files.length > 0) {
        parts.push(colors.dim(` (${conflictInfo.files.join(", ")})`));
      }
    }
  }

  return parts.join("");
}

/**
 * Render the help line at the bottom.
 */
function renderHelpLine(state: TUIState, validation: GroupValidationResult): string {
  if (state.moveMode !== null) {
    return colors.dim("↑↓ swap position │ Space exit move mode │ ←→ disabled");
  }

  if (!validation.valid) {
    return (
      colors.dim("↑↓ navigate │ ⇧↑↓ move │ Space move mode │ ←→ group │ ") +
      colors.red("Enter disabled") +
      colors.dim(" │ Esc cancel")
    );
  }

  return colors.dim("↑↓ navigate │ ⇧↑↓ move │ Space move mode │ ←→ group │ Enter │ Esc");
}

/**
 * Render the group name input screen.
 */
export function renderGroupNameInput(
  groupLetter: string,
  commitCount: number,
  currentInput: string,
  cursorPos: number,
): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`Enter name for group ${colors.magenta(groupLetter)} (${commitCount} commits):`);
  lines.push("");

  // Input field with cursor
  const beforeCursor = currentInput.slice(0, cursorPos);
  const atCursor = currentInput[cursorPos] || " ";
  const afterCursor = currentInput.slice(cursorPos + 1);

  lines.push(`  > ${beforeCursor}${colors.inverse(atCursor)}${afterCursor}`);
  lines.push("");
  lines.push(colors.dim("Enter to confirm │ Esc to cancel"));

  return lines.join("\n");
}

/**
 * Render a confirmation dialog.
 */
export function renderConfirmDialog(message: string, action: string): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(message);
  lines.push("");
  lines.push(`  ${colors.green("y")} - Yes, ${action}`);
  lines.push(`  ${colors.red("n")} - No, cancel`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Render an error message.
 */
export function renderError(message: string): string {
  return `\n${colors.red("✗ Error:")} ${message}\n`;
}

/**
 * Render a success message.
 */
export function renderSuccess(message: string): string {
  return `\n${colors.green("✓")} ${message}\n`;
}

/**
 * Render progress indicator.
 */
export function renderProgress(message: string): string {
  return `\n${colors.cyan("⏳")} ${message}\n`;
}

/**
 * Render empty stack message.
 */
export function renderEmptyStack(defaultBranch: string): string {
  return `\nNo commits ahead of ${defaultBranch}\n\nNothing to group.\n`;
}

/**
 * Render non-TTY error.
 */
export function renderNonTTYError(): string {
  return colors.red(
    "\n✗ Error: This command requires an interactive terminal.\n" +
      "  The group editor cannot run in non-interactive mode.\n",
  );
}
