import { test, expect, describe } from "bun:test";
import {
  buildShaMap,
  buildSpryMap,
  scanAndReplace,
  SHA_POOL,
  SPRY_ID_POOL,
} from "./sha-scanner.ts";

const SHA_A = "abc1234def5678901234567890abcdef12345678";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";
const SHA_C = "1122334455667788990011223344556677889900";
const SPRY_A = "deadbeef";
const SPRY_B = "cafebabe";

/** Extract a map value, throwing if missing — avoids non-null assertions. */
function get<K, V>(map: Map<K, V>, key: K): V {
  const v = map.get(key);
  if (v === undefined) throw new Error(`sha-scanner test: key not in map: ${String(key)}`);
  return v;
}

describe("buildShaMap", () => {
  test("assigns pool entries in encounter order", () => {
    const map = buildShaMap([SHA_A, SHA_B]);
    // Encounter-order: first SHA maps to pool slot 0, second to slot 1
    expect(get(map, SHA_A)).toBe(SHA_POOL[0]!);
    expect(get(map, SHA_B)).toBe(SHA_POOL[1]!);
    // Both map to entries from the pool
    expect(SHA_POOL).toContain(get(map, SHA_A));
    expect(SHA_POOL).toContain(get(map, SHA_B));
    // Different SHAs get different fakes
    expect(get(map, SHA_A)).not.toBe(get(map, SHA_B));
  });

  test("deduplicates: same SHA seen twice only uses one pool slot", () => {
    const map = buildShaMap([SHA_A, SHA_A]);
    expect(map.size).toBe(1);
    expect(get(map, SHA_A)).toBe(SHA_POOL[0]!);
  });

  test("throws with a clear message when SHA_POOL is exhausted", () => {
    const tooMany = Array.from({ length: SHA_POOL.length + 1 }, (_, i) =>
      String(i).padStart(40, "0"),
    );
    expect(() => buildShaMap(tooMany)).toThrow(/SHA_POOL exhausted/);
    expect(() => buildShaMap(tooMany)).toThrow(/tests\/lib\/sha-scanner\.ts/);
  });
});

describe("buildSpryMap", () => {
  test("assigns pool entries in encounter order", () => {
    const map = buildSpryMap([SPRY_A, SPRY_B]);
    // Encounter-order: first id maps to pool slot 0, second to slot 1
    expect(get(map, SPRY_A)).toBe(SPRY_ID_POOL[0]!);
    expect(get(map, SPRY_B)).toBe(SPRY_ID_POOL[1]!);
    // Both map to entries from the pool
    expect(SPRY_ID_POOL).toContain(get(map, SPRY_A));
    expect(SPRY_ID_POOL).toContain(get(map, SPRY_B));
    // Different ids get different fakes
    expect(get(map, SPRY_A)).not.toBe(get(map, SPRY_B));
  });

  test("throws with a clear message when SPRY_ID_POOL is exhausted", () => {
    const tooMany = Array.from({ length: SPRY_ID_POOL.length + 1 }, (_, i) =>
      i.toString(16).padStart(8, "0"),
    );
    expect(() => buildSpryMap(tooMany)).toThrow(/SPRY_ID_POOL exhausted/);
    expect(() => buildSpryMap(tooMany)).toThrow(/tests\/lib\/sha-scanner\.ts/);
  });
});

// Precompute the fake SHA values that buildShaMap assigns to SHA_A and SHA_B
// using encounter-order assignment (first seen → pool slot 0, etc.).
const FAKE_A = get(buildShaMap([SHA_A]), SHA_A);
const FAKE_B = get(buildShaMap([SHA_B]), SHA_B);
const FAKE_SPRY_A = get(buildSpryMap([SPRY_A]), SPRY_A);

