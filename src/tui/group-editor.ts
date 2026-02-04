import { getStackCommitsWithTrailers, getMergeBase } from "../git/commands.ts";
import { getSpryConfig } from "../git/config.ts";
import { parseStack } from "../core/stack.ts";
import { formatValidationError } from "../cli/output.ts";
import { applyGroupSpec, type GroupAssignment, type GroupSpec } from "../git/group-rebase.ts";
import { predictConflict, clearFileCache } from "../git/conflict-predict.ts";
import { readGroupTitles } from "../git/group-titles.ts";
import { detectExistingPRs, type CommitWithPR } from "../git/pr-detection.ts";
import { getBranchNameConfig } from "../github/branches.ts";
import { closePR } from "../github/pr.ts";
import { prAdoptSelect, type PRAdoptOption } from "./pr-adopt-select.ts";

import {
  type TUIState,
  type CommitDisplay,
  createInitialState,
  moveCursor,
  toggleMoveMode,
  cycleGroup,
  quickSwap,
  hasOrderChanged,
  hasGroupAssignments,
  getGroupedCommits,
  setConflict,
  validateGroupsContiguous,
} from "./state.ts";

import {
  enableRawMode,
  parseKeypress,
  clearScreen,
  hideCursor,
  showCursor,
  write,
  isTTY,
} from "./terminal.ts";

import {
  renderScreen,
  renderEmptyStack,
  renderNonTTYError,
  renderError,
  renderSuccess,
  renderProgress,
} from "./render.ts";

import { createInterface } from "readline";

