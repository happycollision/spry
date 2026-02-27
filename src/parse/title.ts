// src/parse/title.ts
import type { PRUnit } from "./types.ts";

export function resolveUnitTitle(unit: PRUnit): string {
  if (unit.title) return unit.title;
  return unit.subjects[0] ?? "Untitled";
}

export function hasStoredTitle(unit: PRUnit): boolean {
  return unit.title !== undefined;
}
