import type { PRUnit, StackParseResult } from "../types.ts";

const SEPARATOR = "─".repeat(72);

/**
 * Format the stack view for terminal output.
 */
export function formatStackView(
  units: PRUnit[],
  branchName: string,
  commitCount: number
): string {
  if (units.length === 0) {
    return "No commits ahead of origin/main";
  }

  const lines: string[] = [];

  // Header
  lines.push(`Stack: ${branchName} (${commitCount} commit${commitCount === 1 ? "" : "s"}, ${units.length} PR${units.length === 1 ? "" : "s"})`);
  lines.push("");

  // PRUnits
  for (const unit of units) {
    lines.push(SEPARATOR);
    lines.push(formatPRUnit(unit));
  }

  // Footer
  lines.push(SEPARATOR);
  lines.push("  ↓ origin/main");

  return lines.join("\n");
}

/**
 * Format a single PRUnit for display.
 */
function formatPRUnit(unit: PRUnit): string {
  const lines: string[] = [];

  // Status indicator (○ for local-only, will add ✓ ◐ etc. later)
  const status = "○";

  if (unit.type === "single") {
    // Single commit
    lines.push(`  ${status} ${unit.title}`);
    lines.push(`    └─ ${unit.id}`);
  } else {
    // Group
    lines.push(`  ${status} ${unit.title} [${unit.id}]`);

    // List commits with tree structure
    for (let i = 0; i < unit.commitIds.length; i++) {
      const isLast = i === unit.commitIds.length - 1;
      const prefix = isLast ? "└─" : "├─";
      const commitId = unit.commitIds[i] || unit.commits[i]?.slice(0, 8) || "unknown";
      lines.push(`    ${prefix} ${commitId}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a validation error for terminal output.
 */
export function formatValidationError(result: Exclude<StackParseResult, { ok: true }>): string {
  const lines: string[] = [];

  switch (result.error) {
    case "unclosed-group":
      lines.push(`✗ Error: Unclosed group starting at commit ${result.startCommit.slice(0, 8)}`);
      lines.push("");
      lines.push(`  Group ${result.groupId} ("${result.groupTitle}") has Taspr-Group-Start but no`);
      lines.push("  matching Taspr-Group-End was found in subsequent commits.");
      lines.push("");
      lines.push("  To fix, either:");
      lines.push("    1. Add Taspr-Group-End trailer to the last commit in the group");
      lines.push("    2. Remove the Taspr-Group-Start trailer to make them individual PRs");
      break;

    case "overlapping-groups":
      lines.push("✗ Error: Overlapping groups detected");
      lines.push("");
      lines.push(`  Group "${result.group1.title}" (${result.group1.id}):`);
      lines.push(`    starts at ${result.group1.startCommit.slice(0, 8)}`);
      lines.push("");
      lines.push(`  Group "${result.group2.title}" (${result.group2.id}):`);
      lines.push(`    starts at ${result.group2.startCommit.slice(0, 8)} (inside "${result.group1.title}")`);
      lines.push("");
      lines.push("  Groups cannot overlap. Close the first group before starting a new one.");
      break;

    case "orphan-group-end":
      lines.push(`✗ Error: Group end without matching start at commit ${result.commit.slice(0, 8)}`);
      lines.push("");
      lines.push(`  Found Taspr-Group-End: ${result.groupId} but no matching`);
      lines.push("  Taspr-Group-Start was found in preceding commits.");
      lines.push("");
      lines.push("  To fix, either:");
      lines.push("    1. Add Taspr-Group-Start trailer to the first commit in the group");
      lines.push("    2. Remove the Taspr-Group-End trailer");
      break;
  }

  return lines.join("\n");
}
