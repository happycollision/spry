/**
 * Input validation utilities for branch names, PR titles, and identifiers.
 *
 * These validators fail fast with clear, actionable error messages before
 * inputs reach git/GitHub APIs where errors are less helpful.
 */

/**
 * Validation result type.
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a git branch name against git's branch naming rules.
 *
 * Git branch name restrictions:
 * - Cannot contain spaces
 * - Cannot contain ASCII control characters (< 32)
 * - Cannot contain: ~ ^ : ? * [ \ .. @{
 * - Cannot start or end with /
 * - Cannot end with .lock
 * - Cannot contain consecutive slashes //
 * - Cannot contain @{
 *
 * @see https://git-scm.com/docs/git-check-ref-format
 */
export function validateBranchName(name: string): ValidationResult {
  if (!name || name.length === 0) {
    return {
      ok: false,
      error: "Branch name cannot be empty",
    };
  }

  if (name.length > 255) {
    return {
      ok: false,
      error: `Branch name too long (${name.length} chars). Maximum is 255 characters.`,
    };
  }

  // Check for spaces
  if (name.includes(" ")) {
    return {
      ok: false,
      error: "Branch name cannot contain spaces",
    };
  }

  // Check for ASCII control characters
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 32 || code === 127) {
      return {
        ok: false,
        error: `Branch name cannot contain control characters (found at position ${i})`,
      };
    }
  }

  // Check for forbidden characters and patterns
  const forbidden = ["~", "^", ":", "?", "*", "[", "\\", "..", "@{"];
  for (const char of forbidden) {
    if (name.includes(char)) {
      return {
        ok: false,
        error: `Branch name cannot contain '${char}'`,
      };
    }
  }

  // Check for leading/trailing slashes
  if (name.startsWith("/")) {
    return {
      ok: false,
      error: "Branch name cannot start with '/'",
    };
  }

  if (name.endsWith("/")) {
    return {
      ok: false,
      error: "Branch name cannot end with '/'",
    };
  }

  // Check for .lock suffix
  if (name.endsWith(".lock")) {
    return {
      ok: false,
      error: "Branch name cannot end with '.lock'",
    };
  }

  // Check for consecutive slashes
  if (name.includes("//")) {
    return {
      ok: false,
      error: "Branch name cannot contain consecutive slashes '//'",
    };
  }

  return { ok: true };
}

/**
 * Validate a PR title before submitting to GitHub API.
 *
 * This should only be called when actually creating a PR (sync --open).
 * Groups can remain untitled until PR creation time.
 *
 * Requirements:
 * - Non-empty (or caller should use fallback like first commit subject)
 * - No control characters (except newlines)
 * - Reasonable length (1-500 chars)
 */
export function validatePRTitle(title: string): ValidationResult {
  if (!title || title.trim().length === 0) {
    return {
      ok: false,
      error: "PR title cannot be empty. Use 'sp group' to set a title, or pass --allow-untitled-pr to use the first commit subject.",
    };
  }

  const trimmed = title.trim();

  if (trimmed.length > 500) {
    return {
      ok: false,
      error: `PR title too long (${trimmed.length} chars). Maximum is 500 characters.`,
    };
  }

  // Check for control characters (except newlines which GitHub allows)
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    // Allow \n (10) and \r (13), forbid other control chars
    if ((code < 32 && code !== 10 && code !== 13) || code === 127) {
      return {
        ok: false,
        error: `PR title cannot contain control characters (found at position ${i})`,
      };
    }
  }

  return { ok: true };
}

/**
 * Validate a commit identifier format (for user-provided identifiers).
 *
 * Valid formats:
 * - Hex string (git hash or spry commit ID): 4-40 chars of [0-9a-f]
 * - Group ID with hex suffix: alphanumeric with dashes, ending in hex
 *
 * This is a format check only - resolution (checking if it exists) happens
 * later in resolveIdentifier().
 */
export function validateIdentifierFormat(identifier: string): ValidationResult {
  if (!identifier || identifier.length === 0) {
    return {
      ok: false,
      error: "Identifier cannot be empty",
    };
  }

  if (identifier.length > 100) {
    return {
      ok: false,
      error: `Identifier too long (${identifier.length} chars). Maximum is 100 characters.`,
    };
  }

  // Allow hex strings (commit hashes, spry IDs): 4-40 chars
  const hexPattern = /^[0-9a-f]{4,40}$/;
  if (hexPattern.test(identifier)) {
    return { ok: true };
  }

  // Allow group IDs: word chars, dashes, must end with hex (e.g., "group-a1b2c3d4")
  const groupPattern = /^[\w-]+-[0-9a-f]{4,}$/;
  if (groupPattern.test(identifier)) {
    return { ok: true };
  }

  return {
    ok: false,
    error: `Invalid identifier format: '${identifier}'. Expected hex string (4-40 chars) or group ID (name-hexsuffix).`,
  };
}

/**
 * Validate multiple identifiers and return all errors.
 */
export function validateIdentifiers(identifiers: string[]): ValidationResult[] {
  const errors: ValidationResult[] = [];

  for (const id of identifiers) {
    const result = validateIdentifierFormat(id);
    if (!result.ok) {
      errors.push(result);
    }
  }

  return errors;
}
