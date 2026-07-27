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
    return {
      ok: false,
      error: "ambiguous",
      identifier,
      matches: hashMatches.map((c) => c.hash.slice(0, 8)),
    };
  }

  const matchedHash = hashMatches[0]?.hash;
  if (!matchedHash) return { ok: false, error: "not-found", identifier };
  const unitForCommit = units.find((u) => u.commits.includes(matchedHash));
  if (!unitForCommit) return { ok: false, error: "not-found", identifier };

  return { ok: true, unit: unitForCommit };
}

/**
 * Translate `--open` identifiers that pointed at a commit whose SHA was just
 * rewritten by `sp sync`'s `injectMissingIds` pass (which adds a
 * `Spry-Commit-Id` trailer to every id-less commit, minting a fresh SHA).
 *
 * `sp sync` injects ids *before* it resolves the user's `--open` targets, so a
 * SHA the user typed — captured against the pre-injection stack — no longer
 * exists afterward and would silently miss. `oldHashes`/`newHashes` are the
 * stack's commit SHAs before and after injection, in stack order (same length,
 * index `i` = the same logical commit). Any identifier that is a unique prefix
 * of a *rewritten* old hash (`old[i] !== new[i]`) and is not already a prefix of
 * some surviving new hash is rewritten to the full `new[i]`; everything else —
 * spry ids, non-SHA tokens, SHAs of commits that were not rewritten, and
 * ambiguous prefixes — passes through untouched for {@link resolveIdentifier} to
 * handle. Pure and order-preserving.
 */
export function remapRewrittenShas(
  identifiers: string[],
  oldHashes: string[],
  newHashes: string[],
): string[] {
  const isHexPrefix = (s: string) => s.length > 0 && /^[0-9a-f]+$/.test(s);

  return identifiers.map((id) => {
    if (!isHexPrefix(id)) return id;
    // Still resolvable against a surviving commit → leave it alone.
    if (newHashes.some((h) => h.startsWith(id))) return id;

    // Find the rewritten old commits this prefix matches. A prefix that matches
    // more than one has no single target — leave it for resolveIdentifier to
    // report as ambiguous rather than guess.
    const matchedIndexes: number[] = [];
    for (let i = 0; i < oldHashes.length; i++) {
      const oldHash = oldHashes[i];
      const newHash = newHashes[i];
      if (oldHash === undefined || newHash === undefined) continue;
      if (oldHash === newHash) continue; // commit was not rewritten
      if (oldHash.startsWith(id)) matchedIndexes.push(i);
    }
    if (matchedIndexes.length !== 1) return id;

    const idx = matchedIndexes[0];
    return idx === undefined ? id : (newHashes[idx] ?? id);
  });
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
