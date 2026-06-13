import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef, getStackCommits, branchForUnit } from "../git/index.ts";
import {
  fetchGroupRecords,
  loadGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
} from "../git/group-titles.ts";
import { fetchPRCache } from "../gh/pr-cache.ts";
import {
  parseCommitTrailers,
  parseStack,
  resolveUpTo,
  formatResolutionError,
} from "../parse/index.ts";
import type { PRUnit } from "../parse/index.ts";
import { formatValidationError } from "../ui/format.ts";
import { findPRsForBranches, retargetPR, pushBranch } from "../gh/index.ts";
import { syncCommand } from "./sync.ts";

export interface LandOptions {
  through?: string;
  cwd?: string;
  /** Injected for testability; default to a real TUI in later tasks. */
  confirm?: (message: string) => Promise<boolean>;
  pickThrough?: (units: PRUnit[]) => Promise<string | null>;
}

export async function landCommand(ctx: SpryContext, opts: LandOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });

  // 1. Full sync first (publish + refresh). syncCommand process.exits on failure.
  await syncCommand(ctx, { cwd });

  // 2. Parse the stack (group-aware), same machinery as sync.
  await fetchGroupRecords(ctx.git, config.remote, { cwd });
  await fetchPRCache(ctx.git, config.remote, { cwd });
  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);

  const ref = trunkRef(config);
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });
  const parsed = parseStack(withTrailers, groupTitles, commitGroups);
  if (!parsed.ok) {
    console.error(formatValidationError(parsed));
    process.exit(1);
  }
  const units = parsed.units;
  if (units.length === 0) {
    console.log("✓ No commits in stack");
    return;
  }

  // 3. Resolve the "through" id (or pick it via TUI — later task).
  let throughId = opts.through;
  if (throughId === undefined) {
    const picker = opts.pickThrough ?? defaultPickThrough;
    const picked = await picker(units);
    if (picked === null) {
      console.log("Cancelled.");
      return;
    }
    throughId = picked;
  }

  const scope = resolveUpTo(throughId, units, withTrailers);
  if (!scope.ok) {
    console.error(formatResolutionError(scope.error));
    process.exit(1);
  }
  const scopeUnits = units.filter((u) => scope.unitIds.has(u.id));
  const target = scopeUnits.at(-1);
  const tip = target?.commits.at(-1);
  if (!target || !tip) {
    console.log("✓ Nothing to land");
    return;
  }

  // 4. Live PR status for the scope.
  const scopeBranches = scopeUnits.map((u) => branchForUnit(u, config));
  const prMap = await findPRsForBranches(ctx, scopeBranches, { cwd });

  // 5. Retarget every scope PR to trunk BEFORE the push (the secret sauce).
  for (const unit of scopeUnits) {
    const branch = branchForUnit(unit, config);
    const pr = prMap.get(branch);
    if (!pr || pr.state !== "OPEN") continue;
    if (pr.baseRefName === config.trunk) continue;
    try {
      await retargetPR(ctx, pr.number, config.trunk, { cwd });
      console.log(`↻ retargeted PR #${pr.number} → ${config.trunk}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`✗ Could not retarget PR #${pr.number}: ${message}`);
      process.exit(1); // never ff with an un-retargeted middle PR
    }
  }

  // 6. One ff push to the target tip.
  const result = await pushBranch(ctx.git, {
    cwd,
    remote: config.remote,
    sha: tip,
    branch: config.trunk,
    forceWithLease: false,
  });
  if (!result.ok) {
    if (result.reason === "stale-ref") {
      console.error(`✗ ${config.trunk} is ahead of your stack. Run \`sp rebase\` and try again.`);
    } else {
      console.error(`✗ Could not land: ${result.stderr.trim()}`);
    }
    process.exit(1);
  }

  const n = scopeUnits.length;
  console.log(`✓ Landed ${n} PR${n === 1 ? "" : "s"} to ${config.trunk}`);
  if (units.length > scopeUnits.length) {
    console.log(kleur.dim("  Run `sp sync` to retarget the remaining PRs, then `sp clean`."));
  }
}

// Placeholder until the no-arg picker task wires up a real TUI.
async function defaultPickThrough(_units: PRUnit[]): Promise<string | null> {
  throw new Error("interactive picker not yet implemented");
}
