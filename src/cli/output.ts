import type { EnrichedPRUnit, StackParseResult } from "../types.ts";
import { getTasprConfig } from "../git/config.ts";

const SEPARATOR = "─".repeat(72);

/**
 * Get status icon based on PR state.
 * - ✓ Merged
 * - ◐ Open
 * - ○ No PR yet
 * - ✗ Closed (not merged)
 */
function getPRStatusIcon(pr?: EnrichedPRUnit["pr"]): string {
  if (!pr) return "○";
  switch (pr.state) {
    case "OPEN":
      return "◐";
    case "MERGED":
      return "✓";
    case "CLOSED":
      return "✗";
    default:
      return "○";
  }
}

/**
 * Format the stack view for terminal output.
 */
export async function formatStackView(
  units: EnrichedPRUnit[],
  branchName: string,
  commitCount: number,
): Promise<string> {
  const config = await getTasprConfig();
  const defaultBranchRef = `origin/${config.defaultBranch}`;

  if (units.length === 0) {
    return `No commits ahead of ${defaultBranchRef}`;
  }

  const lines: string[] = [];

  // Count opened PRs (only OPEN state counts)
  const openedPRCount = units.filter((u) => u.pr?.state === "OPEN").length;

  // Header
  lines.push(
    `Stack: ${branchName} (${commitCount} commit${commitCount === 1 ? "" : "s"}, PRs: ${openedPRCount}/${units.length} opened)`,
  );
  lines.push("");

  // Origin/main indicator
  lines.push(`  → ${defaultBranchRef}`);

  // PRUnits
  for (const unit of units) {
    lines.push(SEPARATOR);
    lines.push(formatPRUnit(unit));
  }

  lines.push(SEPARATOR);

  return lines.join("\n");
}

/**
 * Check if a unit has a real commit ID (not just a hash fallback).
 */
function hasCommitId(unit: EnrichedPRUnit): boolean {
  return unit.commitIds.length > 0;
}

/**
 * Format a single PRUnit for display.
 */
function formatPRUnit(unit: EnrichedPRUnit): string {
  const lines: string[] = [];

  const status = getPRStatusIcon(unit.pr);
  const prNum = unit.pr ? `#${unit.pr.number} ` : "";

  if (unit.type === "single") {
    // Single commit
    lines.push(`  ${status} ${prNum}${unit.title}`);
    const idDisplay = hasCommitId(unit) ? unit.id : "(no commit ID yet)";
    lines.push(`    └─ ${idDisplay}`);
  } else {
    // Group
    const groupIdDisplay = hasCommitId(unit) ? `[${unit.id}]` : "(no commit ID yet)";
    lines.push(`  ${status} ${prNum}${unit.title} ${groupIdDisplay}`);

    // List commits with tree structure
    const commitCount = unit.commits.length;
    for (let i = 0; i < commitCount; i++) {
      const isLast = i === commitCount - 1;
      const prefix = isLast ? "└─" : "├─";
      const commitId = unit.commitIds[i] || "(no commit ID yet)";
      lines.push(`    ${prefix} ${commitId}`);
    }
  }

  // PR URL
  if (unit.pr) {
    lines.push(`    ${unit.pr.url}`);
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
      lines.push(
        `    starts at ${result.group2.startCommit.slice(0, 8)} (inside "${result.group1.title}")`,
      );
      lines.push("");
      lines.push("  Groups cannot overlap. Close the first group before starting a new one.");
      break;

    case "orphan-group-end":
      lines.push(
        `✗ Error: Group end without matching start at commit ${result.commit.slice(0, 8)}`,
      );
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
