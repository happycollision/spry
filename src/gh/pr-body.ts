import type { CommitInfo, PRUnit } from "../parse/types.ts";

// Matches `Key: value` lines git treats as trailers. Continuation lines (per
// git interpret-trailers, lines starting with whitespace are folded into the
// previous trailer) are NOT recognized; a multi-line trailer will leave the
// whole trailer block in the body. Spry-generated commits don't use folded
// trailers, so we accept that limitation here.
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*\s*:\s.+$/;

export const MARKERS = {
  INFO: "<!-- spry:info - Your edits outside of spry markers will be preserved on sync. -->",
  BODY_BEGIN: "<!-- spry:body:begin -->",
  BODY_END: "<!-- spry:body:end -->",
  STACK_LINKS_BEGIN: "<!-- spry:stack-links:begin -->",
  STACK_LINKS_END: "<!-- spry:stack-links:end -->",
  FOOTER_BEGIN: "<!-- spry:footer:begin -->",
  FOOTER_END: "<!-- spry:footer:end -->",
} as const;

export const BETA_WARNING =
  "<sub>Created with [Spry](https://github.com/happycollision/spry) (beta). Do not manually merge stacked PRs.</sub>";

export function stripTrailers(body: string): string {
  const lines = body.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;

  let trailerStart = end;
  while (trailerStart > 0 && TRAILER_LINE.test(lines[trailerStart - 1] ?? "")) {
    trailerStart--;
  }
  if (trailerStart === end) {
    return lines.slice(0, end).join("\n");
  }
  if (trailerStart > 0 && (lines[trailerStart - 1] ?? "").trim() !== "") {
    return lines.slice(0, end).join("\n");
  }
  let prose = trailerStart;
  while (prose > 0 && (lines[prose - 1] ?? "").trim() === "") prose--;
  return lines.slice(0, prose).join("\n");
}

export function formatPRTitle(unit: PRUnit, commits: CommitInfo[]): string {
  if (unit.type === "single") {
    const commit = commits.find((c) => c.hash === unit.commits[0]);
    return commit?.subject ?? unit.title ?? "Untitled";
  }
  return unit.title ?? "Untitled group";
}

/**
 * @deprecated Superseded by generateBodyContent (used by the reusable-PR-body
 * path). Kept until sp sync's create path fully migrates. Do not add features
 * here — change generateBodyContent instead.
 */
export function formatPRBody(unit: PRUnit, commits: CommitInfo[]): string {
  if (unit.type !== "single") return "";
  const commit = commits.find((c) => c.hash === unit.commits[0]);
  if (!commit) return "";
  return stripTrailers(commit.body);
}

/**
 * Body content for the spry:body region.
 * Single unit: the commit body with trailers removed. Group unit: a bulleted
 * list of the commit subjects.
 */
export function generateBodyContent(unit: PRUnit, commits: CommitInfo[]): string {
  if (unit.type === "single") {
    const commit = commits.find((c) => c.hash === unit.commits[0]);
    if (!commit) return "";
    // commit.body is git's %b — the subject line is NOT included (see
    // parseCommitLog in src/git/queries.ts). So we only strip trailers, exactly
    // like the existing formatPRBody. Do NOT drop a "first line": %b has none.
    return stripTrailers(commit.body).trim();
  }
  return unit.subjects.map((s) => `- ${s}`).join("\n");
}

export function generateFooter(): string {
  return BETA_WARNING;
}
