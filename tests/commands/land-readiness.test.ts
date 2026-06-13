import { describe, test, expect } from "bun:test";
import { evaluateReadiness } from "../../src/commands/land-readiness.ts";
import type { PRInfo } from "../../src/gh/pr.ts";

function pr(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 1,
    url: "https://github.com/o/r/pull/1",
    state: "OPEN",
    title: "T",
    baseRefName: "main",
    checksStatus: "none",
    reviewDecision: "none",
    reviewThreads: { resolved: 0, total: 0 },
    ...overrides,
  };
}

describe("evaluateReadiness", () => {
  test("none checks / none review / no threads → ok, no blockers", () => {
    const res = evaluateReadiness([{ branch: "b", pr: pr() }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verdict.blockers).toHaveLength(0);
      expect(res.verdict.unresolvedThreadPRs).toHaveLength(0);
    }
  });

  test("missing PR → not ok, lists branch", () => {
    const res = evaluateReadiness([{ branch: "b", pr: null }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing).toEqual(["b"]);
  });

  test("non-OPEN PR counts as missing", () => {
    const res = evaluateReadiness([{ branch: "b", pr: pr({ state: "CLOSED" }) }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing).toEqual(["b"]);
  });

  test("failing checks → blocker", () => {
    const res = evaluateReadiness([{ branch: "b", pr: pr({ checksStatus: "failing" }) }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verdict.blockers).toHaveLength(1);
      expect(res.verdict.blockers[0]?.reasons.join(" ")).toMatch(/failing/i);
    }
  });

  test("pending checks → blocker", () => {
    const res = evaluateReadiness([{ branch: "b", pr: pr({ checksStatus: "pending" }) }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verdict.blockers[0]?.reasons.join(" ")).toMatch(/still running/i);
    }
  });

  test("changes_requested → blocker", () => {
    const res = evaluateReadiness([
      { branch: "b", pr: pr({ reviewDecision: "changes_requested" }) },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verdict.blockers[0]?.reasons.join(" ")).toMatch(/changes/i);
  });

  test("review_required → blocker", () => {
    const res = evaluateReadiness([{ branch: "b", pr: pr({ reviewDecision: "review_required" }) }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verdict.blockers[0]?.reasons.join(" ")).toMatch(/review is required/i);
  });

  test("approved review + passing checks → no blocker", () => {
    const res = evaluateReadiness([
      { branch: "b", pr: pr({ reviewDecision: "approved", checksStatus: "passing" }) },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verdict.blockers).toHaveLength(0);
  });

  test("unresolved threads → not a blocker, surfaces in unresolvedThreadPRs", () => {
    const res = evaluateReadiness([
      { branch: "b", pr: pr({ number: 7, reviewThreads: { resolved: 1, total: 3 } }) },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verdict.blockers).toHaveLength(0);
      expect(res.verdict.unresolvedThreadPRs).toEqual([7]);
    }
  });
});