export interface GroupEditorResult {
  /** Whether changes were made */
  changed: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of converting commits to display format.
 */
interface CommitDisplayResult {
  commits: CommitDisplay[];
  /** Map of group letter to existing group name (from ref storage) */
  existingGroupNames: Map<string, string>;
  /** Map of group letter to existing group ID (from trailers) */
  existingGroupIds: Map<string, string>;
}

/**
 * Convert stack commits to display format.
 * @param commits - Commits with parsed trailers
 * @param groupTitles - Group titles from ref storage
 */
function toCommitDisplays(
  commits: Awaited<ReturnType<typeof getStackCommitsWithTrailers>>,
  groupTitles: Record<string, string>,
): CommitDisplayResult {
  // Track group assignments from trailers
  let groupIndex = 0;
  const groupLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  // First pass: identify unique groups
  const groupMap = new Map<string, string>(); // groupId -> letter
  for (const commit of commits) {
    const groupId = commit.trailers["Spry-Group"];
    if (groupId && !groupMap.has(groupId)) {
      const letter = groupLetters[groupIndex++ % 26];
      if (letter) {
        groupMap.set(groupId, letter);
      }
    }
  }

  // Build map of letter -> existing name from ref storage
  const existingGroupNames = new Map<string, string>();
  // Build map of letter -> existing group ID (reverse of groupMap)
  const existingGroupIds = new Map<string, string>();
  for (const [groupId, letter] of groupMap) {
    existingGroupIds.set(letter, groupId);
    const title = groupTitles[groupId];
    if (title) {
      existingGroupNames.set(letter, title);
    }
  }

  // Second pass: assign letters based on Spry-Group trailer
  const displayCommits = commits.map((commit) => {
    const groupId = commit.trailers["Spry-Group"];
    const letter = groupId ? groupMap.get(groupId) : null;

    const display: CommitDisplay = {
      hash: commit.hash,
      shortHash: commit.hash.slice(0, 8),
      subject: commit.subject,
      commitId: commit.trailers["Spry-Commit-Id"],
      originalGroup: letter ?? undefined,
    };

    return display;
  });

  return { commits: displayCommits, existingGroupNames, existingGroupIds };
}

/**
 * Prompt user to choose which PR to adopt when grouping commits with existing PRs.
 * Returns the ID to use for the group, or null if cancelled.
 */
async function promptPRAdoption(
  commitsWithPRs: CommitWithPR[],
  groupName: string,
): Promise<{ id: string | null; closePRs: CommitWithPR[] } | null> {
  if (commitsWithPRs.length === 0) {
    // No existing PRs - will generate new ID
    return { id: null, closePRs: [] };
  }

  if (commitsWithPRs.length === 1) {
    // Single PR exists - ask if user wants to adopt it or create new
    const pr = commitsWithPRs[0];
    if (!pr) {
      return { id: null, closePRs: [] };
    }
    const context = `Group "${groupName}" includes a commit with an open PR`;

    const options: PRAdoptOption[] = [
      {
        label: `Adopt PR #${pr.pr.number}: "${pr.pr.title}"`,
        value: pr.commitId,
        prUrl: pr.pr.url,
      },
      {
        label: "Create new PR (closes existing)",
        value: null,
        description: `PR #${pr.pr.number} will be closed`,
      },
    ];

    const result = await prAdoptSelect(options, "Choose PR for this group:", context);

    if (result.cancelled) {
      return null;
    }

    return {
      id: result.adoptedId,
      closePRs: result.adoptedId ? [] : commitsWithPRs,
    };
  }

  // Multiple PRs exist - user must pick one to keep
  const context = `Group "${groupName}" includes ${commitsWithPRs.length} commits with open PRs`;

  const options: PRAdoptOption[] = commitsWithPRs.map((c) => ({
    label: `Keep PR #${c.pr.number}: "${c.pr.title}"`,
    value: c.commitId,
    prUrl: c.pr.url,
  }));

  options.push({
    label: "Create new PR (closes all existing)",
    value: null,
    description: `All ${commitsWithPRs.length} PRs will be closed`,
  });

  const result = await prAdoptSelect(options, "Choose which PR to keep:", context);

  if (result.cancelled) {
    return null;
  }

  // PRs to close are all except the adopted one
  const closePRs = result.adoptedId
    ? commitsWithPRs.filter((c) => c.commitId !== result.adoptedId)
    : commitsWithPRs;

  return {
    id: result.adoptedId,
    closePRs,
  };
}

/**
 * Prompt for group names using readline.
 */
async function promptGroupNames(
  groups: Map<string, number[]>,
  commits: CommitDisplay[],
  existingGroupNames: Map<string, string>,
): Promise<Map<string, string> | null> {
  const names = new Map<string, string>();
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Ensure stdin is in the right mode for readline
  process.stdin.setRawMode(false);
  process.stdin.resume();

  // Use readline for input
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    for (const [letter, indices] of sortedGroups) {
      const commitCount = indices.length;
      const firstIndex = indices[0];
      // Use existing group name if available, otherwise fall back to first commit's subject
      const defaultName =
        existingGroupNames.get(letter) ||
        (firstIndex !== undefined ? commits[firstIndex]?.subject : undefined) ||
        letter;

      const prompt = `\nName for group ${letter} (${commitCount} commits) [${defaultName}]: `;

      const answer = await new Promise<string>((resolve) => {
        rl.question(prompt, resolve);
      });

      const name = answer.trim() || defaultName;
      names.set(letter, name);
    }
  } finally {
    rl.close();
  }

  return names;
}

/**
 * Main TUI event loop.
 */
