import { describe, test, expect } from "bun:test";
import { formatStackView, formatValidationError } from "../../src/ui/format.ts";
import type { PRUnit, StackParseResult } from "../../src/parse/types.ts";

// Strip ANSI escape codes for clean assertions
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatStackView", () => {
  test("returns empty-stack message when no units", () => {
    const output = formatStackView([], "main", 0, "origin/main");
    expect(stripAnsi(output)).toBe("No commits ahead of origin/main");
  });

  test("shows header with branch name and commit count", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "abc12345",
        title: "Add feature",
        commitIds: ["abc12345"],
        commits: ["abc12345678901234567890123456789012345678"],
        subjects: ["Add feature"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feature-branch", 1, "origin/main"));
    expect(output).toContain("Stack: feature-branch (1 commit)");
  });

  test("pluralizes commits correctly", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "a1",
        title: "First",
        commitIds: ["a1"],
        commits: ["aaa"],
        subjects: ["First"],
      },
      {
        type: "single",
        id: "b2",
        title: "Second",
        commitIds: ["b2"],
        commits: ["bbb"],
        subjects: ["Second"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 2, "origin/main"));
    expect(output).toContain("(2 commits)");
  });

  test("shows trunk ref indicator", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "a1",
        title: "Commit",
        commitIds: ["a1"],
        commits: ["aaa"],
        subjects: ["Commit"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 1, "origin/main"));
    expect(output).toContain("→ origin/main");
  });

  test("shows single commit with ID", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "abc12345",
        title: "Add feature",
        commitIds: ["abc12345"],
        commits: ["abc12345678901234567890123456789012345678"],
        subjects: ["Add feature"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 1, "origin/main"));
    expect(output).toContain("○ Add feature (abc12345)");
  });

  test("shows single commit without ID as '(no ID)'", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "abc12345",
        title: "Add feature",
        commitIds: [],
        commits: ["abc12345678901234567890123456789012345678"],
        subjects: ["Add feature"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 1, "origin/main"));
    expect(output).toContain("○ Add feature (no ID)");
  });

  test("shows group with stored title", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: "Auth system",
        commitIds: ["a1", "b2"],
        commits: ["aaa", "bbb"],
        subjects: ["Add middleware", "Add session"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 2, "origin/main"));
    expect(output).toContain("○ Auth system");
    expect(output).toContain("├─ Add middleware (a1)");
    expect(output).toContain("└─ Add session (b2)");
  });

  test("shows group without title as auto-generated letter + commit count", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: undefined,
        commitIds: ["a1", "b2"],
        commits: ["aaa", "bbb"],
        subjects: ["Add middleware", "Add session"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 2, "origin/main"));
    expect(output).toContain("○ A (2 commits)");
  });

  test("auto-generated letters increment across multiple untitled groups", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: undefined,
        commitIds: [],
        commits: ["aaa", "bbb"],
        subjects: ["First", "Second"],
      },
      {
        type: "single",
        id: "c3",
        title: "Middle commit",
        commitIds: ["c3"],
        commits: ["ccc"],
        subjects: ["Middle commit"],
      },
      {
        type: "group",
        id: "grp2",
        title: undefined,
        commitIds: [],
        commits: ["ddd", "eee"],
        subjects: ["Third", "Fourth"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 4, "origin/main"));
    expect(output).toContain("○ A (2 commits)");
    expect(output).toContain("○ B (2 commits)");
  });

  test("titled groups do not consume a letter", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: "Named group",
        commitIds: [],
        commits: ["aaa", "bbb"],
        subjects: ["First", "Second"],
      },
      {
        type: "group",
        id: "grp2",
        title: undefined,
        commitIds: [],
        commits: ["ccc", "ddd"],
        subjects: ["Third", "Fourth"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 4, "origin/main"));
    expect(output).toContain("○ Named group");
    expect(output).toContain("○ A (2 commits)");
  });

  test("shows legend line", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "a1",
        title: "Commit",
        commitIds: ["a1"],
        commits: ["aaa"],
        subjects: ["Commit"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 1, "origin/main"));
    expect(output).toContain("○ no PR");
    expect(output).toContain("◐ open");
    expect(output).toContain("✓ merged");
    expect(output).toContain("✗ closed");
  });

  test("group commit without ID shows (no ID)", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: "Group",
        commitIds: ["a1"],
        commits: ["aaa", "bbb"],
        subjects: ["With ID", "Without ID"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 2, "origin/main"));
    expect(output).toContain("├─ With ID (a1)");
    expect(output).toContain("└─ Without ID (no ID)");
  });
});

describe("formatValidationError", () => {
  test("formats split-group error", () => {
    const result: Exclude<StackParseResult, { ok: true }> = {
      ok: false,
      error: "split-group",
      group: {
        id: "grp12345",
        title: "My Feature",
        commits: ["aaaa", "bbbb"],
      },
      interruptingCommits: ["cccc"],
    };
    const output = formatValidationError(result);
    expect(output).toContain("Split group detected");
    expect(output).toContain("My Feature");
    expect(output).toContain("grp12345");
    expect(output).toContain("1 commit(s) appear between group members");
  });
});
