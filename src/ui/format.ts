import kleur from "kleur";
import type { PRUnit, StackParseResult } from "../parse/types.ts";

const SEPARATOR = "─".repeat(72);

function getCommitIdDisplay(commitIds: string[], index: number): string {
  const id = commitIds[index];
  return id ? kleur.dim(`(${id})`) : kleur.dim("(no ID)");
}

export function formatStackView(
  units: PRUnit[],
  branch: string,
  commitCount: number,
  trunkRef: string,
): string {
  if (units.length === 0) {
    return `No commits ahead of ${trunkRef}`;
  }

  const lines: string[] = [];

  // Header
  const plural = commitCount === 1 ? "commit" : "commits";
  lines.push(`Stack: ${branch} (${commitCount} ${plural})`);

  // Legend
  lines.push(kleur.dim("○ no PR  ◐ open  ✓ merged  ✗ closed"));
  lines.push("");

  // Trunk ref indicator
  lines.push(`  → ${trunkRef}`);

  // Track auto-generated letter index for untitled groups
  let letterIndex = 0;

  for (const unit of units) {
    lines.push(SEPARATOR);

    const icon = "○"; // Local view — always no PR

    if (unit.type === "single") {
      const idDisplay = getCommitIdDisplay(unit.commitIds, 0);
      lines.push(`  ${icon} ${unit.title ?? unit.subjects[0] ?? "Untitled"} ${idDisplay}`);
    } else {
      // Group
      let groupTitle: string;
      if (unit.title) {
        groupTitle = unit.title;
      } else {
        const letter = String.fromCharCode(65 + letterIndex); // A, B, C...
        letterIndex++;
        groupTitle = `${letter} (${unit.commits.length} commits)`;
      }
      lines.push(`  ${icon} ${groupTitle}`);

      // Tree structure for group commits
      for (let i = 0; i < unit.commits.length; i++) {
        const isLast = i === unit.commits.length - 1;
        const prefix = isLast ? "└─" : "├─";
        const subject = unit.subjects[i] ?? "Unknown commit";
        const idDisplay = getCommitIdDisplay(unit.commitIds, i);
        lines.push(`    ${prefix} ${subject} ${idDisplay}`);
      }
    }
  }

  lines.push(SEPARATOR);
  return lines.join("\n");
}

export function formatValidationError(result: Exclude<StackParseResult, { ok: true }>): string {
  const lines: string[] = [];

  switch (result.error) {
    case "split-group": {
      const commitList = result.group.commits.map((h) => h.slice(0, 8)).join(", ");
      lines.push("Error: Split group detected");
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
      lines.push("  To fix:");
      lines.push("    sp group --fix   Guided repair (merge or dissolve)");
      lines.push("    sp group         Manual fix via the group editor");
      break;
    }
  }

  return lines.join("\n");
}
