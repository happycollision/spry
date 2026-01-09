import { runGroupEditor } from "../../tui/group-editor.ts";
import {
  dissolveGroup,
  applyGroupSpec,
  parseGroupSpec,
  removeAllGroupTrailers,
  mergeSplitGroup,
} from "../../git/group-rebase.ts";
import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import { formatValidationError } from "../output.ts";
import { multiSelect } from "../../tui/multi-select.ts";
import { repairSelect } from "../../tui/repair-select.ts";
import { prAdoptSelect, type PRAdoptOption } from "../../tui/pr-adopt-select.ts";
import { isTTY } from "../../tui/terminal.ts";
import type { PRUnit, StackParseResult } from "../../types.ts";
import { readGroupTitles } from "../../git/group-titles.ts";
import { findPRByBranch } from "../../github/pr.ts";
import { getBranchNameConfig, getBranchName } from "../../github/branches.ts";

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
 * - Spry-Commit-Id
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

export interface DissolveCommandOptions {
  /**
   * Commit to inherit the group's PR.
   * Can be a commit hash, short hash, or 1-based index into the group.
   * Set to `false` (via --no-inherit) to explicitly not inherit.
   */
  inherit?: string | boolean;
}

/**
 * Dissolve a group by removing its trailers.
 * If no groupId is provided, shows an interactive multi-select.
 */
export async function dissolveCommand(
  groupId?: string,
  options: DissolveCommandOptions = {},
): Promise<void> {
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

    await dissolveSingleGroup(targetGroup, options);
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
    console.log("Usage: spry group dissolve <group-id>");
    return;
  }

  // Interactive multi-select
  const selectOptions = groups.map((g) => ({
    label: `"${g.title}"`,
    value: g,
    hint: `${g.commits.length} commit${g.commits.length === 1 ? "" : "s"}`,
  }));

  const result = await multiSelect(selectOptions, "Select groups to dissolve:");

  if (result.cancelled || result.selected.length === 0) {
    console.log("No groups selected.");
    return;
  }

  // Dissolve selected groups
  for (const group of result.selected) {
    await dissolveSingleGroup(group, options);
  }
}

/**
 * Resolve the --inherit option to a commit hash.
 * Accepts: commit hash, short hash, or 1-based index into the group.
 */
function resolveInheritOption(
  inheritOption: string,
  groupCommits: Array<{ hash: string; subject: string }>,
): string | null {
  // Try as 1-based index first
  const index = parseInt(inheritOption, 10);
  if (!isNaN(index) && index >= 1 && index <= groupCommits.length) {
    const commit = groupCommits[index - 1];
    return commit?.hash ?? null;
  }

  // Try as commit hash (full or short)
  const matchingCommit = groupCommits.find(
    (c) => c.hash === inheritOption || c.hash.startsWith(inheritOption),
  );
  return matchingCommit?.hash ?? null;
}

/**
 * Dissolve a single group.
 * If the group has an open PR:
 * - Interactive mode: prompts user to choose which commit should inherit it
 * - Non-interactive mode: requires --inherit or --no-inherit flag
 */
