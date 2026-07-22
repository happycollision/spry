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
 * Body content for the spry:body region.
 * Single unit: the commit body with trailers removed. Group unit: a bulleted
 * list of the commit subjects.
 */
export function generateBodyContent(unit: PRUnit, commits: CommitInfo[]): string {
  if (unit.type === "single") {
    const commit = commits.find((c) => c.hash === unit.commits[0]);
    if (!commit) return "";
    // commit.body is git's %b — the subject line is NOT included (see
    // parseCommitLog in src/git/queries.ts). So we only strip trailers; do NOT
    // drop a "first line": %b has none.
    return stripTrailers(commit.body).trim();
  }
  return unit.subjects.map((s) => `- ${s}`).join("\n");
}

export function generateFooter(): string {
  return BETA_WARNING;
}

/**
 * Stack-links block for the spry:stack-links region.
 *
 * @param stackUnitIds unit IDs in stack order, oldest -> newest.
 * @param prNumbers    unitId -> PR number, ONLY for units with an open PR.
 * @param currentUnitId the unit whose PR this body belongs to.
 * @param trunk        the target branch name, shown in the header.
 *
 * Renders newest-at-top with MANUAL descending ordinals, matching the
 * convention popularized by Graphite. GitHub-Flavored Markdown renumbers
 * ordered-list items ascending from the first marker no matter what numbers
 * are written, so a literal `3. / 2. / 1.` would render as 3, 4, 5 — the
 * escaped period (`3\.`) is what forces the descending numbers to survive
 * rendering. Only units that have a PR are listed; ordinals count the LISTED
 * PRs, top = count, bottom = 1. Returns "" when no unit has a PR.
 */
export function generateStackLinks(
  stackUnitIds: string[],
  prNumbers: ReadonlyMap<string, number>,
  currentUnitId: string,
  trunk: string,
): string {
  // Filter + resolve in one pass so the type system proves prNumber is defined
  // (no non-null assertion, no dead guard).
  const listed = stackUnitIds.flatMap((id) => {
    const prNumber = prNumbers.get(id);
    return prNumber === undefined ? [] : [{ id, prNumber }];
  });
  if (listed.length === 0) return "";

  const lines = [`**Stack** (newest → oldest, targeting \`${trunk}\`):`];
  // Emit newest-first. Ordinals are DESCENDING and manually written, with the
  // period escaped (`3\.`) so GitHub does NOT render them as an ordered list —
  // GFM renumbers list markers ascending from the first, which would turn
  // 3/2/1 into 3/4/5. Escaped, each line is literal text; single newlines in a
  // PR body hard-break, so the lines still stack vertically. This is the only
  // way to force descending numbering, as the feature requires.
  [...listed].reverse().forEach(({ id, prNumber }, i) => {
    const ordinal = listed.length - i;
    const marker = id === currentUnitId ? " ← this PR" : "";
    lines.push(`${ordinal}\\. #${prNumber}${marker}`);
  });
  return lines.join("\n");
}

export interface BuildInitialBodyOptions {
  unit: PRUnit;
  commits: CommitInfo[];
  /** Rendered stack-links block (from generateStackLinks); "" for an empty region. */
  stackLinks: string;
  /** Repo PR template, seeded ONCE into the user region under the body. */
  prTemplate?: string;
}

/**
 * Full PR body for a brand-new PR: info line, spry:body, optional PR template
 * (user region, seeded only here), spry:stack-links, spry:footer.
 * The stack-links markers are ALWAYS emitted, even when stackLinks is empty
 * (as it always is for a fresh bottom/solo PR, whose own PR number doesn't
 * exist yet at create time), so the region sits in its correct place — before
 * the footer — from creation. If we omitted an empty region here, the later
 * same-run updateStackBodies splice would find no markers and APPEND the
 * region after the footer instead (wrong order). (An empty body still emits
 * its begin/end markers, adjacent, for the same reason.)
 */
export function buildInitialBody(opts: BuildInitialBodyOptions): string {
  const { unit, commits, stackLinks, prTemplate } = opts;
  const parts: string[] = [MARKERS.INFO, ""];

  const bodyContent = generateBodyContent(unit, commits);
  parts.push(MARKERS.BODY_BEGIN);
  if (bodyContent) parts.push(bodyContent);
  parts.push(MARKERS.BODY_END, "");

  const template = prTemplate?.trim();
  if (template) {
    parts.push(template, "");
  }

  // Always emit the stack-links markers, even when empty, so the region sits in
  // its correct place (before the footer) from creation. If we omitted an empty
  // region here, the end-of-sync updateStackBodies pass would later find no
  // markers and APPEND the region after the footer (wrong order). Emitting it
  // now means spliceBody fills it IN PLACE. The empty shape (BEGIN\nEND, no blank
  // line between) must match replaceRegion's empty output exactly so a
  // create-then-sync round-trip is a byte-for-byte no-op.
  if (stackLinks) {
    parts.push(MARKERS.STACK_LINKS_BEGIN, stackLinks, MARKERS.STACK_LINKS_END, "");
  } else {
    parts.push(`${MARKERS.STACK_LINKS_BEGIN}\n${MARKERS.STACK_LINKS_END}`, "");
  }

  parts.push(MARKERS.FOOTER_BEGIN, generateFooter(), MARKERS.FOOTER_END);
  return parts.join("\n");
}

