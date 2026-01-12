import type { PRUnit, CommitInfo } from "../types.ts";
import { validateIdentifiers } from "./validation.ts";

/**
 * Result of resolving an identifier to a unit.
 */
export type IdentifierResolution =
  | { ok: true; unit: PRUnit }
  | { ok: false; error: "not-found"; identifier: string }
  | { ok: false; error: "ambiguous"; identifier: string; matches: string[] };

/**
 * Resolve an identifier to a PRUnit.
 *
 * The identifier can be:
 * - A full git commit hash
 * - A short git commit hash (7-8 chars)
 * - A Spry-Commit-Id
 * - A group ID (from Spry-Group trailer)
 *
 * @param identifier - The identifier to resolve
 * @param units - The parsed PRUnits from the stack
 * @param commits - The raw commits (for hash lookups)
 */
export function resolveIdentifier(
  identifier: string,
  units: PRUnit[],
  commits: CommitInfo[],
): IdentifierResolution {
  // First try: exact match on unit ID (handles Spry-Commit-Id and group IDs)
  const exactMatch = units.find((u) => u.id === identifier);
  if (exactMatch) {
    return { ok: true, unit: exactMatch };
  }

  // Second try: unit ID prefix match
  const prefixMatches = units.filter((u) => u.id.startsWith(identifier));
  if (prefixMatches.length === 1 && prefixMatches[0]) {
    return { ok: true, unit: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    return {
      ok: false,
      error: "ambiguous",
      identifier,
      matches: prefixMatches.map((u) => u.id),
    };
  }

  // Third try: git commit hash (full or short)
  // Find commits that match the identifier as a hash prefix
  const hashMatches = commits.filter((c) => c.hash.startsWith(identifier));

  if (hashMatches.length === 0) {
    return { ok: false, error: "not-found", identifier };
  }

  if (hashMatches.length > 1) {
    return {
      ok: false,
      error: "ambiguous",
      identifier,
      matches: hashMatches.map((c) => c.hash.slice(0, 8)),
    };
  }

  // Found exactly one commit by hash - now find which unit it belongs to
  const matchedHash = hashMatches[0]?.hash;
  if (!matchedHash) {
    return { ok: false, error: "not-found", identifier };
  }
  const unitForCommit = units.find((u) => u.commits.includes(matchedHash));

  if (!unitForCommit) {
    // This shouldn't happen if commits and units are in sync, but handle it
    return { ok: false, error: "not-found", identifier };
  }

  return { ok: true, unit: unitForCommit };
}

/**
 * Resolve multiple identifiers and collect errors.
 *
 * @param identifiers - Array of identifiers to resolve
 * @param units - The parsed PRUnits from the stack
 * @param commits - The raw commits
 * @returns Object with resolved unit IDs (Set for deduping) and any errors
 */
export function resolveIdentifiers(
  identifiers: string[],
  units: PRUnit[],
  commits: CommitInfo[],
): { unitIds: Set<string>; errors: IdentifierResolution[] } {
  const unitIds = new Set<string>();
  const errors: IdentifierResolution[] = [];

  for (const id of identifiers) {
    const result = resolveIdentifier(id, units, commits);
    if (result.ok) {
      unitIds.add(result.unit.id);
    } else {
      errors.push(result);
    }
  }

  return { unitIds, errors };
}

/**
 * Format an identifier resolution error for display.
 */
export function formatResolutionError(error: IdentifierResolution): string {
  if (error.ok) {
    return "";
  }

  switch (error.error) {
    case "not-found":
      return `Error: No commit or group matching '${error.identifier}' found in stack`;
    case "ambiguous":
      return `Error: '${error.identifier}' matches multiple commits. Please provide more characters to disambiguate.\n  Matches: ${error.matches.join(", ")}`;
  }
}

/**
 * Parse the --apply JSON format for sync --open.
 *
 * Expected format: JSON array of identifiers
 * Example: '["abc123", "def456"]'
 *
 * @param json - The JSON string to parse
 * @returns Array of identifier strings
 * @throws Error if the format is invalid
 */
export function parseApplySpec(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid --apply format. Expected JSON array of identifiers.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid --apply format. Expected JSON array of identifiers.");
  }

  for (const item of parsed) {
    if (typeof item !== "string") {
      throw new Error("Invalid --apply format. All items must be strings.");
    }
  }

  // Validate identifier formats
  const identifiers = parsed as string[];
  const validationErrors = validateIdentifiers(identifiers);
  if (validationErrors.length > 0) {
    const firstError = validationErrors[0];
    if (firstError && !firstError.ok) {
      throw new Error(firstError.error);
    }
  }

  return identifiers;
}

/**
 * Result of resolving --up-to identifier
 */
export type UpToResolution =
  | { ok: true; unitIds: Set<string> }
  | { ok: false; error: IdentifierResolution };

/**
 * Resolve --up-to identifier and return all unit IDs from the bottom of
 * the stack up to and including the specified unit.
 *
 * @param identifier - The identifier to resolve
 * @param units - The parsed PRUnits from the stack (ordered bottom to top)
 * @param commits - The raw commits
 */
export function resolveUpTo(
  identifier: string,
  units: PRUnit[],
  commits: CommitInfo[],
): UpToResolution {
  const result = resolveIdentifier(identifier, units, commits);
  if (!result.ok) {
    return { ok: false, error: result };
  }

  const targetUnit = result.unit;
  const unitIds = new Set<string>();

  // Collect all unit IDs from the bottom up to and including the target
  for (const unit of units) {
    unitIds.add(unit.id);
    if (unit.id === targetUnit.id) {
      break;
    }
  }

  return { ok: true, unitIds };
}
