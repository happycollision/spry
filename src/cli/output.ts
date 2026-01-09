import type { EnrichedPRUnit, PRStatus, StackParseResult } from "../types.ts";
import type { UserPR } from "./commands/view.ts";
import { getSpryConfig } from "../git/config.ts";

const SEPARATOR = "─".repeat(72);

/**
 * Format blocking indicators for a PR's status.
 * Shows CI check status, review status, and unresolved comments.
 */
export function formatBlockingIndicators(status: PRStatus): string {
  const indicators: string[] = [];

  // CI checks
  if (status.checks === "pending") {
    indicators.push("⏳ checks");
  } else if (status.checks === "failing") {
    indicators.push("❌ checks");
  }

  // Review status
  if (status.review === "review_required") {
    indicators.push("👀 review");
  } else if (status.review === "changes_requested") {
    indicators.push("❌ review");
  }

  // Comment threads - show if any unresolved
  if (status.comments.total > 0 && status.comments.resolved < status.comments.total) {
    indicators.push(`💬 ${status.comments.resolved}/${status.comments.total}`);
  }

  return indicators.join("  ");
}

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
  const config = await getSpryConfig();
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

  // Legend
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  lines.push(`${dim}○ no PR  ◐ open  ✓ merged  ✗ closed${reset}`);
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

  const statusIcon = getPRStatusIcon(unit.pr);
  const prNum = unit.pr ? `#${unit.pr.number} ` : "";
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";

  if (unit.type === "single") {
    // Single commit - show ID inline in dim style
    const idDisplay = hasCommitId(unit) ? ` ${dim}(${unit.id})${reset}` : ` ${dim}(no ID)${reset}`;
    lines.push(`  ${statusIcon} ${prNum}${unit.title}${idDisplay}`);
  } else {
    // Group - show title (or "(unnamed)" if no title stored), plus group ID indicator if missing
    const displayTitle = unit.title ?? "(unnamed)";
    const groupIdDisplay = hasCommitId(unit) ? "" : " (no commit ID yet)";
    lines.push(`  ${statusIcon} ${prNum}${displayTitle}${groupIdDisplay}`);

    // List commits with tree structure
    const commitCount = unit.commits.length;
    for (let i = 0; i < commitCount; i++) {
      const isLast = i === commitCount - 1;
      const prefix = isLast ? "└─" : "├─";
      const subject = unit.subjects[i] || "Unknown commit";
      const commitId = unit.commitIds[i];
      const idDisplay = commitId ? ` ${dim}(${commitId})${reset}` : ` ${dim}(no ID)${reset}`;
      lines.push(`    ${prefix} ${subject}${idDisplay}`);
    }
  }

  // PR URL
  if (unit.pr) {
    const blue = "\x1b[34m";
    lines.push(`    ${blue}${unit.pr.url}${reset}`);
  }

  // Blocking indicators on separate line below URL
  const indicators = unit.pr?.status ? formatBlockingIndicators(unit.pr.status) : "";
  if (indicators) {
    lines.push(`    ${indicators}`);
  }

  return lines.join("\n");
}

/**
 * Format a validation error for terminal output.
 */
export function formatValidationError(result: Exclude<StackParseResult, { ok: true }>): string {
  const lines: string[] = [];

  switch (result.error) {
    case "split-group": {
      const commitList = result.group.commits.map((h) => h.slice(0, 8)).join(", ");
      lines.push(`✗ Error: Split group detected`);
      lines.push("");
      lines.push(
        `  Group "${result.group.title}" (${result.group.id.slice(0, 8)}) has non-contiguous commits.`,
      );
      lines.push(`  Commits: [${commitList}]`);
      lines.push("");
      lines.push(`  ${result.interruptingCommits.length} commit(s) appear between group members:`);
      for (const hash of result.interruptingCommits) {
        lines.push(`    - ${hash.slice(0, 8)}`);
      }
      lines.push("");
      lines.push("  This can happen when fixup! commits are squashed into a group.");
      lines.push("  To fix, run `sp group --fix` to merge or dissolve the group.");
      break;
    }
  }

  return lines.join("\n");
}

/**
 * Get status icon based on PR state string.
 */
function getAllPRStatusIcon(state: "OPEN" | "CLOSED" | "MERGED"): string {
  switch (state) {
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
 * Format the view of all PRs authored by the current user.
 */
export function formatAllPRsView(prs: UserPR[], username: string): string {
  const lines: string[] = [];

  // Group PRs by state
  const openPRs = prs.filter((pr) => pr.state === "OPEN");
  const mergedPRs = prs.filter((pr) => pr.state === "MERGED");
  const closedPRs = prs.filter((pr) => pr.state === "CLOSED");

  lines.push(`All PRs by ${username}`);
  lines.push("");

  if (prs.length === 0) {
    lines.push("  No PRs found");
    return lines.join("\n");
  }

  // Open PRs
  if (openPRs.length > 0) {
    lines.push(`Open (${openPRs.length})`);
    lines.push(SEPARATOR);
    for (const pr of openPRs) {
      lines.push(`  ${getAllPRStatusIcon(pr.state)} #${pr.number} ${pr.title}`);
      lines.push(`    ${pr.url}`);
    }
    lines.push("");
  }

  // Merged PRs
  if (mergedPRs.length > 0) {
    lines.push(`Merged (${mergedPRs.length})`);
    lines.push(SEPARATOR);
    for (const pr of mergedPRs) {
      lines.push(`  ${getAllPRStatusIcon(pr.state)} #${pr.number} ${pr.title}`);
      lines.push(`    ${pr.url}`);
    }
    lines.push("");
  }

  // Closed PRs (not merged)
  if (closedPRs.length > 0) {
    lines.push(`Closed (${closedPRs.length})`);
    lines.push(SEPARATOR);
    for (const pr of closedPRs) {
      lines.push(`  ${getAllPRStatusIcon(pr.state)} #${pr.number} ${pr.title}`);
      lines.push(`    ${pr.url}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
