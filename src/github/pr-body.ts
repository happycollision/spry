import { $ } from "bun";
import type { PRUnit, CommitInfo } from "../types.ts";
import type { TemplateLocation } from "../git/config.ts";
import { createHash } from "crypto";

/**
 * PR body generation and parsing utilities.
 *
 * Generates PR bodies with:
 * - Info comment explaining edit preservation
 * - Commit message content (single or group list)
 * - Optional PR template
 * - Stack links showing all PRs in order
 * - Alpha warning footer
 *
 * Preserves user-edited content outside of Spry markers on updates.
 */

export const MARKERS = {
  INFO: "<!-- spry:info - Your edits outside of spry markers will be preserved on sync. -->",
  BODY_BEGIN: "<!-- spry:body:begin -->",
  BODY_END: "<!-- spry:body:end -->",
  STACK_LINKS_BEGIN: "<!-- spry:stack-links:begin -->",
  STACK_LINKS_END: "<!-- spry:stack-links:end -->",
  FOOTER_BEGIN: "<!-- spry:footer:begin -->",
  FOOTER_END: "<!-- spry:footer:end -->",
} as const;

export const ALPHA_WARNING =
  "<sub>Created with [Spry](https://github.com/happycollision/spry) (alpha). Do not manually merge stacked PRs.</sub>";

/** Standard locations for PR templates (checked in order) */
const PR_TEMPLATE_LOCATIONS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
];

/** Parsed sections from an existing PR body */
export interface PRBodyParts {
  /** Content before the info marker (user prepended content) */
  prePreamble: string;
  /** Content after info marker but before body:begin */
  preBody: string;
  /** Content between body:begin and body:end */
  bodyContent: string;
  /** Content between body:end and stack-links:begin (includes template) */
  postBody: string;
  /** Content between stack-links:begin and stack-links:end */
  stackLinksContent: string;
  /** Content between stack-links:end and footer:begin */
  postStackLinks: string;
  /** Content between footer:begin and footer:end */
  footerContent: string;
  /** Content after footer:end (user appended content) */
  postFooter: string;
  /** Whether the info marker was found */
  hasInfoMarker: boolean;
}

/** PR info for stack links generation */
export interface StackPRInfo {
  prNumber: number;
  /** Index in the stack (0 = oldest/bottom) */
  index: number;
}

/** Options for generating initial PR body */
export interface GenerateInitialPRBodyOptions {
  unit: PRUnit;
  /** Full commit info for accessing message bodies */
  commits: CommitInfo[];
  /** PR template content (if found) */
  prTemplate?: string;
  /** Where to place the template */
  prTemplateLocation: TemplateLocation;
  /** Stack PR info for generating links */
  stackPRs?: StackPRInfo[];
  /** Index of this PR in the stack */
  currentIndex?: number;
  /** Target branch for stack links header */
  targetBranch?: string;
  /** Whether to show stack links */
  showStackLinks: boolean;
}

/** Options for updating an existing PR body */
export interface UpdatePRBodyOptions {
  /** Existing PR body to update */
  existingBody: string;
  /** New body content (commit messages) */
  bodyContent: string;
  /** New stack links content */
  stackLinksContent?: string;
  /** Whether to show stack links */
  showStackLinks: boolean;
}

/**
 * Strip git trailers from commit body.
 * Trailers are key-value pairs at the end of the message.
 */
export function stripTrailersFromBody(body: string): string {
  const lines = body.split("\n");
  const trailerPattern = /^[A-Za-z][A-Za-z0-9-]*:\s/;

  // Find where trailers start (from the end)
  let trailerStartIndex = lines.length;
  let foundBlankLine = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    if (line.trim() === "") {
      if (foundBlankLine) {
        // Second blank line - trailers must be between blank lines
        break;
      }
      foundBlankLine = true;
      continue;
    }

    if (trailerPattern.test(line)) {
      trailerStartIndex = i;
    } else if (foundBlankLine) {
      // Non-trailer, non-blank line after we found a blank - stop looking
      break;
    } else {
      // Non-trailer line and no blank line found - no trailers section
      trailerStartIndex = lines.length;
      break;
    }
  }

  // If we found trailers, also remove the blank line before them
  if (trailerStartIndex < lines.length && trailerStartIndex > 0) {
    if (lines[trailerStartIndex - 1]?.trim() === "") {
      trailerStartIndex--;
    }
  }

  return lines.slice(0, trailerStartIndex).join("\n").trimEnd();
}

/**
 * Find PR template in standard repository locations.
 * Returns template content or undefined if not found.
 */
export async function findPRTemplate(cwd?: string): Promise<string | undefined> {
  for (const location of PR_TEMPLATE_LOCATIONS) {
    const path = cwd ? `${cwd}/${location}` : location;
    const file = Bun.file(path);

    if (await file.exists()) {
      const content = await file.text();
      return content.trim();
    }
  }
  return undefined;
}

