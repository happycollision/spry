import { describe, test, expect } from "bun:test";
import {
  PRNotFastForwardError,
  PRNotFoundError,
  PRNotReadyError,
  determineChecksStatus,
  type CheckRollupItem,
} from "./pr.ts";

describe("github/pr", () => {
  describe("determineChecksStatus", () => {
    test("returns 'none' when checks array is null", () => {
      expect(determineChecksStatus(null)).toBe("none");
    });

    test("returns 'none' when checks array is empty", () => {
      expect(determineChecksStatus([])).toBe("none");
    });

    test("returns 'passing' when all checks are completed successfully", () => {
      const checks: CheckRollupItem[] = [
        { status: "COMPLETED", conclusion: "SUCCESS", state: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SUCCESS", state: "SUCCESS" },
      ];
      expect(determineChecksStatus(checks)).toBe("passing");
    });

    test("returns 'failing' when any check has FAILURE conclusion", () => {
      const checks: CheckRollupItem[] = [
        { status: "COMPLETED", conclusion: "SUCCESS", state: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE", state: "FAILURE" },
      ];
      expect(determineChecksStatus(checks)).toBe("failing");
    });

    test("returns 'failing' when any check has ERROR conclusion", () => {
      const checks: CheckRollupItem[] = [
        { status: "COMPLETED", conclusion: "SUCCESS", state: "SUCCESS" },
        { status: "COMPLETED", conclusion: "ERROR", state: "ERROR" },
      ];
      expect(determineChecksStatus(checks)).toBe("failing");
    });

    test("returns 'failing' when any check has FAILURE state", () => {
      const checks: CheckRollupItem[] = [
        { status: "COMPLETED", conclusion: "SUCCESS", state: "SUCCESS" },
        { status: "COMPLETED", conclusion: null, state: "FAILURE" },
      ];
      expect(determineChecksStatus(checks)).toBe("failing");
    });

    test("returns 'pending' when checks are still running", () => {
      const checks: CheckRollupItem[] = [
        { status: "COMPLETED", conclusion: "SUCCESS", state: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: null, state: "PENDING" },
      ];
      expect(determineChecksStatus(checks)).toBe("pending");
    });

    test("returns 'pending' when some checks are queued", () => {
      const checks: CheckRollupItem[] = [{ status: "QUEUED", conclusion: null, state: "PENDING" }];
      expect(determineChecksStatus(checks)).toBe("pending");
    });

    test("prioritizes failure over pending", () => {
      const checks: CheckRollupItem[] = [
        { status: "IN_PROGRESS", conclusion: null, state: "PENDING" },
        { status: "COMPLETED", conclusion: "FAILURE", state: "FAILURE" },
      ];
      expect(determineChecksStatus(checks)).toBe("failing");
    });
  });

  describe("PRNotFastForwardError", () => {
    test("includes PR number and reason in message", () => {
      const error = new PRNotFastForwardError(123, "main is not an ancestor");
      expect(error.message).toBe("PR #123 cannot be fast-forwarded: main is not an ancestor");
      expect(error.prNumber).toBe(123);
      expect(error.reason).toBe("main is not an ancestor");
      expect(error.name).toBe("PRNotFastForwardError");
    });
  });

  describe("PRNotFoundError", () => {
    test("includes PR number in message", () => {
      const error = new PRNotFoundError(456);
      expect(error.message).toBe("PR #456 not found");
      expect(error.prNumber).toBe(456);
      expect(error.name).toBe("PRNotFoundError");
    });
  });

  describe("PRNotReadyError", () => {
    test("includes PR number and reasons", () => {
      const error = new PRNotReadyError(789, ["CI checks are failing", "Review is required"]);
      expect(error.message).toBe("PR #789 is not ready to land");
      expect(error.prNumber).toBe(789);
      expect(error.reasons).toEqual(["CI checks are failing", "Review is required"]);
      expect(error.name).toBe("PRNotReadyError");
    });
  });
});
