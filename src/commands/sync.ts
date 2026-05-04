import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import {
  loadConfig,
  trunkRef,
  getStackCommits,
  injectMissingIds,
  branchForUnit,
} from "../git/index.ts";
import { requireCleanWorkingTree } from "../git/status.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import type { PRUnit } from "../parse/index.ts";
import { formatValidationError } from "../ui/format.ts";
import {
  listRemoteBranches,
  pushBranch,
  findPRsForBranches,
  retargetPR,
  GhAuthError,
  GhNotInstalledError,
} from "../gh/index.ts";
import type { SpryConfig } from "../git/config.ts";

export interface SyncOptions {
  /** undefined = bare; null = boolean --open (TUI); string = comma-separated IDs */
  open?: string | null;
  cwd?: string;
}

export async function syncCommand(ctx: SpryContext, opts: SyncOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });
  await requireCleanWorkingTree(ctx.git, { cwd });

  const ref = trunkRef(config);

  // 1. Inject Spry-Commit-Id trailers; rewrites SHAs (branch names unchanged)
  const inject = await injectMissingIds(ctx.git, ref, { cwd });
  if (!inject.ok) {
    console.error("✗ Cannot sync from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }
  if (inject.modifiedCount > 0) {
    console.log(`✓ Injected ${inject.modifiedCount} commit ID(s)`);
  }

  // 2. Re-read commits + parse stack
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });
  const result = parseStack(withTrailers);
  if (!result.ok) {
    console.error(formatValidationError(result));
    process.exit(1);
  }
  const units = result.units;
  if (units.length === 0) {
    console.log("✓ No commits in stack");
    return;
  }

  // 3. Cheap signal: which branches already exist on the remote?
  const existing = await listRemoteBranches(ctx.git, config.remote, config.branchPrefix, { cwd });

  // 4. Push phase — only branches that already exist remotely
  const pushResult = await pushExistingBranches(ctx, config, units, existing, cwd);

  // 5. (--open handling — added in Tasks 6 and 7)
  if (opts.open !== undefined) {
    throw new Error("--open: not yet implemented (Task 6/7)");
  }

  // 6. Retarget phase — gh required, falls back gracefully
  const retargetHadFailure = await retargetMismatched(ctx, config, units, pushResult.pushed, cwd);

  const hadFailure = pushResult.hadFailure || retargetHadFailure;
  if (hadFailure) {
    console.log("⚠ Sync completed with warnings");
    process.exit(1);
  }
  console.log("✓ Sync complete");
}

async function pushExistingBranches(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  existing: Set<string>,
  cwd: string | undefined,
): Promise<{ pushed: string[]; hadFailure: boolean }> {
  const pushed: string[] = [];
  let hadFailure = false;
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    if (!existing.has(branch)) continue;
    const headHash = unit.commits.at(-1);
    if (!headHash) continue;
    const result = await pushBranch(ctx.git, {
      cwd,
      remote: config.remote,
      sha: headHash,
      branch,
      forceWithLease: true,
    });
    if (result.ok) {
      console.log(`↑ pushed ${branch}`);
      pushed.push(branch);
    } else if (result.reason === "stale-ref") {
      hadFailure = true;
      console.error(`⚠ Skipped ${branch}: remote diverged. Run \`git fetch\` and try again.`);
    } else {
      hadFailure = true;
      console.error(`⚠ Failed to push ${branch}: ${result.stderr.trim()}`);
    }
  }
  return { pushed, hadFailure };
}

function expectedBaseFor(unit: PRUnit, units: PRUnit[], config: SpryConfig): string {
  const idx = units.findIndex((u) => u.id === unit.id);
  if (idx <= 0) return config.trunk;
  const prev = units[idx - 1];
  return prev ? branchForUnit(prev, config) : config.trunk;
}

async function retargetMismatched(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  branches: string[],
  cwd: string | undefined,
): Promise<boolean> {
  if (branches.length === 0) return false;

  let prMap;
  try {
    prMap = await findPRsForBranches(ctx, branches, { cwd });
  } catch (err) {
    // Documented graceful-degradation path: branches were updated; gh just
    // can't retarget. Not counted as a failure.
    const hint = retargetingFallbackHint(err);
    console.log(kleur.dim(`${hint} (branches still updated)`));
    return false;
  }

  let hadFailure = false;
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    const pr = prMap.get(branch);
    if (!pr || pr.state !== "OPEN") continue;
    const expected = expectedBaseFor(unit, units, config);
    if (pr.baseRefName === expected) continue;
    try {
      await retargetPR(ctx, pr.number, expected, { cwd });
      console.log(`↻ retargeted PR #${pr.number} → ${expected}`);
    } catch (err) {
      hadFailure = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠ Could not retarget PR #${pr.number}: ${message}`);
    }
  }
  return hadFailure;
}

function retargetingFallbackHint(err: unknown): string {
  if (err instanceof GhNotInstalledError) {
    return "PR retargeting unavailable: install gh (https://cli.github.com)";
  }
  if (err instanceof GhAuthError) {
    return "PR retargeting unavailable: gh auth login";
  }
  if (err instanceof Error && /no github remotes|not a github/i.test(err.message)) {
    return "PR retargeting unavailable: not a GitHub repository";
  }
  return "PR retargeting unavailable: network error";
}
