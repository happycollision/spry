import type { CommitInfo, PRUnit } from "../parse/types.ts";

// Matches `Key: value` lines git treats as trailers. Continuation lines (per
// git interpret-trailers, lines starting with whitespace are folded into the
// previous trailer) are NOT recognized; a multi-line trailer will leave the
// whole trailer block in the body. Spry-generated commits don't use folded
// trailers, so we accept that limitation here.
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*\s*:\s.+$/;

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

export function formatPRBody(unit: PRUnit, commits: CommitInfo[]): string {
  if (unit.type !== "single") {
    throw new Error(`formatPRBody: groups not supported in Step 6 (unit ${unit.id})`);
  }
  const commit = commits.find((c) => c.hash === unit.commits[0]);
  if (!commit) return "";
  return stripTrailers(commit.body);
}
