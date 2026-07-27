// tests/parse/identifier.test.ts
import { test, expect, describe } from "bun:test";
import {
  resolveIdentifier,
  resolveIdentifiers,
  formatResolutionError,
  parseApplySpec,
  resolveUpTo,
  remapRewrittenShas,
} from "../../src/parse/identifier.ts";
import type { PRUnit, CommitInfo } from "../../src/parse/types.ts";

function makeCommit(hash: string, subject: string, spryId?: string): CommitInfo {
  return {
    hash,
    subject,
    body: "",
    trailers: spryId ? { "Spry-Commit-Id": spryId } : {},
  };
}

function makeSingle(id: string, commits: string[]): PRUnit {
  return {
    type: "single",
    id,
    title: `Commit ${id}`,
    commitIds: [id],
    commits,
    subjects: [`Commit ${id}`],
  };
}

function makeGroup(id: string, commits: string[], commitIds: string[]): PRUnit {
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
    makeSingle("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
    makeSingle("def67890", ["bbb222333444555666777888999000aaabbbcccddd"]),
    makeSingle("ghi11111", ["ccc333444555666777888999000aaabbbcccdddeee"]),
  ];

  test("resolves exact Spry-Commit-Id", () => {
    const result = resolveIdentifier("abc12345", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("abc12345");
  });

  test("resolves Spry-Commit-Id prefix", () => {
    const result = resolveIdentifier("abc", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("abc12345");
  });

  test("resolves full git hash", () => {
    const result = resolveIdentifier("aaa111222333444555666777888999000aaabbbccc", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("abc12345");
  });

  test("resolves short git hash", () => {
    const result = resolveIdentifier("aaa1112", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("abc12345");
  });

  test("returns not-found for unknown identifier", () => {
    const result = resolveIdentifier("xyz99999", units, commits);
    expect(result).toMatchObject({ ok: false, error: "not-found", identifier: "xyz99999" });
  });

  test("returns ambiguous when multiple unit IDs match prefix", () => {
    const similarUnits = [
      makeSingle("test1234", ["aaa111222333444555666777888999000aaabbbccc"]),
      makeSingle("test5678", ["bbb222333444555666777888999000aaabbbcccddd"]),
    ];
    const result = resolveIdentifier("test", similarUnits, commits);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === "ambiguous") {
      expect(result.matches).toContain("test1234");
      expect(result.matches).toContain("test5678");
    }
  });

  test("resolves group ID", () => {
    const groupUnits = [
      makeGroup(
        "grp00001",
        [
          "aaa111222333444555666777888999000aaabbbccc",
          "bbb222333444555666777888999000aaabbbcccddd",
        ],
        ["abc12345", "def67890"],
      ),
    ];
    const result = resolveIdentifier("grp00001", groupUnits, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.type).toBe("group");
  });

  test("resolves commit hash to containing group", () => {
    const groupUnits = [
      makeGroup(
        "grp00001",
        [
          "aaa111222333444555666777888999000aaabbbccc",
          "bbb222333444555666777888999000aaabbbcccddd",
        ],
        ["abc12345", "def67890"],
      ),
    ];
    const result = resolveIdentifier("bbb2223", groupUnits, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("grp00001");
  });
});

describe("resolveIdentifiers", () => {
  const commits = [
    makeCommit("aaa111222333444555666777888999000aaabbbccc", "First", "abc12345"),
    makeCommit("bbb222333444555666777888999000aaabbbcccddd", "Second", "def67890"),
  ];
  const units = [
    makeSingle("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
    makeSingle("def67890", ["bbb222333444555666777888999000aaabbbcccddd"]),
  ];

  test("resolves multiple identifiers", () => {
    const result = resolveIdentifiers(["abc12345", "def67890"], units, commits);
    expect(result.errors).toHaveLength(0);
    expect(result.unitIds.has("abc12345")).toBe(true);
    expect(result.unitIds.has("def67890")).toBe(true);
  });

  test("deduplicates same unit matched via different identifiers", () => {
    const result = resolveIdentifiers(["abc12345", "aaa1112"], units, commits);
    expect(result.unitIds.size).toBe(1);
  });

  test("collects errors for unresolvable identifiers", () => {
    const result = resolveIdentifiers(["abc12345", "invalid"], units, commits);
    expect(result.errors).toHaveLength(1);
    expect(result.unitIds.size).toBe(1);
  });
});

describe("formatResolutionError", () => {
  test("formats not-found error", () => {
    const msg = formatResolutionError({ ok: false, error: "not-found", identifier: "xyz" });
    expect(msg).toContain("xyz");
    expect(msg).toContain("found in stack");
  });

  test("formats ambiguous error", () => {
    const msg = formatResolutionError({
      ok: false,
      error: "ambiguous",
      identifier: "abc",
      matches: ["abc123", "abc456"],
    });
    expect(msg).toContain("matches multiple");
  });
});

describe("parseApplySpec", () => {
  test("parses valid JSON array", () => {
    expect(parseApplySpec('["abc123", "def456"]')).toEqual(["abc123", "def456"]);
  });

  test("parses empty array", () => {
    expect(parseApplySpec("[]")).toEqual([]);
  });

  test("throws on invalid JSON", () => {
    expect(() => parseApplySpec("not json")).toThrow("Invalid --apply format");
  });

  test("throws on non-array", () => {
    expect(() => parseApplySpec('{"key": "value"}')).toThrow("Invalid --apply format");
  });

  test("throws on array with non-strings", () => {
    expect(() => parseApplySpec('[123, "abc"]')).toThrow("All items must be strings");
  });
});

describe("resolveUpTo", () => {
  const commits = [
    makeCommit("aaa111222333444555666777888999000aaabbbccc", "First", "abc12345"),
    makeCommit("bbb222333444555666777888999000aaabbbcccddd", "Second", "def67890"),
    makeCommit("ccc333444555666777888999000aaabbbcccdddeee", "Third", "ghi11111"),
  ];
  const units = [
    makeSingle("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
    makeSingle("def67890", ["bbb222333444555666777888999000aaabbbcccddd"]),
    makeSingle("ghi11111", ["ccc333444555666777888999000aaabbbcccdddeee"]),
  ];

  test("returns only first unit when specifying first", () => {
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
    if (result.ok) expect(result.unitIds.size).toBe(2);
  });

  test("returns all units when specifying last", () => {
    const result = resolveUpTo("ghi11111", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unitIds.size).toBe(3);
  });

  test("returns error for unknown identifier", () => {
    const result = resolveUpTo("unknown", units, commits);
    expect(result.ok).toBe(false);
  });

  test("works with git hash prefix", () => {
    const result = resolveUpTo("bbb2223", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unitIds.has("def67890")).toBe(true);
  });
});

describe("remapRewrittenShas", () => {
  // sp sync injects Spry-Commit-Id trailers BEFORE resolving --open ids, which
  // rewrites the SHA of every commit that lacked an id. A SHA the user passed to
  // --open (captured before that rewrite) then no longer exists in the stack, so
  // resolveIdentifier silently misses it. remapRewrittenShas translates such a
  // SHA to the post-injection SHA of the same logical commit (same stack index),
  // so the user's intent survives the rug-pull. (spry-3zqb)

  // Pre-injection stack: two commits, neither has an id yet.
  const oldHashes = ["aaaaaaaaaaaa1111", "bbbbbbbbbbbb2222"];
  // Post-injection: both were rewritten (trailer added) → fresh SHAs, same order.
  const newHashes = ["cccccccccccc3333", "dddddddddddd4444"];

  test("remaps a full pre-injection SHA to its post-injection SHA", () => {
    expect(remapRewrittenShas(["aaaaaaaaaaaa1111"], oldHashes, newHashes)).toEqual([
      "cccccccccccc3333",
    ]);
  });

  test("remaps a pre-injection SHA prefix to the full post-injection SHA", () => {
    expect(remapRewrittenShas(["bbbbbbb"], oldHashes, newHashes)).toEqual(["dddddddddddd4444"]);
  });

  test("leaves a token that still matches a surviving commit untouched", () => {
    // Only the second commit was rewritten; the first kept its SHA.
    const survived = remapRewrittenShas(["aaaaaaa"], oldHashes, [
      "aaaaaaaaaaaa1111",
      "dddddddddddd4444",
    ]);
    expect(survived).toEqual(["aaaaaaa"]);
  });

  test("leaves spry ids and non-SHA tokens untouched", () => {
    expect(remapRewrittenShas(["6746c292", "not-a-sha"], oldHashes, newHashes)).toEqual([
      "6746c292",
      "not-a-sha",
    ]);
  });

  test("does not remap an ambiguous prefix that matches multiple old hashes", () => {
    // A prefix matching >1 pre-injection commit has no single target — leave it
    // for resolveIdentifier to report as ambiguous rather than guess.
    const ambiguousOld = ["ff0011", "ff0022"];
    expect(remapRewrittenShas(["ff00"], ambiguousOld, ["1234", "5678"])).toEqual(["ff00"]);
  });

  test("is a no-op when nothing was rewritten (old === new)", () => {
    expect(remapRewrittenShas(["aaaaaaa", "bbbbbbb"], oldHashes, oldHashes)).toEqual([
      "aaaaaaa",
      "bbbbbbb",
    ]);
  });
});
