import type { PRUnit } from "../types.ts";

/**
 * Resolve the display title for a PRUnit.
 *
 * For singles: always returns the commit subject (stored as title)
 * For groups: returns stored title, or falls back to first commit subject
 *
 * This is the ONLY place fallback logic should exist - all display code
 * should import and use this function for consistency.
 */
export function resolveUnitTitle(unit: PRUnit): string {
  if (unit.title) return unit.title;
  return unit.subjects[0] ?? "Untitled";
}

/**
 * Check if a PRUnit has a stored title.
 *
 * For singles: always true (title is set from commit subject)
 * For groups: true only if title was saved to ref storage
 *
 * Use this to validate that groups have been properly named before
 * creating PRs - we want to fail fast rather than silently using fallbacks.
 */
export function hasStoredTitle(unit: PRUnit): boolean {
  return unit.title !== undefined;
}
