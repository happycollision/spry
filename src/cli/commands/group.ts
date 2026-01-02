import { runGroupEditor } from "../../tui/group-editor.ts";
import {
  dissolveGroup,
  applyGroupSpec,
  parseGroupSpec,
  removeAllGroupTrailers,
  addGroupEnd,
  removeGroupStart,
  addGroupStart,
  removeGroupEnd,
} from "../../git/group-rebase.ts";
import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { parseStack, type CommitWithTrailers } from "../../core/stack.ts";
import { formatValidationError } from "../output.ts";
import { multiSelect } from "../../tui/multi-select.ts";
import { repairSelect } from "../../tui/repair-select.ts";
import { commitSelect } from "../../tui/commit-select.ts";
import { isTTY } from "../../tui/terminal.ts";
import type { PRUnit, StackParseResult } from "../../types.ts";
import * as readline from "node:readline";

export interface GroupCommandOptions {
  apply?: string;
  fix?: boolean | string;
}

/**
 * Main group command - launches the TUI editor or applies a spec.
 */
export async function groupCommand(options: GroupCommandOptions = {}): Promise<void> {
  // Fix mode: repair invalid group trailers
  if (options.fix !== undefined) {
    const mode = typeof options.fix === "string" ? options.fix : undefined;
    await fixCommand(mode);
    return;
  }

  // Non-interactive mode: apply a JSON spec
  if (options.apply) {
    await applyCommand(options.apply);
    return;
  }

  // Interactive mode: launch TUI
  const result = await runGroupEditor();

  if (result.error) {
    process.exit(1);
  }
}

/**
 * Apply a group specification from JSON.
 *
 * Format:
 * {
 *   "order": ["commit1", "commit2", ...],  // optional - new order
 *   "groups": [
 *     {"commits": ["commit1", "commit2"], "name": "Group Name"}
 *   ]
 * }
 *
 * Commits can be referenced by:
 * - Full hash
 * - Short hash (7 or 8 chars)
 * - Taspr-Commit-Id
 */
