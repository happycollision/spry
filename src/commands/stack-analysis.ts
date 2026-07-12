import type { GitRunner } from "../lib/context.ts";
import type { SpryConfig } from "../git/config.ts";
import { branchForUnit } from "../git/branch.ts";
import type { PRUnit, CommitWithTrailers } from "../parse/index.ts";
import type { PRCache } from "../gh/pr-cache.ts";

/** Per-unit comparison of the local stack against ref-backed remote truth. */
export interface UnitAnalysis {
  unit: PRUnit;
  branch: string;
  /** The unit lacks a Spry-Commit-Id on one or more of its commits. */
  missingId: boolean;
  /** Local tip !== origin/<branch> (unresolved origin ref counts as unpushed). */
  unpushed: boolean;
  /** Cached PR base !== expectedBaseFor(unit) (false when no cached PR). */
  misTargeted: boolean;
  /** The unit's cached PR base, or undefined if no cached PR. */
  currentBase: string | undefined;
  /** What the base should be for a correctly-stacked PR. */
  expectedBase: string;
}

export interface StackAnalysis {
  units: UnitAnalysis[];
}

export interface AnalyzeStackInput {
  units: PRUnit[];
  /** All commits in the stack, with trailers — used for the missing-ID scan. */
  commits: CommitWithTrailers[];
  /** The (already-fetched) PR cache, keyed by unit id. */
  prCache: PRCache;
  config: SpryConfig;
}

export interface AnalyzeStackOptions {
  cwd?: string;
}

/** The previous unit's branch, or trunk for the bottom unit (or when the unit is not in `units`). */
export function expectedBaseFor(unit: PRUnit, units: PRUnit[], config: SpryConfig): string {
  const idx = units.findIndex((u) => u.id === unit.id);
  if (idx <= 0) return config.trunk;
  const prev = units[idx - 1];
  return prev ? branchForUnit(prev, config) : config.trunk;
}

/**
 * Which commits lack a Spry-Commit-Id. Pure over already-parsed trailers — the
 * single source of "which commits need an id", shared with the inject path.
 */
export function missingIdHashes(commits: CommitWithTrailers[]): string[] {
  return commits.filter((c) => !c.trailers["Spry-Commit-Id"]).map((c) => c.hash);
}

async function originSha(
  git: GitRunner,
  branch: string,
  cwd: string | undefined,
): Promise<string | null> {
  const res = await git.run(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
    cwd,
  });
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return sha.length > 0 ? sha : null;
}

export async function analyzeStack(
  // ctx is narrowed to { git } — this module is pure/read-only and never calls gh.
  ctx: { git: GitRunner },
  input: AnalyzeStackInput,
  opts: AnalyzeStackOptions = {},
): Promise<StackAnalysis> {
  const { units, commits, prCache, config } = input;
  const cwd = opts.cwd;
  const missing = new Set(missingIdHashes(commits));

  const analyzed: UnitAnalysis[] = [];
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    const localTip = unit.commits.at(-1);
    const remoteTip = await originSha(ctx.git, branch, cwd);
    const unpushed = !localTip || remoteTip === null || remoteTip !== localTip;

    const missingId = unit.commits.some((sha) => missing.has(sha));

    const cached = prCache[unit.id];
    const currentBase = cached?.baseRefName;
    const expectedBase = expectedBaseFor(unit, units, config);
    const misTargeted = cached !== undefined && cached.baseRefName !== expectedBase;

    analyzed.push({ unit, branch, missingId, unpushed, misTargeted, currentBase, expectedBase });
  }
  return { units: analyzed };
}
