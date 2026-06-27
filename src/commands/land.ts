import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef, getStackCommits, branchForUnit } from "../git/index.ts";
import type { SpryConfig } from "../git/index.ts";
import type { GroupRecords } from "../parse/index.ts";
import {
  fetchGroupRecords,
  loadGroupRecords,
  saveAllGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
} from "../git/group-titles.ts";
import {
  fetchPRCache,
  loadPRCache,
  savePRCache,
  pushPRCache,
  deletePRCacheRemote,
} from "../gh/pr-cache.ts";
import {
  parseCommitTrailers,
  parseStack,
  resolveUpTo,
  formatResolutionError,
} from "../parse/index.ts";
import type { PRUnit } from "../parse/index.ts";
import { formatValidationError } from "../ui/format.ts";
import {
  findPRsForBranches,
  retargetPR,
  pushBranch,
  deleteRemoteBranch,
  isAlreadyGone,
} from "../gh/index.ts";
import { evaluateReadiness } from "./land-readiness.ts";
import { confirm as defaultConfirm, selectOne } from "../tui/index.ts";
import { resolveUnitTitle } from "../parse/index.ts";
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
  const prMap = await findPRsForBranches(ctx, scopeBranches, {
    cwd,
    owner: config.owner,
    repo: config.repo,
  });

  // 4a. Readiness gate. Every scope unit must have an open PR, and none may be
  //     blocked by failing/pending checks or changes-requested/review-required.
  const readinessScope = scopeUnits.map((u) => {
    const branch = branchForUnit(u, config);
    return { branch, pr: prMap.get(branch) ?? null };
  });
  const readiness = evaluateReadiness(readinessScope);
  if (!readiness.ok) {
    console.error("✗ Cannot land: the following units have no open PR:");
    for (const branch of readiness.missing) {
      console.error(`  ${branch}`);
    }
    console.error("  Publish them first with `sp sync --open`.");
    process.exit(1);
  }
  if (readiness.verdict.blockers.length > 0) {
    console.error("✗ Cannot land: one or more PRs are not ready:");
    for (const blocker of readiness.verdict.blockers) {
      console.error(`  PR #${blocker.prNumber} (${blocker.branch}):`);
      for (const reason of blocker.reasons) {
        console.error(`    - ${reason}`);
      }
    }
    process.exit(1);
  }

  // 4b. Unresolved review threads are advisory: prompt once for the whole scope.
  if (readiness.verdict.unresolvedThreadPRs.length > 0) {
    const confirmFn = opts.confirm ?? defaultConfirm;
    const prs = readiness.verdict.unresolvedThreadPRs.map((n) => `#${n}`).join(", ");
    const ok = await confirmFn(`PR(s) ${prs} have unresolved review threads. Land anyway?`);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

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

  // 7. Cleanup tail — scrub the state of the units we just landed. The land has
  //    already succeeded; nothing below may abort it. Every failure here warns
  //    (dim) and continues.
  const landedIds = new Set(scopeUnits.map((u) => u.id));
  await dropLandedFromPRCache(ctx, config, landedIds, cwd);
  await scrubLandedGroupRecords(ctx, config, groupRecords, landedIds, cwd);
  if (config.autoDeleteOnLand) {
    await deleteSpentBranches(ctx, config, scopeUnits, cwd);
  }

  // 8. Closing guidance reflects what cleanup actually did.
  if (units.length > scopeUnits.length) {
    console.log(kleur.dim("  Run `sp sync` to retarget the remaining PRs."));
  }
  if (!config.autoDeleteOnLand) {
    console.log(kleur.dim("  Run `sp clean` to delete the landed branches from the remote."));
  }
}

/**
 * Drop the landed units from the PR cache (`refs/spry/prs`). ALWAYS runs — it is
 * not gated by any setting. `sp sync`'s self-heal cannot clear a fully-landed
 * stack (its `writePRCache` early-returns on an empty cache), so land removes
 * the stale entries deterministically. When the drop empties the cache,
 * `savePRCache` deletes the LOCAL ref; we then propagate that as a deletion of
 * the REMOTE ref rather than pushing a now-nonexistent source ref.
 */