describe("scanAndReplace", () => {
  test("replaces full 40-char SHA", () => {
    const shaMap = buildShaMap([SHA_A]);
    const result = scanAndReplace(`commit ${SHA_A}`, shaMap, new Map());
    expect(result).not.toContain(SHA_A);
    expect(result).toContain("commit ");
    expect(result).toContain(FAKE_A);
  });

  test("replaces 7-char SHA abbreviation", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 7);
    const result = scanAndReplace(`commit ${abbrev}`, shaMap, new Map());
    expect(result).not.toContain(abbrev);
    expect(result).toContain(FAKE_A.slice(0, 7));
  });

  test("replaces 8-char SHA abbreviation with SHA fake (not Spry fake)", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 8);
    const result = scanAndReplace(abbrev, shaMap, new Map());
    expect(result).toBe(FAKE_A.slice(0, 8));
  });

  test("replaces 6-char SHA abbreviation", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 6);
    const result = scanAndReplace(abbrev, shaMap, new Map());
    expect(result).not.toContain(abbrev);
    expect(result).toContain(FAKE_A.slice(0, 6));
  });

  test("replaces 9-char SHA abbreviation", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 9);
    const result = scanAndReplace(abbrev, shaMap, new Map());
    expect(result).toBe(FAKE_A.slice(0, 9));
  });

  test("two SHAs concatenated with no separator — both replaced", () => {
    const shaMap = buildShaMap([SHA_A, SHA_B]);
    const fakeA = shaMap.get(SHA_A)!;
    const fakeB = shaMap.get(SHA_B)!;
    const concat = SHA_A.slice(0, 7) + SHA_B.slice(0, 7);
    const result = scanAndReplace(concat, shaMap, new Map());
    expect(result).not.toContain(SHA_A.slice(0, 7));
    expect(result).not.toContain(SHA_B.slice(0, 7));
    expect(result).toBe(fakeA.slice(0, 7) + fakeB.slice(0, 7));
  });

  test("hex string NOT in registry passes through unchanged", () => {
    const shaMap = buildShaMap([SHA_A]);
    const unregistered = "0000000";
    const result = scanAndReplace(unregistered, shaMap, new Map());
    expect(result).toBe(unregistered);
  });

  test("5-char hex run is too short — passes through unchanged", () => {
    const shaMap = buildShaMap([SHA_A]);
    const result = scanAndReplace("abc12", shaMap, new Map());
    expect(result).toBe("abc12");
  });

  test("replaces Spry-Commit-Id exactly (8 chars)", () => {
    const spryMap = buildSpryMap([SPRY_A]);
    const result = scanAndReplace(`Spry-Commit-Id: ${SPRY_A}`, new Map(), spryMap);
    expect(result).not.toContain(SPRY_A);
    expect(result).toContain(FAKE_SPRY_A);
  });

  test("Spry-Commit-Id adjacent to SHA abbreviation — each replaced from correct pool", () => {
    const shaMap = buildShaMap([SHA_A]);
    const spryMap = buildSpryMap([SPRY_A]);
    const input = `${SHA_A.slice(0, 7)} ${SPRY_A}`;
    const result = scanAndReplace(input, shaMap, spryMap);
    expect(result).not.toContain(SHA_A.slice(0, 7));
    expect(result).not.toContain(SPRY_A);
    expect(result).toContain(FAKE_A.slice(0, 7));
    expect(result).toContain(FAKE_SPRY_A);
  });

  test("SHA abbreviation inside ANSI escape sequence — replaced correctly", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 7);
    const input = `\x1b[33m${abbrev}\x1b[0m`;
    const result = scanAndReplace(input, shaMap, new Map());
    expect(result).not.toContain(abbrev);
    expect(result).toContain("\x1b[33m");
    expect(result).toContain("\x1b[0m");
    expect(result).toContain(FAKE_A.slice(0, 7));
  });

  test("empty maps — content returned unchanged", () => {
    const input = "no shas here, just text";
    const result = scanAndReplace(input, new Map(), new Map());
    expect(result).toBe(input);
  });

  test("non-hex content around SHAs is preserved exactly", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 7);
    const input = `  • ${abbrev} Add feature\n  • ${SHA_B.slice(0, 7)} Fix bug`;
    const result = scanAndReplace(input, shaMap, new Map());
    expect(result).toContain("  • ");
    expect(result).toContain(" Add feature\n");
    expect(result).toContain(SHA_B.slice(0, 7));
    expect(result).not.toContain(abbrev);
  });

  test("same SHA replaced consistently throughout content", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 7);
    const input = `${abbrev} and again ${abbrev}`;
    const result = scanAndReplace(input, shaMap, new Map());
    const fake = FAKE_A.slice(0, 7);
    expect(result).toBe(`${fake} and again ${fake}`);
  });

  test("performance: 50KB of realistic terminal output completes in < 100ms", () => {
    const shaMap = buildShaMap([SHA_A, SHA_B, SHA_C]);
    const spryMap = buildSpryMap([SPRY_A, SPRY_B]);
    const line = `  \x1b[33m${SHA_A.slice(0, 7)}\x1b[0m Add feature (Spry-Commit-Id: ${SPRY_A})\n`;
    const content = line.repeat(1000);
    const start = performance.now();
    const result = scanAndReplace(content, shaMap, spryMap);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).not.toContain(SHA_A.slice(0, 7));
    expect(result).not.toContain(SPRY_A);
  });
});
