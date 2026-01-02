import { runGroupEditor } from "../../tui/group-editor.ts";
import {
  dissolveGroup,
  applyGroupSpec,
  parseGroupSpec,
  removeAllGroupTrailers,
} from "../../git/group-rebase.ts";
import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import { formatValidationError } from "../output.ts";
import { multiSelect } from "../../tui/multi-select.ts";
import { isTTY } from "../../tui/terminal.ts";
import type { PRUnit } from "../../types.ts";

export interface GroupCommandOptions {
  apply?: string;
  fix?: boolean;
}

/**
 * Main group command - launches the TUI editor or applies a spec.
 */
export async function groupCommand(options: GroupCommandOptions = {}): Promise<void> {
  // Fix mode: repair invalid group trailers
  if (options.fix) {
    await fixCommand();
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
 * Fix invalid group trailers by removing all group trailers from commits.
 * This repairs unclosed groups, overlapping groups, and orphan group ends.
 */
async function fixCommand(): Promise<void> {
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

  // Show what's wrong
  console.log(formatValidationError(validation));
  console.log("");

  // Count commits with group trailers
  const commitsWithTrailers = commits.filter(
    (c) =>
      c.trailers["Taspr-Group-Start"] ||
      c.trailers["Taspr-Group-End"] ||
      c.trailers["Taspr-Group-Title"],
  );

  if (commitsWithTrailers.length === 0) {
    console.log("No group trailers found to remove.");
    return;
  }

  console.log(`Removing group trailers from ${commitsWithTrailers.length} commit(s)...`);

  const result = await removeAllGroupTrailers();

  if (!result.success) {
    console.error(`✗ Error: ${result.error}`);
    if (result.conflictFile) {
      console.error(`  Conflict in: ${result.conflictFile}`);
    }
    process.exit(1);
  }

  console.log("✓ All group trailers removed. Commits are now ungrouped.");
}
