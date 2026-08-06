import { CI_PENDING_REASON } from "./land-readiness.ts";
import type { LandBlockersResult, UnitBlockers } from "./stack-analysis.ts";

export { CI_PENDING_REASON };

export type ScopeVerdict =
  | { kind: "ready" }
  | { kind: "ci-pending"; prNumbers: number[] }
  | { kind: "hard"; perUnit: UnitBlockers[] };

/** True iff this unit's ONLY blocking reason is that CI is still running. */
function ciPendingIsSoleReason(u: UnitBlockers): boolean {
  return u.reasons.length === 1 && u.reasons[0] === CI_PENDING_REASON;
}

/**
 * Fold `landBlockers` output into a three-way verdict. `ci-pending` is returned
 * ONLY when every blocked unit's sole reason is CI-still-running — a mixed state
 * (CI pending alongside any other reason, or a different reason on a sibling
 * unit) is `hard`, because polling cannot clear it. `prByBranch` supplies the PR
 * numbers surfaced for the ci-pending banner/nudge.
 */
export function classifyScope(
  blockers: LandBlockersResult,
  prByBranch: Map<string, { number: number } | null>,
): ScopeVerdict {
  if (!blockers.blocked) return { kind: "ready" };
  if (blockers.perUnit.every(ciPendingIsSoleReason)) {
    const prNumbers = blockers.perUnit
      .map((u) => prByBranch.get(u.branch)?.number)
      // A CI-pending unit is expected to have an open PR; the type guard is
      // invariant-drift armor, silently dropping a branch missing from the
      // map rather than crashing or fabricating a number.
      .filter((n): n is number => typeof n === "number");
    return { kind: "ci-pending", prNumbers };
  }
  return { kind: "hard", perUnit: blockers.perUnit };
}

/**
 * The copy/paste command a non-interactive bare-land prints so the user can
 * re-invoke with polling. `throughId` is the resolved scope's top unit id
 * (or the explicit --through the user passed), so the printed command
 * reproduces exactly this land.
 */
export function renderReinvokeHint(throughId: string): string {
  return `Run \`sp land --through ${throughId} --poll\` to wait for CI and land automatically.`;
}
