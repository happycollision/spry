// tests/parse/title.test.ts
import { test, expect, describe } from "bun:test";
import { resolveUnitTitle, hasStoredTitle } from "../../src/parse/title.ts";
import type { PRUnit } from "../../src/parse/types.ts";

function makeUnit(overrides: Partial<PRUnit> = {}): PRUnit {
  return {
    type: "single",
    id: "abc123",
    title: "Default title",
    commitIds: ["abc123"],
    commits: ["abc123def"],
    subjects: ["Default title"],
    ...overrides,
  };
}

describe("resolveUnitTitle", () => {
  test("returns stored title when available", () => {
    const unit = makeUnit({ type: "group", title: "My Group Title", subjects: ["First", "Second"] });
    expect(resolveUnitTitle(unit)).toBe("My Group Title");
  });

  test("falls back to first subject when title is undefined", () => {
    const unit = makeUnit({ type: "group", title: undefined, subjects: ["First commit", "Second commit"] });
    expect(resolveUnitTitle(unit)).toBe("First commit");
  });

  test("returns Untitled when no title and no subjects", () => {
    const unit = makeUnit({ type: "group", title: undefined, commitIds: [], commits: [], subjects: [] });
    expect(resolveUnitTitle(unit)).toBe("Untitled");
  });

  test("empty string title falls back to first subject", () => {
    const unit = makeUnit({ title: "", subjects: ["Fallback subject"] });
    expect(resolveUnitTitle(unit)).toBe("Fallback subject");
  });
});

describe("hasStoredTitle", () => {
  test("returns true when title is defined", () => {
    expect(hasStoredTitle(makeUnit({ title: "My Title" }))).toBe(true);
  });

  test("returns false when title is undefined", () => {
    expect(hasStoredTitle(makeUnit({ title: undefined }))).toBe(false);
  });

  test("returns true for empty string (explicitly set)", () => {
    expect(hasStoredTitle(makeUnit({ title: "" }))).toBe(true);
  });
});