async function runEventLoop(
  initialState: TUIState,
  defaultBranch: string,
): Promise<TUIState | null> {
  let state = initialState;
  let mergeBase: string;

  try {
    mergeBase = await getMergeBase();
  } catch {
    mergeBase = "";
  }

  // Clear conflict cache for fresh session
  clearFileCache();

  // Enable raw mode
  const disableRawMode = enableRawMode();

  // Hide cursor and clear screen
  hideCursor();
  clearScreen();
  write(renderScreen(state, defaultBranch));

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      disableRawMode();
      showCursor();
      clearScreen();
    };

    const redraw = () => {
      clearScreen();
      write(renderScreen(state, defaultBranch));
    };

    const onData = async (data: Buffer) => {
      const key = parseKeypress(data);

      // Handle keypresses
      switch (key.name) {
        case "escape":
        case "q":
          cleanup();
          resolve(null); // Cancelled
          return;

        case "return":
        case "enter": {
          // Check validation before allowing submission
          const validation = validateGroupsContiguous(state);
          if (!validation.valid) {
            // Don't allow submission - just redraw (error is shown in render)
            redraw();
            return;
          }
          // Confirm - exit with current state
          cleanup();
          resolve(state);
          return;
        }

        case "up":
          if (key.shift) {
            // Shift+Up: quick swap (move commit up without entering move mode)
            state = quickSwap(state, "up");
            if (mergeBase) {
              state = await checkOrderConflicts(state, mergeBase);
            }
          } else {
            state = moveCursor(state, "up");
            // Check for conflicts after reordering commits
            if (state.moveMode !== null && mergeBase) {
              state = await checkOrderConflicts(state, mergeBase);
            }
          }
          redraw();
          break;

        case "down":
          if (key.shift) {
            // Shift+Down: quick swap (move commit down without entering move mode)
            state = quickSwap(state, "down");
            if (mergeBase) {
              state = await checkOrderConflicts(state, mergeBase);
            }
          } else {
            state = moveCursor(state, "down");
            if (state.moveMode !== null && mergeBase) {
              state = await checkOrderConflicts(state, mergeBase);
            }
          }
          redraw();
          break;

        case "left":
          // Ignore Shift+Left (reserved for future use)
          if (!key.shift) {
            state = cycleGroup(state, "left");
            redraw();
          }
          break;

        case "right":
          // Ignore Shift+Right (reserved for future use)
          if (!key.shift) {
            state = cycleGroup(state, "right");
            redraw();
          }
          break;

        case "space":
          state = toggleMoveMode(state);
          // Don't check conflicts on enter - only after actual movement
          redraw();
          break;

        case "c":
          // Ctrl+C
          if (key.ctrl) {
            cleanup();
            resolve(null);
            return;
          }
          break;
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Check for conflicts based on the current order vs original order.
 * Only reports conflicts for commit pairs that have swapped relative positions.
 */
async function checkOrderConflicts(state: TUIState, mergeBase: string): Promise<TUIState> {
  // Find pairs of commits that have swapped order relative to original
  for (let i = 0; i < state.commits.length; i++) {
    for (let j = i + 1; j < state.commits.length; j++) {
      const commitI = state.commits[i];
      const commitJ = state.commits[j];
      if (!commitI || !commitJ) continue;

      // Get original positions
      const origPosI = state.originalOrder.indexOf(commitI.hash);
      const origPosJ = state.originalOrder.indexOf(commitJ.hash);

      // If commitI was originally AFTER commitJ, but now is BEFORE, check for conflict
      if (origPosI !== -1 && origPosJ !== -1 && origPosI > origPosJ) {
        // This pair has swapped - check for conflict if not already cached
        const existingConflict = state.conflicts.get(`${commitI.hash}:${commitJ.hash}`);
        if (!existingConflict) {
          try {
            const result = await predictConflict(commitI.hash, commitJ.hash, mergeBase);
            state = setConflict(state, commitI.hash, commitJ.hash, result);
          } catch {
            // Ignore prediction errors
          }
        }
      }
    }
  }

  return state;
}

/**
 * Main entry point for the group editor.
 */
export async function runGroupEditor(): Promise<GroupEditorResult> {
  // Check for TTY
  if (!isTTY()) {
    console.log(renderNonTTYError());
    return { changed: false, error: "Not a TTY" };
  }

  // Get config
  const config = await getSpryConfig();
  const defaultBranch = `${config.remote}/${config.defaultBranch}`;

  // Get commits
  const commits = await getStackCommitsWithTrailers();

  if (commits.length === 0) {
    console.log(renderEmptyStack(defaultBranch));
    return { changed: false };
  }

  // Read group titles from ref storage
  const groupTitles = await readGroupTitles();

  // Check for group errors (e.g., split groups) but don't block
  const validation = parseStack(commits, groupTitles);
  if (!validation.ok) {
    console.log(formatValidationError(validation));
    console.log(""); // blank line before TUI
  }

  // Convert to display format
  const {
    commits: displayCommits,
    existingGroupNames,
    existingGroupIds,
  } = toCommitDisplays(commits, groupTitles);

  // Create initial state
  const initialState = createInitialState(displayCommits);

  // Run the TUI
  const finalState = await runEventLoop(initialState, defaultBranch);

  if (!finalState) {
    console.log("\nCancelled.");
    return { changed: false };
  }

  // Check if anything changed
  const orderChanged = hasOrderChanged(finalState);
  const hasGroups = hasGroupAssignments(finalState);

  if (!orderChanged && !hasGroups) {
    console.log("\nNo changes made.");
    return { changed: false };
  }

  // Prompt for group names
  const groupedCommits = getGroupedCommits(finalState);

  let groupNames: Map<string, string> | null = null;
  if (groupedCommits.size > 0) {
    console.log(""); // Newline after TUI
    groupNames = await promptGroupNames(groupedCommits, finalState.commits, existingGroupNames);

    if (!groupNames) {
      console.log("\nCancelled.");
      return { changed: false };
    }
  }

  // Build group assignments with PR inheritance
  const groups: GroupAssignment[] = [];
  const prsToClose: CommitWithPR[] = [];

  if (groupNames) {
    // Get branch config for PR detection
    const branchConfig = await getBranchNameConfig();

    for (const [letter, indices] of groupedCommits) {
      const name = groupNames.get(letter) || letter;
      const commitHashes = indices
        .map((i) => finalState.commits[i]?.hash)
        .filter((hash): hash is string => hash !== undefined);

      // Build commit info for PR detection
      const groupCommitInfo = indices
        .map((i) => {
          const commit = finalState.commits[i];
          if (!commit) return null;
          return {
            hash: commit.hash,
            commitId: commit.commitId || "",
            subject: commit.subject,
          };
        })
        .filter((c): c is { hash: string; commitId: string; subject: string } => c !== null);

      // Detect existing PRs for commits in this group
      const commitsWithPRs = await detectExistingPRs(groupCommitInfo, branchConfig);

      // Prompt user to choose which PR to adopt (if any exist)
      const adoption = await promptPRAdoption(commitsWithPRs, name);

      if (adoption === null) {
        // User cancelled
        console.log("\nCancelled.");
        return { changed: false };
      }

      // Track PRs that need to be closed
      prsToClose.push(...adoption.closePRs);

      // Determine the group ID to use:
      // 1. If PR adoption selected an ID, use that
      // 2. Otherwise, if this letter corresponds to an existing group, preserve that ID
      // 3. Otherwise, let applyGroupSpec generate a new ID
      const groupId = adoption.id ?? existingGroupIds.get(letter);

      // Build group assignment with optional inherited ID
      groups.push({
        commits: commitHashes,
        name,
        id: groupId,
      });
    }
  }

  // Apply changes
  console.log(renderProgress("Applying changes..."));

  const newOrder = finalState.commits.map((c) => c.hash);

  // Build the spec for applyGroupSpec
  const spec: GroupSpec = {
    order: orderChanged ? newOrder : undefined,
    groups,
  };

  const result = await applyGroupSpec(spec);

  if (!result.success) {
    console.log(renderError(result.error || "Failed to apply changes"));
    if (result.conflictFile) {
      console.log(`  Conflict in: ${result.conflictFile}`);
      console.log("");
      console.log("  To abort:");
      console.log("    git rebase --abort");
      console.log("");
      console.log("  To resolve and continue:");
      console.log("    1. Fix the conflict in the file(s) above");
      console.log("    2. git add <fixed-files>");
      console.log("    3. git rebase --continue");
      console.log("");
      console.log("  Note: If resolving requires removing commits at the start or end of a");
      console.log("  group, the group trailers may become invalid. Run 'sp group' again");
      console.log("  after the rebase completes to fix any group issues.");
    }
    return { changed: false, error: result.error };
  }

  console.log(renderSuccess("Changes applied successfully."));

  // Close PRs that were superseded by group PRs
  if (prsToClose.length > 0) {
    console.log(`  • Closing ${prsToClose.length} superseded PR(s)...`);
    for (const pr of prsToClose) {
      try {
        await closePR(
          pr.pr.number,
          "This PR has been superseded by a group PR created via `sp group`.",
        );
        console.log(`    - Closed PR #${pr.pr.number}: "${pr.pr.title}"`);
      } catch (error) {
        // Non-fatal: PR may already be closed or user may not have permissions
        console.log(
          `    - Warning: Could not close PR #${pr.pr.number}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Summary
  if (orderChanged) {
    console.log("  • Commits reordered");
  }
  if (groups.length > 0) {
    console.log(`  • ${groups.length} group${groups.length === 1 ? "" : "s"} created`);
    for (const group of groups) {
      console.log(`    - "${group.name}" (${group.commits.length} commits)`);
    }
  }

  return { changed: true };
}
