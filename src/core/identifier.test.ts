import { test, expect, describe } from "bun:test";
import {
  resolveIdentifier,
  resolveIdentifiers,
  formatResolutionError,
  parseApplySpec,
  resolveUpTo,
} from "./identifier.ts";
import type { PRUnit, CommitInfo } from "../types.ts";

// Helper to create test commits
function makeCommit(hash: string, subject: string, spryId?: string): CommitInfo {
  return {
    hash,
    subject,
    body: "",
    trailers: spryId ? { "Spry-Commit-Id": spryId } : {},
  };
}

// Helper to create test units
function makeSingleUnit(id: string, commits: string[]): PRUnit {
  return {
    type: "single",
    id,
    title: `Commit ${id}`,
    commitIds: [id],
    commits,
    subjects: [`Commit ${id}`],
  };
}

function makeGroupUnit(id: string, commits: string[], commitIds: string[]): PRUnit {
  return {
    type: "group",
    id,
    title: `Group ${id}`,
    commitIds,
    commits,
    subjects: commits.map((_, i) => `Commit ${i + 1}`),
  };
}

describe("resolveIdentifier", () => {
  const commits: CommitInfo[] = [
    makeCommit("aaa111222333444555666777888999000aaabbbccc", "First", "abc12345"),
    makeCommit("bbb222333444555666777888999000aaabbbcccddd", "Second", "def67890"),
    makeCommit("ccc333444555666777888999000aaabbbcccdddeee", "Third", "ghi11111"),
  ];

  const units: PRUnit[] = [
    makeSingleUnit("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
    makeSingleUnit("def67890", ["bbb222333444555666777888999000aaabbbcccddd"]),
    makeSingleUnit("ghi11111", ["ccc333444555666777888999000aaabbbcccdddeee"]),
  ];

  test("resolves exact Spry-Commit-Id", () => {
    const result = resolveIdentifier("abc12345", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unit.id).toBe("abc12345");
    }
  });

  test("resolves Spry-Commit-Id prefix", () => {
    const result = resolveIdentifier("abc", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unit.id).toBe("abc12345");
    }
  });

  test("resolves full git hash", () => {
    const result = resolveIdentifier("aaa111222333444555666777888999000aaabbbccc", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unit.id).toBe("abc12345");
    }
  });

  test("resolves short git hash (7 chars)", () => {
    const result = resolveIdentifier("aaa1112", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unit.id).toBe("abc12345");
    }
  });

  test("returns not-found for unknown identifier", () => {
    const result = resolveIdentifier("xyz99999", units, commits);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("not-found");
      expect(result.identifier).toBe("xyz99999");
    }
  });

  test("returns ambiguous when multiple unit IDs match prefix", () => {
    // Create units with similar prefixes
    const similarUnits: PRUnit[] = [
      makeSingleUnit("test1234", ["aaa111222333444555666777888999000aaabbbccc"]),
      makeSingleUnit("test5678", ["bbb222333444555666777888999000aaabbbcccddd"]),
    ];

    const result = resolveIdentifier("test", similarUnits, commits);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === "ambiguous") {
      expect(result.matches).toContain("test1234");
      expect(result.matches).toContain("test5678");
    }
  });

  test("resolves group ID", () => {
    const groupUnits: PRUnit[] = [
      makeGroupUnit(
        "grp00001",
        [
          "aaa111222333444555666777888999000aaabbbccc",
          "bbb222333444555666777888999000aaabbbcccddd",
        ],
        ["abc12345", "def67890"],
      ),
      makeSingleUnit("ghi11111", ["ccc333444555666777888999000aaabbbcccdddeee"]),
    ];

    const result = resolveIdentifier("grp00001", groupUnits, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unit.id).toBe("grp00001");
      expect(result.unit.type).toBe("group");
    }
  });

  test("resolves commit hash to its containing group", () => {
    const groupUnits: PRUnit[] = [
      makeGroupUnit(
        "grp00001",
        [
          "aaa111222333444555666777888999000aaabbbccc",
          "bbb222333444555666777888999000aaabbbcccddd",
        ],
        ["abc12345", "def67890"],
      ),
    ];

    // Resolve by second commit's hash
    const result = resolveIdentifier("bbb2223", groupUnits, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unit.id).toBe("grp00001");
    }
  });
});

