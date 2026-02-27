import type { PRUnit, CommitInfo, IdentifierResolution, UpToResolution } from "./types.ts";
import { validateIdentifiers } from "./validation.ts";

export function resolveIdentifier(
  identifier: string,
  units: PRUnit[],
  commits: CommitInfo[],
): IdentifierResolution {
  // Exact match on unit ID
  const exactMatch = units.find((u) => u.id === identifier);
  if (exactMatch) return { ok: true, unit: exactMatch };

  // Prefix match on unit ID
  const prefixMatches = units.filter((u) => u.id.startsWith(identifier));
  if (prefixMatches.length === 1 && prefixMatches[0]) return { ok: true, unit: prefixMatches[0] };
  if (prefixMatches.length > 1) {
    return { ok: false, error: "ambiguous", identifier, matches: prefixMatches.map((u) => u.id) };
  }

  // Git commit hash match
  const hashMatches = commits.filter((c) => c.hash.startsWith(identifier));
  if (hashMatches.length === 0) return { ok: false, error: "not-found", identifier };
  if (hashMatches.length > 1) {
    return { ok: false, error: "ambiguous", identifier, matches: hashMatches.map((c) => c.hash.slice(0, 8)) };
  }

  const matchedHash = hashMatches[0]?.hash;
  if (!matchedHash) return { ok: false, error: "not-found", identifier };
  const unitForCommit = units.find((u) => u.commits.includes(matchedHash));
  if (!unitForCommit) return { ok: false, error: "not-found", identifier };

  return { ok: true, unit: unitForCommit };
}

export function resolveIdentifiers(
  identifiers: string[],
  units: PRUnit[],
  commits: CommitInfo[],
): { unitIds: Set<string>; errors: IdentifierResolution[] } {
  const unitIds = new Set<string>();
  const errors: IdentifierResolution[] = [];

  for (const id of identifiers) {
    const result = resolveIdentifier(id, units, commits);
    if (result.ok) unitIds.add(result.unit.id);
    else errors.push(result);
  }

  return { unitIds, errors };
}

export function formatResolutionError(error: IdentifierResolution): string {
  if (error.ok) return "";
  switch (error.error) {
    case "not-found":
      return `Error: No commit or group matching '${error.identifier}' found in stack`;
    case "ambiguous":
      return `Error: '${error.identifier}' matches multiple commits. Please provide more characters to disambiguate.\n  Matches: ${error.matches.join(", ")}`;
  }
}

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

  const identifiers = parsed as string[];
  const validationErrors = validateIdentifiers(identifiers);
  if (validationErrors.length > 0) {
    const firstError = validationErrors[0];
    if (firstError && !firstError.ok) throw new Error(firstError.error);
  }

  return identifiers;
}

export function resolveUpTo(
  identifier: string,
  units: PRUnit[],
  commits: CommitInfo[],
): UpToResolution {
  const result = resolveIdentifier(identifier, units, commits);
  if (!result.ok) return { ok: false, error: result };

  const targetUnit = result.unit;
  const unitIds = new Set<string>();

  for (const unit of units) {
    unitIds.add(unit.id);
    if (unit.id === targetUnit.id) break;
  }

  return { ok: true, unitIds };
}