async function dropLandedFromPRCache(
  ctx: SpryContext,
  config: SpryConfig,
  landedIds: Set<string>,
  cwd: string | undefined,
): Promise<void> {
  try {
    const cache = await loadPRCache(ctx.git, { cwd });
    let dropped = 0;
    for (const id of landedIds) {
      if (id in cache) {
        delete cache[id];
        dropped++;
      }
    }
    if (dropped === 0) return;

    await savePRCache(ctx.git, cache, { cwd });

    if (Object.keys(cache).length === 0) {
      // The cache is now empty: savePRCache deleted the local ref, so propagate
      // a deletion of the remote ref instead of pushing a nonexistent source.
      const del = await deletePRCacheRemote(ctx.git, config.remote, { cwd });
      if (!del.ok) console.log(kleur.dim(`⚠ Could not clear remote PR cache: ${del.warning}`));
    } else {
      const push = await pushPRCache(ctx.git, config.remote, { cwd });
      if (!push.ok) console.log(kleur.dim(`⚠ Could not push PR cache: ${push.warning}`));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(kleur.dim(`⚠ Could not update PR cache: ${message}`));
  }
}

/**
 * Remove landed group records from `refs/spry/groups`. ALWAYS runs. A unit is a
 * group unit iff its id is a key in the loaded group records; groups are atomic,
 * so a landed group is wholly in scope. Single-commit units never appear here.
 */
async function scrubLandedGroupRecords(
  ctx: SpryContext,
  config: SpryConfig,
  groupRecords: GroupRecords,
  landedIds: Set<string>,
  cwd: string | undefined,
): Promise<void> {
  const landedGroups = Object.keys(groupRecords).filter((id) => landedIds.has(id));
  if (landedGroups.length === 0) return;

  const remaining: GroupRecords = Object.fromEntries(
    Object.entries(groupRecords).filter(([id]) => !landedIds.has(id)),
  );

  // No empty-special-case needed here (unlike the PR-cache path): landing the
  // whole stack leaves `remaining` empty, but `saveAllGroupRecords` writes an
  // empty-tree commit and keeps the ref alive, so the normal refspec push always
  // has a source to push. `savePRCache`, by contrast, deletes its ref when empty.
  try {
    await saveAllGroupRecords(ctx.git, remaining, { cwd });
    const push = await ctx.git.run(["push", config.remote, "refs/spry/groups:refs/spry/groups"], {
      cwd,
    });
    if (push.exitCode !== 0) {
      console.log(kleur.dim(`⚠ Could not push group records: ${push.stderr.trim()}`));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(kleur.dim(`⚠ Could not update group records: ${message}`));
  }
}

/**
 * Delete the spent remote branches of the landed units. GATED on
 * `config.autoDeleteOnLand`. A failed delete warns (dim) and continues — land
 * already succeeded, so nothing here aborts. An "already gone" delete is benign.
 */
async function deleteSpentBranches(
  ctx: SpryContext,
  config: SpryConfig,
  scopeUnits: PRUnit[],
  cwd: string | undefined,
): Promise<void> {
  // No try/catch is needed to honor "nothing here aborts the land": every step
  // goes through `deleteRemoteBranch`, which returns a result object on failure
  // (and `git.run` itself doesn't throw), so the loop can never reject. The
  // guarantee is upheld by the callee contract, not by a guard here.
  for (const unit of scopeUnits) {
    const branch = branchForUnit(unit, config);
    const result = await deleteRemoteBranch(ctx.git, { cwd, remote: config.remote, branch });
    if (result.ok) {
      console.log(`✓ Deleted ${branch}`);
    } else if (isAlreadyGone(result.stderr)) {
      console.log(kleur.dim(`  ${branch} already gone`));
    } else {
      console.log(kleur.dim(`⚠ Could not delete ${branch}: ${result.stderr.trim()}`));
    }
  }
}

// Bare `sp land`: single-select TUI over the stack units (bottom→top). The
// chosen unit's id becomes the `--through` target.
async function defaultPickThrough(units: PRUnit[]): Promise<string | null> {
  const options = units.map((unit) => ({
    id: unit.id,
    label: `${unit.id}  ${resolveUnitTitle(unit)}`,
  }));
  const result = await selectOne(options);
  if (result.cancelled) return null;
  return result.selectedId;
}
