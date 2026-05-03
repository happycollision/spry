import { describe, test, expect } from "bun:test";
import { formatStackView, formatValidationError } from "../../src/ui/format.ts";
import type { PRUnit, StackParseResult } from "../../src/parse/types.ts";
import type { EnrichedUnit, EnrichmentError } from "../../src/gh/enrich.ts";
import type { ChecksStatus, PRInfo, ReviewDecision } from "../../src/gh/pr.ts";

// Strip ANSI escape codes for clean assertions
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function asEnriched(units: PRUnit[]): EnrichedUnit[] {
  return units.map((unit) => ({ unit, pr: null }));
}

function withPR(unit: PRUnit, pr: PRInfo): EnrichedUnit {
  return { unit, pr };
}

function withError(unit: PRUnit, error: EnrichmentError): EnrichedUnit {
  return { unit, pr: null, error };
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 123,
    url: "https://github.com/owner/repo/pull/123",
    state: "OPEN",
    title: "T",
    baseRefName: "main",
    checksStatus: "passing",
    reviewDecision: "approved",
    reviewThreads: { resolved: 2, total: 3 },
    ...overrides,
  };
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
    const output = stripAnsi(
      formatStackView(asEnriched(units), "feature-branch", 1, "origin/main"),
    );
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 2, "origin/main"));
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 1, "origin/main"));
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 1, "origin/main"));
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 1, "origin/main"));
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 2, "origin/main"));
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 2, "origin/main"));
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 4, "origin/main"));
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 4, "origin/main"));
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 1, "origin/main"));
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
    const output = stripAnsi(formatStackView(asEnriched(units), "feat", 2, "origin/main"));
    expect(output).toContain("├─ With ID (a1)");
    expect(output).toContain("└─ Without ID (no ID)");
  });

  test("renders two lines for unit with open PR", () => {
    const unit: PRUnit = {
      type: "single",
      id: "a1b2c3d4",
      title: "Add login page",
      commitIds: ["a1b2c3d4"],
      commits: ["aaa"],
      subjects: ["Add login page"],
    };
    const output = stripAnsi(
      formatStackView([withPR(unit, makePR({ state: "OPEN" }))], "feat", 1, "origin/main"),
    );

    expect(output).toContain("◐ Add login page (a1b2c3d4)");
    expect(output).toContain("https://github.com/owner/repo/pull/123");
    expect(output).toContain("checks:✓");
    expect(output).toContain("approval:✓");
    expect(output).toContain("comments:2/3");
  });

  test("uses ✓ for merged PR", () => {
    const unit: PRUnit = {
      type: "single",
      id: "a1",
      title: "Done",
      commitIds: ["a1"],
      commits: ["aaa"],
      subjects: ["Done"],
    };
    const output = stripAnsi(
      formatStackView([withPR(unit, makePR({ state: "MERGED" }))], "feat", 1, "origin/main"),
    );
    expect(output).toContain("✓ Done");
  });

  test("uses ✗ for closed PR", () => {
    const unit: PRUnit = {
      type: "single",
      id: "a1",
      title: "Abandoned",
      commitIds: ["a1"],
      commits: ["aaa"],
      subjects: ["Abandoned"],
    };
    const output = stripAnsi(
      formatStackView([withPR(unit, makePR({ state: "CLOSED" }))], "feat", 1, "origin/main"),
    );
    expect(output).toContain("✗ Abandoned");
  });

  test("uses ○ and one-line layout for unit without PR", () => {
    const unit: PRUnit = {
      type: "single",
      id: "a1b2c3d4",
      title: "Pending",
      commitIds: ["a1b2c3d4"],
      commits: ["aaa"],
      subjects: ["Pending"],
    };
    const output = stripAnsi(formatStackView([{ unit, pr: null }], "feat", 1, "origin/main"));
    expect(output).toContain("○ Pending (a1b2c3d4)");
    expect(output).not.toContain("https://");
    expect(output).not.toContain("checks:");
  });

  test("renders em-dash for none values in checks/approval", () => {
    const unit: PRUnit = {
      type: "single",
      id: "a1",
      title: "T",
      commitIds: ["a1"],
      commits: ["aaa"],
      subjects: ["T"],
    };
    const output = stripAnsi(
      formatStackView(
        [
          withPR(
            unit,
            makePR({
              checksStatus: "none",
              reviewDecision: "none",
              reviewThreads: { resolved: 0, total: 0 },
            }),
          ),
        ],
        "feat",
        1,
        "origin/main",
      ),
    );
    expect(output).toContain("checks:—");
    expect(output).toContain("approval:—");
    expect(output).toContain("comments:0/0");
  });

  test("renders extended legend when any unit has a PR", () => {
    const unit: PRUnit = {
      type: "single",
      id: "a1",
      title: "T",
      commitIds: ["a1"],
      commits: ["aaa"],
      subjects: ["T"],
    };
    const output = stripAnsi(formatStackView([withPR(unit, makePR())], "feat", 1, "origin/main"));
    expect(output).toContain("checks: ✓ pass");
    expect(output).toContain("approval: ✓ approved");
  });

  test("shows fallback hint when all units share the same enrichment error", () => {
    const unit: PRUnit = {
      type: "single",
      id: "a1",
      title: "T",
      commitIds: ["a1"],
      commits: ["aaa"],
      subjects: ["T"],
    };
    const output = stripAnsi(formatStackView([withError(unit, "auth")], "feat", 1, "origin/main"));
    expect(output).toContain("PR status unavailable: gh auth login");
    expect(output).toContain("○ T");
    expect(output).not.toContain("https://");
  });

  test("fallback hint varies by error class", () => {
    const unit: PRUnit = {
      type: "single",
      id: "a1",
      title: "T",
      commitIds: ["a1"],
      commits: ["aaa"],
      subjects: ["T"],
    };

    expect(
      stripAnsi(formatStackView([withError(unit, "no-gh")], "feat", 1, "origin/main")),
    ).toContain("install gh");

    expect(
      stripAnsi(formatStackView([withError(unit, "no-remote")], "feat", 1, "origin/main")),
    ).toContain("not a GitHub repository");

    expect(
      stripAnsi(formatStackView([withError(unit, "network")], "feat", 1, "origin/main")),
    ).toContain("network error");
  });

  test("group with PR renders state icon + URL line then tree", () => {
    const unit: PRUnit = {
      type: "group",
      id: "grp1",
      title: "Auth system",
      commitIds: ["a1", "b2"],
      commits: ["aaa", "bbb"],
      subjects: ["Add middleware", "Add session"],
    };
    const output = stripAnsi(
      formatStackView([withPR(unit, makePR({ state: "OPEN" }))], "feat", 2, "origin/main"),
    );
    expect(output).toContain("◐ Auth system");
    expect(output).toContain("https://github.com/owner/repo/pull/123");
    expect(output).toContain("├─ Add middleware (a1)");
    expect(output).toContain("└─ Add session (b2)");
  });

  const checksCases: Array<[ChecksStatus, string]> = [
    ["failing", "✗"],
    ["pending", "⏳"],
  ];

  test.each(checksCases)("renders checks glyph for status=%s", (status, glyph) => {
    const unit: PRUnit = {
      type: "single",
      id: "a1",
      title: "T",
      commitIds: ["a1"],
      commits: ["aaa"],
      subjects: ["T"],
    };
    const output = stripAnsi(
      formatStackView([withPR(unit, makePR({ checksStatus: status }))], "feat", 1, "origin/main"),
    );
    expect(output).toContain(`checks:${glyph}`);
  });

  const approvalCases: Array<[ReviewDecision, string]> = [
    ["changes_requested", "✗"],
    ["review_required", "?"],
  ];

  test.each(approvalCases)("renders approval glyph for decision=%s", (decision, glyph) => {
    const unit: PRUnit = {
      type: "single",
      id: "a1",
      title: "T",
      commitIds: ["a1"],
      commits: ["aaa"],
      subjects: ["T"],
    };
    const output = stripAnsi(
      formatStackView(
        [withPR(unit, makePR({ reviewDecision: decision }))],
        "feat",
        1,
        "origin/main",
      ),
    );
    expect(output).toContain(`approval:${glyph}`);
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
