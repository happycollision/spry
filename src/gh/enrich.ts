import type { SpryContext } from "../lib/context.ts";
import type { SpryConfig } from "../git/config.ts";
import type { PRUnit } from "../parse/types.ts";
import { branchForUnit } from "../git/branch.ts";
import { findPRsForBranches } from "./pr.ts";
import type { PRInfo } from "./pr.ts";
import { classifyGhInfraError } from "./errors.ts";
import type { EnrichmentError } from "./errors.ts";

export type { EnrichmentError } from "./errors.ts";

export type EnrichedUnit =
  | { unit: PRUnit; pr: PRInfo | null; error?: never }
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
    const error = classifyGhInfraError(err);
    return units.map((unit) => ({ unit, pr: null, error }));
  }
}