export interface SpliceBodyOptions {
  bodyContent: string;
  /** Rendered stack-links block; "" replaces an existing region's content with empty. */
  stackLinks: string;
}

/**
 * Replace the content between a single begin/end marker pair, in place, leaving
 * every other byte of `body` untouched. Returns null when the pair is absent or
 * malformed (end before begin), so the caller can decide to append.
 */
function replaceRegion(body: string, begin: string, end: string, content: string): string | null {
  const b = body.indexOf(begin);
  if (b === -1) return null;
  const e = body.indexOf(end, b + begin.length);
  if (e === -1) return null;
  const before = body.slice(0, b + begin.length);
  const after = body.slice(e);
  const inner = content ? `\n${content}\n` : "\n";
  return `${before}${inner}${after}`;
}

/** Remove every occurrence of a spry marker string (spry-owned, safe to delete). */
function stripMarker(body: string, marker: string): string {
  return body.split(marker).join("");
}

/**
 * Splice fresh spry content into an existing PR body IN PLACE.
 *
 * Spry owns only the info line and the bytes between each begin/end pair. For
 * each spry region present (well-formed) in `existing`, its inner content is
 * replaced; user bytes outside the markers are preserved verbatim. A region
 * whose pair is absent or MALFORMED (e.g. the user deleted one marker) is
 * healed: any orphaned begin/end marker of that region is stripped, then a
 * fresh complete region is APPENDED in canonical order (info, body,
 * stack-links, footer). Stripping the orphan first prevents a later splice from
 * pairing it with the appended region's opposite marker and eating user text.
 */
export function spliceBody(existing: string, opts: SpliceBodyOptions): string {
  let out = existing;

  const bodyReplaced = replaceRegion(out, MARKERS.BODY_BEGIN, MARKERS.BODY_END, opts.bodyContent);
  if (bodyReplaced !== null) out = bodyReplaced;

  const linksReplaced = replaceRegion(
    out,
    MARKERS.STACK_LINKS_BEGIN,
    MARKERS.STACK_LINKS_END,
    opts.stackLinks,
  );
  if (linksReplaced !== null) out = linksReplaced;

  const footerReplaced = replaceRegion(
    out,
    MARKERS.FOOTER_BEGIN,
    MARKERS.FOOTER_END,
    generateFooter(),
  );
  if (footerReplaced !== null) out = footerReplaced;

  const hasBody = bodyReplaced !== null;
  const hasLinks = linksReplaced !== null;
  const hasFooter = footerReplaced !== null;

  // Heal: strip orphaned markers of any region we are about to append, so a
  // stray BEGIN/END left by a hand-edit can't pair with the fresh region later.
  if (!hasBody) {
    out = stripMarker(stripMarker(out, MARKERS.BODY_BEGIN), MARKERS.BODY_END);
  }
  if (!hasLinks) {
    out = stripMarker(stripMarker(out, MARKERS.STACK_LINKS_BEGIN), MARKERS.STACK_LINKS_END);
  }
  if (!hasFooter) {
    out = stripMarker(stripMarker(out, MARKERS.FOOTER_BEGIN), MARKERS.FOOTER_END);
  }

  const appends: string[] = [];
  if (!out.includes(MARKERS.INFO)) appends.push(MARKERS.INFO);
  if (!hasBody) {
    appends.push(MARKERS.BODY_BEGIN);
    if (opts.bodyContent) appends.push(opts.bodyContent);
    appends.push(MARKERS.BODY_END);
  }
  // Append the stack-links region only when there ARE links. This path is only
  // reached for bodies with no well-formed stack-links markers at all (e.g. a
  // legacy pre-marker PR body, or a healed orphan) — buildInitialBody now always
  // emits the markers (empty or not), so a spry-created body never falls through
  // to this append; it hits the replaceRegion path above instead. Skipping the
  // append when there are no links avoids adding an empty region to a body that
  // never had the marker pair in the first place.
  if (!hasLinks && opts.stackLinks) {
    appends.push(MARKERS.STACK_LINKS_BEGIN, opts.stackLinks, MARKERS.STACK_LINKS_END);
  }
  if (!hasFooter) {
    appends.push(MARKERS.FOOTER_BEGIN, generateFooter(), MARKERS.FOOTER_END);
  }

  if (appends.length === 0) return out;

  const sep = out.trim().length > 0 ? `${out.replace(/\s+$/, "")}\n\n` : "";
  return `${sep}${appends.join("\n")}`;
}