async function dissolveSingleGroup(
  group: PRUnit,
  options: DissolveCommandOptions = {},
): Promise<void> {
  // Check if this group has an open PR
  const branchConfig = await getBranchNameConfig();
  const branchName = getBranchName(group.id, branchConfig);
  const pr = await findPRByBranch(branchName);

  let assignGroupIdToCommit: string | undefined;

  if (pr?.state === "OPEN" && group.commits.length > 0) {
    // Group has an open PR - determine which commit should inherit it
    const commits = await getStackCommitsWithTrailers();
    const groupCommits = commits.filter((c) => group.commits.includes(c.hash));

    // Check if --inherit or --no-inherit was provided
    if (options.inherit === false) {
      // Explicit --no-inherit: don't inherit to any commit
      assignGroupIdToCommit = undefined;
    } else if (typeof options.inherit === "string") {
      // --inherit <commit> provided
      const resolved = resolveInheritOption(options.inherit, groupCommits);
      if (!resolved) {
        console.error(`Error: Could not resolve "${options.inherit}" to a commit in this group.`);
        console.error("");
        console.error("Commits in this group:");
        groupCommits.forEach((c, i) => {
          console.error(`  ${i + 1}. ${c.hash.slice(0, 8)} "${c.subject}"`);
        });
        process.exit(1);
      }
      assignGroupIdToCommit = resolved;
    } else if (isTTY()) {
      // Interactive mode - ask user
      const context = `Group "${group.title}" has an open PR #${pr.number}`;

      const selectOptions: PRAdoptOption[] = groupCommits.map((c, i) => ({
        label: `${i + 1}. "${c.subject}"`,
        value: c.hash,
        description: c.hash.slice(0, 8),
      }));

      selectOptions.push({
        label: "Don't inherit (PR becomes orphaned)",
        value: null,
        description: "No commit will inherit the PR",
      });

      const result = await prAdoptSelect(
        selectOptions,
        "Which commit should inherit the PR?",
        context,
      );

      if (result.cancelled) {
        console.log("Cancelled.");
        return;
      }

      assignGroupIdToCommit = result.adoptedId ?? undefined;
    } else {
      // Non-interactive mode without --inherit flag - error out
      console.error(`Error: Group "${group.title}" has an open PR #${pr.number}.`);
      console.error("");
      console.error("In non-interactive mode, you must specify which commit inherits the PR:");
      console.error("");
      console.error("Commits in this group:");
      groupCommits.forEach((c, i) => {
        console.error(`  ${i + 1}. ${c.hash.slice(0, 8)} "${c.subject}"`);
      });
      console.error("");
      console.error("Options:");
      console.error(
        `  --inherit <N>       Commit index (1-${groupCommits.length}) inherits the PR`,
      );
      console.error("  --inherit <hash>    Commit by hash inherits the PR");
      console.error("  --no-inherit        Don't inherit PR to any commit");
      process.exit(1);
    }
  }

  console.log(`Dissolving group "${group.title}" (${group.id})...`);

  const result = await dissolveGroup(group.id, { assignGroupIdToCommit });

  if (!result.success) {
    console.log(`Error: ${result.error}`);
    process.exit(1);
  }

  console.log(`✓ Group "${group.title}" dissolved.`);
  if (assignGroupIdToCommit) {
    console.log(`  PR #${pr?.number} inherited by commit ${assignGroupIdToCommit.slice(0, 8)}`);
  }
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

  // Read group titles from ref storage
  const groupTitles = await readGroupTitles();

  // Check for validation errors
  const validation = parseStack(commits, groupTitles);

  if (validation.ok) {
    console.log("✓ No invalid groups found. Stack is valid.");
    return;
  }

  // Non-interactive dissolve mode
  if (mode === "dissolve" || !isTTY()) {
    await dissolveErrorGroup(validation);
    return;
  }

  // Interactive repair mode - only split-group errors remain
  await repairSplitGroup(validation);
}

/**
 * Non-interactive dissolve: remove only the problematic group trailers.
 */
async function dissolveErrorGroup(
  validation: Exclude<StackParseResult, { ok: true }>,
): Promise<void> {
  // Show what's wrong
  console.log(formatValidationError(validation));
  console.log("");

  // Only split-group errors remain after removing inconsistent-group-title
  console.log(`Dissolving group "${validation.group.title}"...`);
  const result = await dissolveGroup(validation.group.id);
  if (!result.success) {
    console.error(`✗ Error: ${result.error}`);
    process.exit(1);
  }
  console.log(`✓ Group "${validation.group.title}" dissolved.`);
}

/**
 * Format error summary for repair UI.
 */
function formatErrorSummary(validation: Exclude<StackParseResult, { ok: true }>): string {
  const commitList = validation.group.commits.map((h) => h.slice(0, 8)).join(", ");
  return `✗ Split group: "${validation.group.title}" (${validation.group.id.slice(0, 8)})\n  Commits [${commitList}] are not contiguous.\n  ${validation.interruptingCommits.length} commit(s) appear between group members.`;
}

/**
 * Repair a split group interactively.
 */
async function repairSplitGroup(
  validation: Exclude<StackParseResult, { ok: true }>,
): Promise<void> {
  const errorSummary = formatErrorSummary(validation);

  type RepairAction = "merge" | "dissolve-group" | "dissolve-all";

  const options: Array<{ label: string; value: RepairAction; description: string }> = [
    {
      label: "Merge group commits",
      value: "merge",
      description: "Reorder commits to make the group contiguous again",
    },
    {
      label: "Dissolve this group",
      value: "dissolve-group",
      description: `Remove group trailers from "${validation.group.title}"`,
    },
    {
      label: "Dissolve all groups",
      value: "dissolve-all",
      description: "Remove ALL group trailers from the stack",
    },
  ];

  const result = await repairSelect(options, "Select repair action:", errorSummary);

  if (result.cancelled || !result.selected) {
    console.log("Repair cancelled.");
    return;
  }

  switch (result.selected) {
    case "merge": {
      console.log(`Reordering commits to merge group "${validation.group.title}"...`);
      const mergeResult = await mergeSplitGroup(validation.group.id);

      if (!mergeResult.success) {
        console.error(`✗ Error: ${mergeResult.error}`);
        if (mergeResult.conflictFile) {
          console.error(`  Conflict in: ${mergeResult.conflictFile}`);
        }
        process.exit(1);
      }

      console.log("✓ Group commits merged successfully.");
      break;
    }

    case "dissolve-group": {
      console.log(`Dissolving group "${validation.group.title}"...`);
      const dissolveResult = await dissolveGroup(validation.group.id);

      if (!dissolveResult.success) {
        console.error(`✗ Error: ${dissolveResult.error}`);
        process.exit(1);
      }

      console.log(`✓ Group "${validation.group.title}" dissolved.`);
      break;
    }

    case "dissolve-all": {
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
