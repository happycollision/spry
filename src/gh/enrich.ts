import type { SpryContext } from "../lib/context.ts";
import type { SpryConfig } from "../git/config.ts";
import type { PRUnit } from "../parse/types.ts";
import { branchForUnit } from "../git/branch.ts";
import { findPRsForBranches } from "./pr.ts";
import type { PRInfo } from "./pr.ts";
import { GhAuthError, GhNotInstalledError } from "./errors.ts";

export type EnrichmentError = "no-gh" | "auth" | "network" | "no-remote";

export type EnrichedUnit =
  | { unit: PRUnit; pr: PRInfo | null; error?: undefined }
  | { unit: PRUnit; pr: null; error: EnrichmentError };

export async function enrichUnits(
  ctx: SpryContext,
  units: PRUnit[],
  config: SpryConfig,
): Promise<EnrichedUnit[]> {
  if (units.length === 0) return [];

  const branches = units.map((u) => branchForUnit(u, config));

  try {
    const map = await findPRsForBranches(ctx, branches);
    return units.map((unit, i) => {
      const branch = branches[i];
      return {
        unit,
        pr: branch === undefined ? null : (map.get(branch) ?? null),
      };
    });
  } catch (err) {
    const error = classifyEnrichmentError(err);
    return units.map((unit) => ({ unit, pr: null, error }));
  }
}

function classifyEnrichmentError(err: unknown): EnrichmentError {
  if (err instanceof GhNotInstalledError) return "no-gh";
  if (err instanceof GhAuthError) return "auth";
  // Matches gh's stderr when run outside a GitHub repo. The literal phrasing
  // we target is "no GitHub remotes found in the current directory" (emitted
  // by `gh api graphql` when the cwd has no GitHub remote). The
  // case-insensitive match also covers minor punctuation/casing variations
  // and the "not a GitHub repository" wording. If gh ever rewords this
  // stderr we fall through to the `network` branch — the user gets the
  // generic network fallback hint instead of the more specific no-remote
  // hint, which is an acceptable graceful degradation.
  if (err instanceof Error && /no github remotes|not a github/i.test(err.message)) {
    return "no-remote";
  }
  return "network";
}