async function applyCommand(json: string): Promise<void> {
  try {
    const spec = parseGroupSpec(json);

    console.log("Applying group spec...");
    if (spec.order) {
      console.log(`  Order: ${spec.order.length} commits`);
    }
    if (spec.groups.length > 0) {
      console.log(`  Groups: ${spec.groups.length}`);
      for (const g of spec.groups) {
        console.log(`    - "${g.name}" (${g.commits.length} commits)`);
      }
    }

    const result = await applyGroupSpec(spec);

    if (!result.success) {
      console.error(`✗ Error: ${result.error}`);
      if (result.conflictFile) {
        console.error(`  Conflict in: ${result.conflictFile}`);
      }
      process.exit(1);
    }

    console.log("✓ Group spec applied successfully.");
  } catch (err) {
    console.error(`✗ Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Dissolve a group by removing its trailers.
 * If no groupId is provided, shows an interactive multi-select.
 */
export async function dissolveCommand(groupId?: string): Promise<void> {
  // Get current stack
  const commits = await getStackCommitsWithTrailers();

  if (commits.length === 0) {
    console.log("No commits in stack.");
    return;
  }

  // Parse stack to find groups
  const validation = parseStack(commits);
  if (!validation.ok) {
    console.log(formatValidationError(validation));
    process.exit(1);
  }

  const units = validation.units;
  const groups = units.filter((u): u is PRUnit & { type: "group" } => u.type === "group");

  if (groups.length === 0) {
    console.log("No groups in the current stack.");
    return;
  }

  // If groupId provided, dissolve that specific group
  if (groupId) {
    const targetGroup = groups.find((g) => g.id === groupId || g.id.startsWith(groupId));

    if (!targetGroup) {
      console.log(`Group "${groupId}" not found.`);
      console.log("");
      console.log("Available groups:");
      for (const group of groups) {
        console.log(`  ${group.id}: "${group.title}"`);
      }
      process.exit(1);
    }

    await dissolveSingleGroup(targetGroup);
    return;
  }

  // No groupId provided - interactive mode
  if (!isTTY()) {
    // Non-interactive: list groups and exit
    console.log("Available groups:");
    for (const group of groups) {
      console.log(`  ${group.id}: "${group.title}" (${group.commits.length} commits)`);
    }
    console.log("");
    console.log("Usage: taspr group dissolve <group-id>");
    return;
  }

  // Interactive multi-select
  const options = groups.map((g) => ({
    label: `"${g.title}"`,
    value: g,
    hint: `${g.commits.length} commit${g.commits.length === 1 ? "" : "s"}`,
  }));

  const result = await multiSelect(options, "Select groups to dissolve:");

  if (result.cancelled || result.selected.length === 0) {
    console.log("No groups selected.");
    return;
  }

  // Dissolve selected groups
  for (const group of result.selected) {
    await dissolveSingleGroup(group);
  }
}

/**
 * Dissolve a single group.
 */
async function dissolveSingleGroup(group: PRUnit): Promise<void> {
  console.log(`Dissolving group "${group.title}" (${group.id})...`);

  const result = await dissolveGroup(group.id);

  if (!result.success) {
    console.log(`Error: ${result.error}`);
    process.exit(1);
  }

  console.log(`✓ Group "${group.title}" dissolved.`);
}

/**
 * Fix invalid group trailers.
 * Interactive mode by default, or "dissolve" mode for non-interactive.
 */
async function fixCommand(mode?: string): Promise<void> {
  const commits = await getStackCommitsWithTrailers();

  if (commits.length === 0) {
    console.log("No commits in stack.");
    return;
  }

  // Check for validation errors
  const validation = parseStack(commits);

  if (validation.ok) {
    console.log("✓ No invalid groups found. Stack is valid.");
    return;
  }

  // Non-interactive dissolve mode
  if (mode === "dissolve" || !isTTY()) {
    await dissolveErrorGroup(commits, validation);
    return;
  }

  // Interactive repair mode
  switch (validation.error) {
    case "unclosed-group":
      await repairUnclosedGroup(commits, validation);
      break;
    case "overlapping-groups":
      await repairOverlappingGroups(commits, validation);
      break;
    case "orphan-group-end":
      await repairOrphanEnd(commits, validation);
      break;
  }
}

/**
 * Non-interactive dissolve: remove only the problematic group trailers.
 */
async function dissolveErrorGroup(
  _commits: CommitWithTrailers[],
  validation: Exclude<StackParseResult, { ok: true }>,
): Promise<void> {
  // Show what's wrong
  console.log(formatValidationError(validation));
  console.log("");

  // Dissolve only the group(s) with errors
  switch (validation.error) {
    case "unclosed-group": {
      console.log(`Removing group "${validation.groupTitle}" start marker...`);
      const result = await removeGroupStart(validation.startCommit, validation.groupId);
      if (!result.success) {
        console.error(`✗ Error: ${result.error}`);
        process.exit(1);
      }
      console.log(`✓ Group "${validation.groupTitle}" start removed.`);
      break;
    }

    case "overlapping-groups": {
      // Remove the inner (second) group that's causing the overlap
      console.log(`Removing overlapping group "${validation.group2.title}" start marker...`);
      const result = await removeGroupStart(validation.group2.startCommit, validation.group2.id);
      if (!result.success) {
        console.error(`✗ Error: ${result.error}`);
        process.exit(1);
      }
      console.log(`✓ Group "${validation.group2.title}" start removed.`);
      console.log(
        `  Note: "${validation.group1.title}" is still open - run --fix again if needed.`,
      );
      break;
    }

    case "orphan-group-end": {
      console.log(`Removing orphan group end marker...`);
      const result = await removeGroupEnd(validation.commit, validation.groupId);
      if (!result.success) {
        console.error(`✗ Error: ${result.error}`);
        process.exit(1);
      }
      console.log("✓ Orphan group end removed.");
      break;
    }
  }
}

/**
 * Format error summary for repair UI.
 */
function formatErrorSummary(validation: Exclude<StackParseResult, { ok: true }>): string {
  switch (validation.error) {
    case "unclosed-group":
      return `✗ Unclosed group: "${validation.groupTitle}" (${validation.groupId.slice(0, 8)})\n  Started at commit ${validation.startCommit.slice(0, 8)} but has no matching end.`;
    case "overlapping-groups":
      return `✗ Overlapping groups detected:\n  "${validation.group1.title}" starts at ${validation.group1.startCommit.slice(0, 8)}\n  "${validation.group2.title}" starts at ${validation.group2.startCommit.slice(0, 8)} (inside first group)`;
    case "orphan-group-end":
      return `✗ Orphan group end: ${validation.groupId.slice(0, 8)}\n  Found Taspr-Group-End at ${validation.commit.slice(0, 8)} with no matching start.`;
  }
}

type UnclosedGroupValidation = {
  ok: false;
  error: "unclosed-group";
  groupId: string;
  startCommit: string;
  groupTitle: string;
};

type OverlappingGroupsValidation = {
  ok: false;
  error: "overlapping-groups";
  group1: { id: string; title: string; startCommit: string };
  group2: { id: string; title: string; startCommit: string };
  overlappingCommit: string;
};

type OrphanGroupEndValidation = {
  ok: false;
  error: "orphan-group-end";
  groupId: string;
  commit: string;
};

/**
 * Repair an unclosed group interactively.
 */
async function repairUnclosedGroup(
  commits: CommitWithTrailers[],
  validation: UnclosedGroupValidation,
): Promise<void> {
  const errorSummary = formatErrorSummary(validation);

  type RepairAction = "pick-end" | "remove-start" | "dissolve";

  const options: Array<{ label: string; value: RepairAction; description: string }> = [
    {
      label: "Pick end commit",
      value: "pick-end",
      description: "Select which commit should close this group",
    },
    {
      label: "Remove group start",
      value: "remove-start",
      description: "Remove the Taspr-Group-Start trailer (commits become ungrouped)",
    },
    {
      label: "Dissolve all groups",
      value: "dissolve",
      description: "Remove ALL group trailers from the stack",
    },
  ];

  const result = await repairSelect(options, "Select repair action:", errorSummary);

  if (result.cancelled || !result.selected) {
    console.log("Repair cancelled.");
    return;
  }

  switch (result.selected) {
    case "pick-end": {
      // Find commits at or after the start commit
      const startIndex = commits.findIndex(
        (c) => c.hash === validation.startCommit || c.hash.startsWith(validation.startCommit),
      );
      if (startIndex === -1) {
        console.error("Could not find start commit in stack.");
        process.exit(1);
      }

      // Eligible commits are those at or after the start
      const eligibleCommits = commits.slice(startIndex);

      if (eligibleCommits.length === 0) {
        console.log("No eligible commits to select as group end.");
        return;
      }

      const selected = await commitSelect(
        eligibleCommits,
        "Select the commit to be the group end:",
        validation.startCommit,
      );

      if (selected.cancelled || !selected.commit) {
        console.log("Selection cancelled.");
        return;
      }

      console.log(`Adding Taspr-Group-End to commit ${selected.commit.slice(0, 8)}...`);
      const addResult = await addGroupEnd(selected.commit, validation.groupId);

      if (!addResult.success) {
        console.error(`✗ Error: ${addResult.error}`);
        process.exit(1);
      }

      console.log("✓ Group end added. Group is now closed.");
      break;
    }

    case "remove-start": {
      console.log(
        `Removing Taspr-Group-Start from commit ${validation.startCommit.slice(0, 8)}...`,
      );
      const removeResult = await removeGroupStart(validation.startCommit, validation.groupId);

      if (!removeResult.success) {
        console.error(`✗ Error: ${removeResult.error}`);
        process.exit(1);
      }

      console.log("✓ Group start removed. Commits are now ungrouped.");
      break;
    }

    case "dissolve": {
      console.log("Removing all group trailers...");
      const dissolveResult = await removeAllGroupTrailers();

      if (!dissolveResult.success) {
        console.error(`✗ Error: ${dissolveResult.error}`);
        process.exit(1);
      }

      console.log("✓ All group trailers removed.");
      break;
    }
  }
}

/**
 * Repair overlapping groups interactively.
 */
async function repairOverlappingGroups(
  commits: CommitWithTrailers[],
  validation: OverlappingGroupsValidation,
): Promise<void> {
  const errorSummary = formatErrorSummary(validation);

  // Find the commit right before the overlap
  const overlapIndex = commits.findIndex(
    (c) =>
      c.hash === validation.overlappingCommit || c.hash.startsWith(validation.overlappingCommit),
  );
  const commitBeforeOverlap = overlapIndex > 0 ? commits[overlapIndex - 1] : null;

  type RepairAction = "close-first" | "remove-second" | "dissolve";

  const options: Array<{ label: string; value: RepairAction; description: string }> = [
    {
      label: `Close "${validation.group1.title}" before overlap`,
      value: "close-first",
      description: commitBeforeOverlap
        ? `Add Taspr-Group-End to ${commitBeforeOverlap.hash.slice(0, 8)}`
        : "Add end marker to close the first group",
    },
    {
      label: `Remove "${validation.group2.title}" start`,
      value: "remove-second",
      description: "Remove the nested group's start marker",
    },
    {
      label: "Dissolve all groups",
      value: "dissolve",
      description: "Remove ALL group trailers from the stack",
    },
  ];

  const result = await repairSelect(options, "Select repair action:", errorSummary);

  if (result.cancelled || !result.selected) {
    console.log("Repair cancelled.");
    return;
  }

  switch (result.selected) {
    case "close-first": {
      if (!commitBeforeOverlap) {
        console.error("Cannot close group: no commits before overlap.");
        process.exit(1);
      }

      console.log(
        `Adding Taspr-Group-End to commit ${commitBeforeOverlap.hash.slice(0, 8)} to close "${validation.group1.title}"...`,
      );
      const addResult = await addGroupEnd(commitBeforeOverlap.hash, validation.group1.id);

      if (!addResult.success) {
        console.error(`✗ Error: ${addResult.error}`);
        process.exit(1);
      }

      console.log(`✓ Group "${validation.group1.title}" closed.`);
      console.log(
        `  Note: "${validation.group2.title}" is still open - run --fix again if needed.`,
      );
      break;
    }

    case "remove-second": {
      console.log(
        `Removing Taspr-Group-Start from commit ${validation.group2.startCommit.slice(0, 8)}...`,
      );
      const removeResult = await removeGroupStart(
        validation.group2.startCommit,
        validation.group2.id,
      );

      if (!removeResult.success) {
        console.error(`✗ Error: ${removeResult.error}`);
        process.exit(1);
      }

      console.log(`✓ Group "${validation.group2.title}" start removed.`);
      break;
    }

    case "dissolve": {
      console.log("Removing all group trailers...");
      const dissolveResult = await removeAllGroupTrailers();

      if (!dissolveResult.success) {
        console.error(`✗ Error: ${dissolveResult.error}`);
        process.exit(1);
      }

      console.log("✓ All group trailers removed.");
      break;
    }
  }
}

/**
 * Prompt for group name using readline.
 */
async function promptGroupName(defaultName: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`Group name [${defaultName}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultName);
    });
  });
}

