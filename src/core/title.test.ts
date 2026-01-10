import { test, expect, describe } from "bun:test";
import { resolveUnitTitle, hasStoredTitle } from "./title.ts";
import type { PRUnit } from "../types.ts";

describe("core/title", () => {
  describe("resolveUnitTitle", () => {
    test("returns stored title when available", () => {
      const unit: PRUnit = {
        type: "group",
        id: "group-123",
        title: "My Group Title",
        commitIds: ["a1", "b2"],
        commits: ["abc", "def"],
        subjects: ["First commit", "Second commit"],
      };

      expect(resolveUnitTitle(unit)).toBe("My Group Title");
    });

    test("falls back to first subject when title is undefined", () => {
      const unit: PRUnit = {
        type: "group",
        id: "group-123",
        title: undefined,
        commitIds: ["a1", "b2"],
        commits: ["abc", "def"],
        subjects: ["First commit", "Second commit"],
      };

      expect(resolveUnitTitle(unit)).toBe("First commit");
    });

    test("returns Untitled when no title and no subjects", () => {
      const unit: PRUnit = {
        type: "group",
        id: "group-123",
        title: undefined,
        commitIds: [],
        commits: [],
        subjects: [],
      };

      expect(resolveUnitTitle(unit)).toBe("Untitled");
    });

    test("works with single commit units", () => {
      const unit: PRUnit = {
        type: "single",
        id: "abc123",
        title: "Add feature X",
        commitIds: ["abc123"],
        commits: ["abc123def"],
        subjects: ["Add feature X"],
      };

      expect(resolveUnitTitle(unit)).toBe("Add feature X");
    });

    test("empty string title is treated as falsy", () => {
      const unit: PRUnit = {
        type: "group",
        id: "group-123",
        title: "",
        commitIds: ["a1"],
        commits: ["abc"],
        subjects: ["Fallback subject"],
      };

      // Empty string is falsy, so we fall back
      expect(resolveUnitTitle(unit)).toBe("Fallback subject");
    });
  });

  describe("hasStoredTitle", () => {
    test("returns true when title is defined", () => {
      const unit: PRUnit = {
        type: "group",
        id: "group-123",
        title: "My Group Title",
        commitIds: [],
        commits: [],
        subjects: [],
      };

      expect(hasStoredTitle(unit)).toBe(true);
    });

    test("returns false when title is undefined", () => {
      const unit: PRUnit = {
        type: "group",
        id: "group-123",
        title: undefined,
        commitIds: [],
        commits: [],
        subjects: [],
      };

      expect(hasStoredTitle(unit)).toBe(false);
    });

    test("returns true for empty string (explicit empty title)", () => {
      const unit: PRUnit = {
        type: "group",
        id: "group-123",
        title: "",
        commitIds: [],
        commits: [],
        subjects: [],
      };

      // Empty string is still a "stored" title - user explicitly set it
      // This is intentional - hasStoredTitle checks storage, not validity
      expect(hasStoredTitle(unit)).toBe(true);
    });

    test("single units always have stored title", () => {
      const unit: PRUnit = {
        type: "single",
        id: "abc123",
        title: "Add feature",
        commitIds: ["abc123"],
        commits: ["abc123def"],
        subjects: ["Add feature"],
      };

      expect(hasStoredTitle(unit)).toBe(true);
    });
  });
});
