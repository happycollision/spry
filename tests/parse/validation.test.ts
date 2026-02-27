// tests/parse/validation.test.ts
import { describe, test, expect } from "bun:test";
import {
  validateBranchName,
  validatePRTitle,
  validateIdentifierFormat,
  validateIdentifiers,
} from "../../src/parse/validation.ts";

describe("validateBranchName", () => {
  test("accepts valid branch names", () => {
    expect(validateBranchName("feature/my-branch")).toEqual({ ok: true });
    expect(validateBranchName("spry/username/a1b2c3d4")).toEqual({ ok: true });
    expect(validateBranchName("bugfix/issue-123")).toEqual({ ok: true });
    expect(validateBranchName("main")).toEqual({ ok: true });
    expect(validateBranchName("v1.0.0")).toEqual({ ok: true });
  });

  test("rejects empty branch name", () => {
    const result = validateBranchName("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot be empty");
  });

  test("rejects branch names with spaces", () => {
    const result = validateBranchName("my branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot contain spaces");
  });

  test("rejects branch names with control characters", () => {
    const result = validateBranchName("branch\x00name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("control characters");
  });

  test("rejects branch names with forbidden characters", () => {
    for (const char of ["~", "^", ":", "?", "*", "[", "\\", "..", "@{"]) {
      const result = validateBranchName(`branch${char}name`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`cannot contain '${char}'`);
    }
  });

  test("rejects branch names starting with slash", () => {
    const result = validateBranchName("/feature/branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot start with '/'");
  });

  test("rejects branch names ending with slash", () => {
    const result = validateBranchName("feature/branch/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot end with '/'");
  });

  test("rejects branch names ending with .lock", () => {
    const result = validateBranchName("branch.lock");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot end with '.lock'");
  });

  test("rejects branch names with consecutive slashes", () => {
    const result = validateBranchName("feature//branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("consecutive slashes");
  });

  test("rejects branch names exceeding 255 characters", () => {
    const result = validateBranchName("a".repeat(256));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("too long");
      expect(result.error).toContain("256");
    }
  });
});

describe("validatePRTitle", () => {
  test("accepts valid PR titles", () => {
    expect(validatePRTitle("Add new feature")).toEqual({ ok: true });
    expect(validatePRTitle("Fix bug in authentication")).toEqual({ ok: true });
    expect(validatePRTitle("Title with: special (chars) #123")).toEqual({ ok: true });
    expect(validatePRTitle("Title with\nnewlines\nis okay")).toEqual({ ok: true });
  });

  test("rejects empty PR titles", () => {
    const result = validatePRTitle("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cannot be empty");
      expect(result.error).toContain("sp group");
    }
  });

  test("rejects whitespace-only PR titles", () => {
    const result = validatePRTitle("   \t  ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot be empty");
  });

  test("rejects PR titles with control characters", () => {
    const result = validatePRTitle("Title with \x00 null");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("control characters");
  });

  test("rejects PR titles exceeding 500 characters", () => {
    const result = validatePRTitle("a".repeat(501));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("too long");
      expect(result.error).toContain("501");
    }
  });
});

describe("validateIdentifierFormat", () => {
  test("accepts valid hex identifiers", () => {
    expect(validateIdentifierFormat("a1b2c3d4")).toEqual({ ok: true });
    expect(validateIdentifierFormat("abc123")).toEqual({ ok: true });
    expect(validateIdentifierFormat("deadbeef")).toEqual({ ok: true });
  });

  test("accepts valid group IDs", () => {
    expect(validateIdentifierFormat("group-a1b2c3d4")).toEqual({ ok: true });
    expect(validateIdentifierFormat("my-group-abc123")).toEqual({ ok: true });
  });

  test("rejects empty identifiers", () => {
    const result = validateIdentifierFormat("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot be empty");
  });

  test("rejects identifiers that are too short", () => {
    const result = validateIdentifierFormat("abc");
    expect(result.ok).toBe(false);
  });

  test("rejects identifiers exceeding 100 characters", () => {
    const result = validateIdentifierFormat("a".repeat(101));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("too long");
  });

  test("rejects uppercase hex", () => {
    const result = validateIdentifierFormat("DEADBEEF");
    expect(result.ok).toBe(false);
  });

  test("rejects group IDs without hex suffix", () => {
    const result = validateIdentifierFormat("group-name");
    expect(result.ok).toBe(false);
  });
});

describe("validateIdentifiers", () => {
  test("returns empty array for all valid identifiers", () => {
    expect(validateIdentifiers(["abc123", "deadbeef"])).toEqual([]);
  });

  test("returns errors for invalid identifiers", () => {
    const errors = validateIdentifiers(["abc123", "NOT@VALID", "xyz"]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("handles empty array", () => {
    expect(validateIdentifiers([])).toEqual([]);
  });
});