/**
 * Generate body content from a PRUnit.
 * For single commits: the commit message body (without trailers).
 * For groups: a list of commit subjects.
 */
export function generateBodyContent(unit: PRUnit, commits: CommitInfo[]): string {
  if (unit.type === "single") {
    // For single commits, use the full commit body minus trailers and subject
    const commit = commits.find((c) => c.hash === unit.commits[0]);
    if (!commit) {
      return "";
    }

    // Body includes subject as first line - remove it
    const bodyWithoutSubject = commit.body.split("\n").slice(1).join("\n").trim();

    return stripTrailersFromBody(bodyWithoutSubject);
  }

  // For groups, list the commit subjects
  const lines = unit.subjects.map((subject) => `- ${subject}`);
  return lines.join("\n");
}

/**
 * Generate stack links content.
 * Uses GitHub native PR references (#123) which auto-render with title/status.
 */
export function generateStackLinksContent(
  stackPRs: StackPRInfo[],
  currentIndex: number,
  targetBranch: string,
): string {
  if (stackPRs.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push(`**Stack** (oldest → newest, targeting \`${targetBranch}\`):`);

  // Sort by index (oldest first)
  const sortedPRs = [...stackPRs].sort((a, b) => a.index - b.index);

  for (const pr of sortedPRs) {
    const isCurrent = pr.index === currentIndex;
    const marker = isCurrent ? " ← this PR" : "";
    lines.push(`- #${pr.prNumber}${marker}`);
  }

  return lines.join("\n");
}

/**
 * Generate footer content (alpha warning).
 */
export function generateFooterContent(): string {
  return ALPHA_WARNING;
}

/**
 * Generate the initial PR body for a new PR.
 */
export function generateInitialPRBody(options: GenerateInitialPRBodyOptions): string {
  const {
    unit,
    commits,
    prTemplate,
    prTemplateLocation,
    stackPRs,
    currentIndex,
    targetBranch,
    showStackLinks,
  } = options;

  const parts: string[] = [];

  // Info comment
  parts.push(MARKERS.INFO);
  parts.push("");

  // Template at prepend location
  if (prTemplate && prTemplateLocation === "prepend") {
    parts.push(prTemplate);
    parts.push("");
  }

  // Body section
  const bodyContent = generateBodyContent(unit, commits);
  parts.push(MARKERS.BODY_BEGIN);
  if (bodyContent) {
    parts.push(bodyContent);
  }
  parts.push(MARKERS.BODY_END);
  parts.push("");

  // Template at afterBody location
  if (prTemplate && prTemplateLocation === "afterBody") {
    parts.push(prTemplate);
    parts.push("");
  }

  // Stack links section (if enabled and we have PR info)
  if (
    showStackLinks &&
    stackPRs &&
    stackPRs.length > 0 &&
    currentIndex !== undefined &&
    targetBranch
  ) {
    const stackLinksContent = generateStackLinksContent(stackPRs, currentIndex, targetBranch);
    parts.push(MARKERS.STACK_LINKS_BEGIN);
    parts.push(stackLinksContent);
    parts.push(MARKERS.STACK_LINKS_END);
    parts.push("");
  }

  // Template at afterStackLinks location
  if (prTemplate && prTemplateLocation === "afterStackLinks") {
    parts.push(prTemplate);
    parts.push("");
  }

  // Footer section
  parts.push(MARKERS.FOOTER_BEGIN);
  parts.push(generateFooterContent());
  parts.push(MARKERS.FOOTER_END);

  // Template at append location
  if (prTemplate && prTemplateLocation === "append") {
    parts.push("");
    parts.push(prTemplate);
  }

  return parts.join("\n");
}

/**
 * Parse an existing PR body into its component parts.
 * Extracts user content from gaps between markers.
 */
export function parsePRBody(body: string): PRBodyParts {
  const result: PRBodyParts = {
    prePreamble: "",
    preBody: "",
    bodyContent: "",
    postBody: "",
    stackLinksContent: "",
    postStackLinks: "",
    footerContent: "",
    postFooter: "",
    hasInfoMarker: false,
  };

  if (!body) {
    return result;
  }

  // Check for info marker
  const infoIndex = body.indexOf(MARKERS.INFO);
  result.hasInfoMarker = infoIndex !== -1;

  // Find all marker positions
  const bodyBeginIndex = body.indexOf(MARKERS.BODY_BEGIN);
  const bodyEndIndex = body.indexOf(MARKERS.BODY_END);
  const stackBeginIndex = body.indexOf(MARKERS.STACK_LINKS_BEGIN);
  const stackEndIndex = body.indexOf(MARKERS.STACK_LINKS_END);
  const footerBeginIndex = body.indexOf(MARKERS.FOOTER_BEGIN);
  const footerEndIndex = body.indexOf(MARKERS.FOOTER_END);

  // Extract pre-preamble (before info marker)
  if (infoIndex !== -1) {
    result.prePreamble = body.slice(0, infoIndex).trim();
  }

  // Extract pre-body (after info marker, before body:begin)
  if (result.hasInfoMarker && bodyBeginIndex !== -1) {
    const afterInfo = infoIndex + MARKERS.INFO.length;
    result.preBody = body.slice(afterInfo, bodyBeginIndex).trim();
  } else if (!result.hasInfoMarker && bodyBeginIndex !== -1) {
    // No info marker - everything before body:begin is preBody
    result.preBody = body.slice(0, bodyBeginIndex).trim();
  }

  // Extract body content
  if (bodyBeginIndex !== -1 && bodyEndIndex !== -1 && bodyEndIndex > bodyBeginIndex) {
    const afterBodyBegin = bodyBeginIndex + MARKERS.BODY_BEGIN.length;
    result.bodyContent = body.slice(afterBodyBegin, bodyEndIndex).trim();
  }

  // Extract post-body (between body:end and stack-links:begin or footer:begin)
  if (bodyEndIndex !== -1) {
    const afterBodyEnd = bodyEndIndex + MARKERS.BODY_END.length;
    const nextMarkerIndex =
      stackBeginIndex !== -1
        ? stackBeginIndex
        : footerBeginIndex !== -1
          ? footerBeginIndex
          : body.length;
    result.postBody = body.slice(afterBodyEnd, nextMarkerIndex).trim();
  }

  // Extract stack links content
  if (stackBeginIndex !== -1 && stackEndIndex !== -1 && stackEndIndex > stackBeginIndex) {
    const afterStackBegin = stackBeginIndex + MARKERS.STACK_LINKS_BEGIN.length;
    result.stackLinksContent = body.slice(afterStackBegin, stackEndIndex).trim();
  }

  // Extract post-stack-links (between stack-links:end and footer:begin)
  if (stackEndIndex !== -1 && footerBeginIndex !== -1 && footerBeginIndex > stackEndIndex) {
    const afterStackEnd = stackEndIndex + MARKERS.STACK_LINKS_END.length;
    result.postStackLinks = body.slice(afterStackEnd, footerBeginIndex).trim();
  }

  // Extract footer content
  if (footerBeginIndex !== -1 && footerEndIndex !== -1 && footerEndIndex > footerBeginIndex) {
    const afterFooterBegin = footerBeginIndex + MARKERS.FOOTER_BEGIN.length;
    result.footerContent = body.slice(afterFooterBegin, footerEndIndex).trim();
  }

  // Extract post-footer (after footer:end)
  if (footerEndIndex !== -1) {
    const afterFooterEnd = footerEndIndex + MARKERS.FOOTER_END.length;
    result.postFooter = body.slice(afterFooterEnd).trim();
  }

  return result;
}

/**
 * Generate an updated PR body, preserving user content in gaps.
 */
export function generateUpdatedPRBody(options: UpdatePRBodyOptions): string {
  const { existingBody, bodyContent, stackLinksContent, showStackLinks } = options;

  const parsed = parsePRBody(existingBody);
  const parts: string[] = [];

  // Preserve pre-preamble user content
  if (parsed.prePreamble) {
    parts.push(parsed.prePreamble);
    parts.push("");
  }

  // Info comment
  parts.push(MARKERS.INFO);
  parts.push("");

  // Preserve pre-body user content
  if (parsed.preBody) {
    parts.push(parsed.preBody);
    parts.push("");
  }

  // Body section with new content
  parts.push(MARKERS.BODY_BEGIN);
  if (bodyContent) {
    parts.push(bodyContent);
  }
  parts.push(MARKERS.BODY_END);
  parts.push("");

  // Preserve post-body user content (includes any PR template they may have edited)
  if (parsed.postBody) {
    parts.push(parsed.postBody);
    parts.push("");
  }

  // Stack links section (if enabled)
  if (showStackLinks && stackLinksContent) {
    parts.push(MARKERS.STACK_LINKS_BEGIN);
    parts.push(stackLinksContent);
    parts.push(MARKERS.STACK_LINKS_END);
    parts.push("");
  }

  // Preserve post-stack-links user content
  if (parsed.postStackLinks) {
    parts.push(parsed.postStackLinks);
    parts.push("");
  }

  // Footer section
  parts.push(MARKERS.FOOTER_BEGIN);
  parts.push(generateFooterContent());
  parts.push(MARKERS.FOOTER_END);

  // Preserve post-footer user content
  if (parsed.postFooter) {
    parts.push("");
    parts.push(parsed.postFooter);
  }

  return parts.join("\n");
}

/**
 * Calculate a content hash for change detection.
 * Used to determine if a PR body needs updating.
 */
export function calculateContentHash(bodyContent: string, stackLinksContent: string): string {
  const combined = `${bodyContent}\n---\n${stackLinksContent}`;
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}
