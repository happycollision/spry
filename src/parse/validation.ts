// src/parse/validation.ts
import type { ValidationResult } from "./types.ts";

export function validateBranchName(name: string): ValidationResult {
  if (!name || name.length === 0) {
    return { ok: false, error: "Branch name cannot be empty" };
  }

  if (name.length > 255) {
    return { ok: false, error: `Branch name too long (${name.length} chars). Maximum is 255 characters.` };
  }

  if (name.includes(" ")) {
    return { ok: false, error: "Branch name cannot contain spaces" };
  }

  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 32 || code === 127) {
      return { ok: false, error: `Branch name cannot contain control characters (found at position ${i})` };
    }
  }

  const forbidden = ["~", "^", ":", "?", "*", "[", "\\", "..", "@{"];
  for (const char of forbidden) {
    if (name.includes(char)) {
      return { ok: false, error: `Branch name cannot contain '${char}'` };
    }
  }

  if (name.startsWith("/")) return { ok: false, error: "Branch name cannot start with '/'" };
  if (name.endsWith("/")) return { ok: false, error: "Branch name cannot end with '/'" };
  if (name.endsWith(".lock")) return { ok: false, error: "Branch name cannot end with '.lock'" };
  if (name.includes("//")) return { ok: false, error: "Branch name cannot contain consecutive slashes '//'" };

  return { ok: true };
}

export function validatePRTitle(title: string): ValidationResult {
  if (!title || title.trim().length === 0) {
    return {
      ok: false,
      error: "PR title cannot be empty. Use 'sp group' to set a title, or pass --allow-untitled-pr to use the first commit subject.",
    };
  }

  const trimmed = title.trim();

  if (trimmed.length > 500) {
    return { ok: false, error: `PR title too long (${trimmed.length} chars). Maximum is 500 characters.` };
  }

  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if ((code < 32 && code !== 10 && code !== 13) || code === 127) {
      return { ok: false, error: `PR title cannot contain control characters (found at position ${i})` };
    }
  }

  return { ok: true };
}

export function validateIdentifierFormat(identifier: string): ValidationResult {
  if (!identifier || identifier.length === 0) {
    return { ok: false, error: "Identifier cannot be empty" };
  }

  if (identifier.length > 100) {
    return { ok: false, error: `Identifier too long (${identifier.length} chars). Maximum is 100 characters.` };
  }

  if (/^[0-9a-f]{4,40}$/.test(identifier)) return { ok: true };
  if (/^[\w-]+-[0-9a-f]{4,}$/.test(identifier)) return { ok: true };

  return {
    ok: false,
    error: `Invalid identifier format: '${identifier}'. Expected hex string (4-40 chars) or group ID (name-hexsuffix).`,
  };
}

export function validateIdentifiers(identifiers: string[]): ValidationResult[] {
  const errors: ValidationResult[] = [];
  for (const id of identifiers) {
    const result = validateIdentifierFormat(id);
    if (!result.ok) errors.push(result);
  }
  return errors;
}