describe("resolveIdentifiers", () => {
  const commits: CommitInfo[] = [
    makeCommit("aaa111222333444555666777888999000aaabbbccc", "First", "abc12345"),
    makeCommit("bbb222333444555666777888999000aaabbbcccddd", "Second", "def67890"),
  ];

  const units: PRUnit[] = [
    makeSingleUnit("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
    makeSingleUnit("def67890", ["bbb222333444555666777888999000aaabbbcccddd"]),
  ];

  test("resolves multiple identifiers", () => {
    const result = resolveIdentifiers(["abc12345", "def67890"], units, commits);
    expect(result.errors).toHaveLength(0);
    expect(result.unitIds.has("abc12345")).toBe(true);
    expect(result.unitIds.has("def67890")).toBe(true);
  });

  test("deduplicates when same unit matched multiple times", () => {
    // Both the Spry-Commit-Id and the commit hash resolve to the same unit
    const result = resolveIdentifiers(["abc12345", "aaa1112"], units, commits);
    expect(result.errors).toHaveLength(0);
    expect(result.unitIds.size).toBe(1);
    expect(result.unitIds.has("abc12345")).toBe(true);
  });

  test("collects errors for invalid identifiers", () => {
    const result = resolveIdentifiers(["abc12345", "invalid", "def67890"], units, commits);
    expect(result.errors).toHaveLength(1);
    expect(result.unitIds.size).toBe(2);
    if (!result.errors[0]?.ok) {
      expect(result.errors[0]?.identifier).toBe("invalid");
    }
  });
});

describe("formatResolutionError", () => {
  test("formats not-found error", () => {
    const error = formatResolutionError({
      ok: false,
      error: "not-found",
      identifier: "xyz99999",
    });
    expect(error).toContain("xyz99999");
    expect(error).toContain("found in stack");
  });

  test("formats ambiguous error", () => {
    const error = formatResolutionError({
      ok: false,
      error: "ambiguous",
      identifier: "abc",
      matches: ["abc12345", "abc67890"],
    });
    expect(error).toContain("abc");
    expect(error).toContain("matches multiple");
    expect(error).toContain("abc12345");
    expect(error).toContain("abc67890");
  });
});

describe("parseApplySpec", () => {
  test("parses valid JSON array", () => {
    const result = parseApplySpec('["abc123", "def456"]');
    expect(result).toEqual(["abc123", "def456"]);
  });

  test("parses empty array", () => {
    const result = parseApplySpec("[]");
    expect(result).toEqual([]);
  });

  test("throws on invalid JSON", () => {
    expect(() => parseApplySpec("not json")).toThrow("Invalid --apply format");
  });

  test("throws on non-array JSON", () => {
    expect(() => parseApplySpec('{"key": "value"}')).toThrow("Invalid --apply format");
  });

  test("throws on array with non-strings", () => {
    expect(() => parseApplySpec('[123, "abc"]')).toThrow("All items must be strings");
  });
});

describe("resolveUpTo", () => {
  const commits: CommitInfo[] = [
    makeCommit("aaa111222333444555666777888999000aaabbbccc", "First", "abc12345"),
    makeCommit("bbb222333444555666777888999000aaabbbcccddd", "Second", "def67890"),
    makeCommit("ccc333444555666777888999000aaabbbcccdddeee", "Third", "ghi11111"),
  ];

  const units: PRUnit[] = [
    makeSingleUnit("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
    makeSingleUnit("def67890", ["bbb222333444555666777888999000aaabbbcccddd"]),
    makeSingleUnit("ghi11111", ["ccc333444555666777888999000aaabbbcccdddeee"]),
  ];

  test("returns first unit when specifying first", () => {
    const result = resolveUpTo("abc12345", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unitIds.size).toBe(1);
      expect(result.unitIds.has("abc12345")).toBe(true);
    }
  });

  test("returns first two units when specifying second", () => {
    const result = resolveUpTo("def67890", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unitIds.size).toBe(2);
      expect(result.unitIds.has("abc12345")).toBe(true);
      expect(result.unitIds.has("def67890")).toBe(true);
    }
  });

  test("returns all units when specifying last", () => {
    const result = resolveUpTo("ghi11111", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unitIds.size).toBe(3);
      expect(result.unitIds.has("abc12345")).toBe(true);
      expect(result.unitIds.has("def67890")).toBe(true);
      expect(result.unitIds.has("ghi11111")).toBe(true);
    }
  });

  test("returns error for unknown identifier", () => {
    const result = resolveUpTo("unknown", units, commits);
    expect(result.ok).toBe(false);
    if (!result.ok && !result.error.ok) {
      expect(result.error.error).toBe("not-found");
    }
  });

  test("works with git hash prefix", () => {
    const result = resolveUpTo("bbb2223", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unitIds.size).toBe(2);
      expect(result.unitIds.has("def67890")).toBe(true);
    }
  });

  test("resolves commit within a group to the whole group", () => {
    const groupUnits: PRUnit[] = [
      makeSingleUnit("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
      makeGroupUnit(
        "grp00001",
        [
          "bbb222333444555666777888999000aaabbbcccddd",
          "ccc333444555666777888999000aaabbbcccdddeee",
        ],
        ["def67890", "ghi11111"],
      ),
    ];

    // Resolve by second commit in the group
    const result = resolveUpTo("ccc3334", groupUnits, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unitIds.size).toBe(2);
      expect(result.unitIds.has("abc12345")).toBe(true);
      expect(result.unitIds.has("grp00001")).toBe(true);
    }
  });
});
