import type { PRInfo } from "../gh/pr.ts";

export interface ReadinessVerdict {
  blockers: { branch: string; prNumber: number; reasons: string[] }[];
  /** PR numbers that have unresolved review threads (prompt, not abort). */
  unresolvedThreadPRs: number[];
}

export type ReadinessResult =
  | { ok: true; verdict: ReadinessVerdict }
  | { ok: false; missing: string[] };

/**
 * Evaluate land-readiness for a scope of PRs.
 *
 * - Any branch with no open PR is a hard miss (`ok: false`) — you can't land
 *   through an unpublished unit.
 * - Failing/pending checks and changes-requested/review-required are blockers.
 * - Unresolved review threads are advisory (surfaced for a confirm prompt).
 * - `checksStatus: "none"` and `reviewDecision: "none"` are NOT blockers.
 */
export function evaluateReadiness(scope: { branch: string; pr: PRInfo | null }[]): ReadinessResult {
  const missing = scope.filter((s) => !s.pr || s.pr.state !== "OPEN").map((s) => s.branch);
  if (missing.length > 0) return { ok: false, missing };

  const blockers: ReadinessVerdict["blockers"] = [];
  const unresolvedThreadPRs: number[] = [];
  for (const { branch, pr } of scope) {
    if (!pr) continue;
    const reasons: string[] = [];
    if (pr.checksStatus === "failing") reasons.push("CI checks are failing");
    else if (pr.checksStatus === "pending") reasons.push("CI checks are still running");
    if (pr.reviewDecision === "changes_requested") reasons.push("Changes have been requested");
    else if (pr.reviewDecision === "review_required") reasons.push("Review is required");
    if (reasons.length > 0) blockers.push({ branch, prNumber: pr.number, reasons });
    if (pr.reviewThreads.total > pr.reviewThreads.resolved) unresolvedThreadPRs.push(pr.number);
  }
  return { ok: true, verdict: { blockers, unresolvedThreadPRs } };
}
