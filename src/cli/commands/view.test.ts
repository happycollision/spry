import { test, expect, describe } from "bun:test";
import { formatStackView } from "../output.ts";
import type { EnrichedPRUnit } from "../../types.ts";

describe("cli/commands/view", () => {
  describe("formatStackView", () => {
    test("shows Stack header first, then origin/main indicator", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "single",
          id: "abc12345",
          title: "Add feature",
          commitIds: ["abc12345"],
          commits: ["abc12345678901234567890123456789012345678"],
          subjects: ["Add feature"],
        },
      ];

      const output = await formatStackView(units, "main", 1);
      const lines = output.split("\n");

      expect(lines[0]).toContain("Stack: main");
      expect(lines[1]).toContain("○ no PR"); // Legend line
      expect(lines[3]).toBe("  → origin/main");
    });

    test("shows 'PRs: 0/N opened' when no PRs are open", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "single",
          id: "abc12345",
          title: "First commit",
          commitIds: ["abc12345"],
          commits: ["abc12345678901234567890123456789012345678"],
          subjects: ["First commit"],
        },
        {
          type: "single",
          id: "def67890",
          title: "Second commit",
          commitIds: ["def67890"],
          commits: ["def67890678901234567890123456789012345678"],
          subjects: ["Second commit"],
        },
      ];

      const output = await formatStackView(units, "feature-branch", 2);

      expect(output).toContain("PRs: 0/2 opened");
    });

    test("shows 'PRs: 1/2 opened' when one PR is open", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "single",
          id: "abc12345",
          title: "First commit",
          commitIds: ["abc12345"],
          commits: ["abc12345678901234567890123456789012345678"],
          subjects: ["First commit"],
          pr: { number: 1, url: "https://github.com/org/repo/pull/1", state: "OPEN" },
        },
        {
          type: "single",
          id: "def67890",
          title: "Second commit",
          commitIds: ["def67890"],
          commits: ["def67890678901234567890123456789012345678"],
          subjects: ["Second commit"],
        },
      ];

      const output = await formatStackView(units, "feature-branch", 2);

      expect(output).toContain("PRs: 1/2 opened");
    });

    test("shows 'PRs: 2/2 opened' when all PRs are open", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "single",
          id: "abc12345",
          title: "First commit",
          commitIds: ["abc12345"],
          commits: ["abc12345678901234567890123456789012345678"],
          subjects: ["First commit"],
          pr: { number: 1, url: "https://github.com/org/repo/pull/1", state: "OPEN" },
        },
        {
          type: "single",
          id: "def67890",
          title: "Second commit",
          commitIds: ["def67890"],
          commits: ["def67890678901234567890123456789012345678"],
          subjects: ["Second commit"],
          pr: { number: 2, url: "https://github.com/org/repo/pull/2", state: "OPEN" },
        },
      ];

      const output = await formatStackView(units, "feature-branch", 2);

      expect(output).toContain("PRs: 2/2 opened");
    });

    test("merged PRs do not count as opened", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "single",
          id: "abc12345",
          title: "First commit",
          commitIds: ["abc12345"],
          commits: ["abc12345678901234567890123456789012345678"],
          subjects: ["First commit"],
          pr: { number: 1, url: "https://github.com/org/repo/pull/1", state: "MERGED" },
        },
        {
          type: "single",
          id: "def67890",
          title: "Second commit",
          commitIds: ["def67890"],
          commits: ["def67890678901234567890123456789012345678"],
          subjects: ["Second commit"],
          pr: { number: 2, url: "https://github.com/org/repo/pull/2", state: "OPEN" },
        },
      ];

      const output = await formatStackView(units, "feature-branch", 2);

      expect(output).toContain("PRs: 1/2 opened");
    });

    test("shows '(no ID)' for single commit without ID", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "single",
          id: "abc12345", // This is the hash fallback
          title: "Add feature",
          commitIds: [], // Empty means no real commit ID
          commits: ["abc12345678901234567890123456789012345678"],
          subjects: ["Add feature"],
        },
      ];

      const output = await formatStackView(units, "main", 1);

      expect(output).toContain("(no ID)");
      expect(output).not.toContain("abc12345");
    });

    test("shows commit ID when present", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "single",
          id: "abc12345",
          title: "Add feature",
          commitIds: ["abc12345"],
          commits: ["abc12345678901234567890123456789012345678"],
          subjects: ["Add feature"],
        },
      ];

      const output = await formatStackView(units, "main", 1);

      expect(output).toContain("abc12345");
      expect(output).not.toContain("(no ID)");
    });

    test("shows '(no ID)' for group commits without IDs", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "group",
          id: "group1",
          title: "Feature group",
          commitIds: [], // No commit IDs yet
          commits: ["abc123", "def456"],
          subjects: ["First commit", "Second commit"],
        },
      ];

      const output = await formatStackView(units, "main", 2);

      // Should show (no commit ID yet) for the group header and (no ID) for each commit
      expect(output).toContain("(no commit ID yet)"); // group header
      const noIdMatches = output.match(/\(no ID\)/g);
      expect(noIdMatches?.length).toBe(2); // twice for commits
    });

    test("shows mixed commit IDs in group", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "group",
          id: "group1",
          title: "Feature group",
          commitIds: ["abc12345"], // Only first commit has ID
          commits: ["abc123", "def456"],
          subjects: ["First commit", "Second commit"],
        },
      ];

      const output = await formatStackView(units, "main", 2);

      expect(output).toContain("abc12345");
      expect(output).toContain("(no ID)");
    });

    test("origin/main appears only once after header", async () => {
      const units: EnrichedPRUnit[] = [
        {
          type: "single",
          id: "abc12345",
          title: "Add feature",
          commitIds: ["abc12345"],
          commits: ["abc12345678901234567890123456789012345678"],
          subjects: ["Add feature"],
        },
      ];

      const output = await formatStackView(units, "main", 1);
      const lines = output.split("\n");

      // origin/main should only appear once, after the header and legend
      const originMainLines = lines.filter((l: string) => l.includes("origin/main"));
      expect(originMainLines.length).toBe(1);
      expect(lines[3]).toContain("origin/main");
    });

    test("returns message when no commits", async () => {
      const output = await formatStackView([], "main", 0);

      expect(output).toBe("No commits ahead of origin/main");
    });
  });
});
