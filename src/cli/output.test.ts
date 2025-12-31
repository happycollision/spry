import { describe, test, expect } from "bun:test";
import { formatBlockingIndicators, formatAllPRsView } from "./output.ts";
import type { PRStatus } from "../types.ts";
import type { UserPR } from "./commands/view.ts";

describe("cli/output", () => {
  describe("formatBlockingIndicators", () => {
    test("returns empty string when all green", () => {
      const status: PRStatus = {
        checks: "passing",
        review: "approved",
        comments: { total: 0, resolved: 0 },
      };
      expect(formatBlockingIndicators(status)).toBe("");
    });

    test("returns empty string when no checks configured and no review required", () => {
      const status: PRStatus = {
        checks: "none",
        review: "none",
        comments: { total: 0, resolved: 0 },
      };
      expect(formatBlockingIndicators(status)).toBe("");
    });

    test("shows unresolved comments", () => {
      const status: PRStatus = {
        checks: "passing",
        review: "approved",
        comments: { total: 5, resolved: 3 },
      };
      expect(formatBlockingIndicators(status)).toBe("💬 3/5");
    });

    test("hides comments when all resolved", () => {
      const status: PRStatus = {
        checks: "passing",
        review: "approved",
        comments: { total: 5, resolved: 5 },
      };
      expect(formatBlockingIndicators(status)).toBe("");
    });

    test("shows pending checks", () => {
      const status: PRStatus = {
        checks: "pending",
        review: "approved",
        comments: { total: 0, resolved: 0 },
      };
      expect(formatBlockingIndicators(status)).toBe("⏳ checks");
    });

    test("shows failing checks", () => {
      const status: PRStatus = {
        checks: "failing",
        review: "approved",
        comments: { total: 0, resolved: 0 },
      };
      expect(formatBlockingIndicators(status)).toBe("❌ checks");
    });

    test("shows review required", () => {
      const status: PRStatus = {
        checks: "passing",
        review: "review_required",
        comments: { total: 0, resolved: 0 },
      };
      expect(formatBlockingIndicators(status)).toBe("👀 review");
    });

    test("shows changes requested", () => {
      const status: PRStatus = {
        checks: "passing",
        review: "changes_requested",
        comments: { total: 0, resolved: 0 },
      };
      expect(formatBlockingIndicators(status)).toBe("❌ review");
    });

    test("shows multiple indicators with proper spacing", () => {
      const status: PRStatus = {
        checks: "pending",
        review: "review_required",
        comments: { total: 5, resolved: 3 },
      };
      expect(formatBlockingIndicators(status)).toBe("💬 3/5  ⏳ checks  👀 review");
    });

    test("shows all failing indicators", () => {
      const status: PRStatus = {
        checks: "failing",
        review: "changes_requested",
        comments: { total: 2, resolved: 0 },
      };
      expect(formatBlockingIndicators(status)).toBe("💬 0/2  ❌ checks  ❌ review");
    });
  });

  describe("formatAllPRsView", () => {
    test("shows message when no PRs found", () => {
      const result = formatAllPRsView([], "testuser");
      expect(result).toContain("All PRs by testuser");
      expect(result).toContain("No PRs found");
    });

    test("groups PRs by state", () => {
      const prs: UserPR[] = [
        {
          number: 1,
          title: "Open PR",
          state: "OPEN",
          headRefName: "branch-1",
          url: "https://github.com/test/repo/pull/1",
        },
        {
          number: 2,
          title: "Merged PR",
          state: "MERGED",
          headRefName: "branch-2",
          url: "https://github.com/test/repo/pull/2",
        },
        {
          number: 3,
          title: "Closed PR",
          state: "CLOSED",
          headRefName: "branch-3",
          url: "https://github.com/test/repo/pull/3",
        },
      ];
      const result = formatAllPRsView(prs, "testuser");

      expect(result).toContain("All PRs by testuser");
      expect(result).toContain("Open (1)");
      expect(result).toContain("◐ #1 Open PR");
      expect(result).toContain("Merged (1)");
      expect(result).toContain("✓ #2 Merged PR");
      expect(result).toContain("Closed (1)");
      expect(result).toContain("✗ #3 Closed PR");
    });

    test("shows URLs for each PR", () => {
      const prs: UserPR[] = [
        {
          number: 42,
          title: "Test PR",
          state: "OPEN",
          headRefName: "test-branch",
          url: "https://github.com/owner/repo/pull/42",
        },
      ];
      const result = formatAllPRsView(prs, "testuser");
      expect(result).toContain("https://github.com/owner/repo/pull/42");
    });

    test("omits empty sections", () => {
      const prs: UserPR[] = [
        {
          number: 1,
          title: "Open PR",
          state: "OPEN",
          headRefName: "branch-1",
          url: "https://github.com/test/repo/pull/1",
        },
      ];
      const result = formatAllPRsView(prs, "testuser");

      expect(result).toContain("Open (1)");
      expect(result).not.toContain("Merged");
      expect(result).not.toContain("Closed");
    });
  });
});