/**
 * Repair an orphan group end interactively.
 */
async function repairOrphanEnd(
  commits: CommitWithTrailers[],
  validation: OrphanGroupEndValidation,
): Promise<void> {
  const errorSummary = formatErrorSummary(validation);

  type RepairAction = "pick-start" | "remove-end" | "dissolve";

  const options: Array<{ label: string; value: RepairAction; description: string }> = [
    {
      label: "Pick start commit",
      value: "pick-start",
      description: "Select which commit should start this group",
    },
    {
      label: "Remove orphan end",
      value: "remove-end",
      description: "Remove the Taspr-Group-End trailer",
    },
    {
      label: "Dissolve all groups",
      value: "dissolve",
      description: "Remove ALL group trailers from the stack",
    },
  ];

  const result = await repairSelect(options, "Select repair action:", errorSummary);

  if (result.cancelled || !result.selected) {
    console.log("Repair cancelled.");
    return;
  }

  switch (result.selected) {
    case "pick-start": {
      // Find commits up to and including the orphan end commit
      const endIndex = commits.findIndex(
        (c) => c.hash === validation.commit || c.hash.startsWith(validation.commit),
      );
      if (endIndex === -1) {
        console.error("Could not find end commit in stack.");
        process.exit(1);
      }

      // Eligible commits are those at or before the end
      const eligibleCommits = commits.slice(0, endIndex + 1);

      if (eligibleCommits.length === 0) {
        console.log("No eligible commits to select as group start.");
        return;
      }

      const selected = await commitSelect(
        eligibleCommits,
        "Select the commit to be the group start:",
        validation.commit,
      );

      if (selected.cancelled || !selected.commit) {
        console.log("Selection cancelled.");
        return;
      }

      // Prompt for group name
      const selectedCommit = commits.find(
        (c) => c.hash === selected.commit || c.hash.startsWith(selected.commit || ""),
      );
      const defaultName = selectedCommit?.subject || "New Group";
      console.log("");
      const groupName = await promptGroupName(defaultName);

      console.log(`Adding Taspr-Group-Start to commit ${selected.commit.slice(0, 8)}...`);
      const addResult = await addGroupStart(selected.commit, validation.groupId, groupName);

      if (!addResult.success) {
        console.error(`✗ Error: ${addResult.error}`);
        process.exit(1);
      }

      console.log(`✓ Group "${groupName}" created.`);
      break;
    }

    case "remove-end": {
      console.log(`Removing Taspr-Group-End from commit ${validation.commit.slice(0, 8)}...`);
      const removeResult = await removeGroupEnd(validation.commit, validation.groupId);

      if (!removeResult.success) {
        console.error(`✗ Error: ${removeResult.error}`);
        process.exit(1);
      }

      console.log("✓ Orphan group end removed.");
      break;
    }

    case "dissolve": {
      console.log("Removing all group trailers...");
      const dissolveResult = await removeAllGroupTrailers();

      if (!dissolveResult.success) {
        console.error(`✗ Error: ${dissolveResult.error}`);
        process.exit(1);
      }

      console.log("✓ All group trailers removed.");
      break;
    }
  }
}
