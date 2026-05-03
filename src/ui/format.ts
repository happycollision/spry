import kleur from "kleur";
import type { StackParseResult } from "../parse/types.ts";
import type { EnrichedUnit, EnrichmentError } from "../gh/enrich.ts";
import type { ChecksStatus, PRInfo, PRState, ReviewDecision } from "../gh/pr.ts";

const SEPARATOR = "─".repeat(72);

function getCommitIdDisplay(commitIds: string[], index: number): string {
  const id = commitIds[index];
  return id ? kleur.dim(`(${id})`) : kleur.dim("(no ID)");
}

function stateIcon(state: PRState | null): string {
  if (state === null) return kleur.dim("○");
  if (state === "OPEN") return kleur.blue("◐");
  if (state === "MERGED") return kleur.green("✓");
  return kleur.red("✗"); // CLOSED
}

function checksGlyph(s: ChecksStatus): string {
  if (s === "passing") return kleur.green("✓");
  if (s === "failing") return kleur.red("✗");
  if (s === "pending") return kleur.yellow("⏳");
  return kleur.dim("—");
}

function approvalGlyph(d: ReviewDecision): string {
  if (d === "approved") return kleur.green("✓");
  if (d === "changes_requested") return kleur.red("✗");
  if (d === "review_required") return kleur.yellow("?");
  return kleur.dim("—");
}

const HINT_BY_ERROR: Record<EnrichmentError, string> = {
  "no-gh": "PR status unavailable: install gh (https://cli.github.com)",
  auth: "PR status unavailable: gh auth login",
  "no-remote": "PR status unavailable: not a GitHub repository",
  network: "PR status unavailable: network error",
};

function commonError(enriched: EnrichedUnit[]): EnrichmentError | null {
  const head = enriched[0];
  if (!head) return null;
  const first = head.error;
  if (!first) return null;
  return enriched.every((e) => e.error === first) ? first : null;
}

function prMetaLine(pr: PRInfo): string {
  return (
    `    ${kleur.blue(pr.url)} - ` +
    `checks:${checksGlyph(pr.checksStatus)} ` +
    `approval:${approvalGlyph(pr.reviewDecision)} ` +
    `comments:${pr.reviewThreads.resolved}/${pr.reviewThreads.total}`
  );
}

export function formatStackView(
  enriched: EnrichedUnit[],
  branch: string,
  commitCount: number,
  trunkRef: string,
): string {
  if (enriched.length === 0) {
    return `No commits ahead of ${trunkRef}`;
  }

  const lines: string[] = [];
  const plural = commitCount === 1 ? "commit" : "commits";
  lines.push(`Stack: ${branch} (${commitCount} ${plural})`);

  const fallback = commonError(enriched);
  if (fallback) {
    lines.push(kleur.dim(`${HINT_BY_ERROR[fallback]} (showing local view)`));
  }

  // Legend
  lines.push(kleur.dim("○ no PR  ◐ open  ✓ merged  ✗ closed"));
  const showExtendedLegend = !fallback && enriched.some((e) => e.pr !== null);
  if (showExtendedLegend) {
    lines.push(kleur.dim("checks: ✓ pass  ✗ fail  ⏳ pending  — none"));
    lines.push(kleur.dim("approval: ✓ approved  ✗ changes  ? required  — none"));
  }
  lines.push("");
  lines.push(`  → ${trunkRef}`);

  let letterIndex = 0;
  for (const entry of enriched) {
    lines.push(SEPARATOR);
    const unit = entry.unit;
    const pr = entry.pr;
    const showPRLine = !fallback && pr !== null;
    const icon = showPRLine ? stateIcon(pr.state) : stateIcon(null);

    if (unit.type === "single") {
      const idDisplay = getCommitIdDisplay(unit.commitIds, 0);
      lines.push(`  ${icon} ${unit.title ?? unit.subjects[0] ?? "Untitled"} ${idDisplay}`);
      if (showPRLine) lines.push(prMetaLine(pr));
    } else {
      let groupTitle: string;
      if (unit.title) {
        groupTitle = unit.title;
      } else {
        const letter = String.fromCharCode(65 + letterIndex);
        letterIndex++;
        groupTitle = `${letter} (${unit.commits.length} commits)`;
      }
      lines.push(`  ${icon} ${groupTitle}`);
      if (showPRLine) lines.push(prMetaLine(pr));
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
