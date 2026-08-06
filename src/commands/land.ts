import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import { loadConfig, branchForUnit } from "../git/index.ts";
import type { SpryConfig } from "../git/index.ts";
import type { GroupRecords } from "../parse/index.ts";
import { loadGroupRecords, saveAllGroupRecords, pushGroupRecords } from "../git/group-titles.ts";
import { loadPRCache, savePRCache, pushPRCache, deletePRCacheRemote } from "../gh/pr-cache.ts";
import type { PRCacheEntry } from "../gh/pr-cache.ts";
import { resolveUpTo, formatResolutionError } from "../parse/index.ts";
import type { PRUnit } from "../parse/index.ts";
import { pushBranch, deleteRemoteBranch, isAlreadyGone } from "../gh/index.ts";
import { confirm as defaultConfirm, selectOne } from "../tui/index.ts";
import { resolveUnitTitle } from "../parse/index.ts";
import { checkSync } from "./sync.ts";
import { analyzeStack, landBlockers } from "./stack-analysis.ts";
import type { UnitAnalysis, UnitBlockers } from "./stack-analysis.ts";
import type { PRInfo } from "../gh/pr.ts";
import { findPRsForBranches } from "../gh/pr.ts";
import { classifyScope, renderReinvokeHint } from "./land-poll.ts";

export interface LandOptions {
  through?: string;
  poll?: boolean;
  /** Poll cadence in seconds; default 30. Only meaningful with --poll / an accepted nudge. */
  interval?: number;
  cwd?: string;
  /** Injected for testability; default to a real TUI. */
  confirm?: (message: string) => Promise<boolean>;
  pickThrough?: (units: PRUnit[]) => Promise<string | null>;
  /** True when stdin is a terminal (nudge is interactive). Default: real TTY check. */
  isInteractive?: () => boolean;
  /** Sleep `seconds` between polls. Default: real setTimeout. */
  sleep?: (seconds: number) => Promise<void>;
  /** Poll PR state by branch name. Default: findPRsForBranches against gh. */
  pollPRs?: (branches: string[]) => Promise<Map<string, PRInfo | null>>;
}

/** Everything the wait loop + push need — all working-tree-independent. */
interface LandPlan {
  tip: string;
  trunk: string;
  scopeUnits: PRUnit[];
  scopeBranches: string[];
  throughId: string;
}

const DEFAULT_INTERVAL_SECONDS = 30;

export async function landCommand(ctx: SpryContext, opts: LandOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });

  // 1. Acquire remote state into refs (read-only; no inject, no push, no retarget).
  const checked = await checkSync(ctx, { cwd });
  const units = checked.units;
  if (units.length === 0) {
    console.log("✓ No commits in stack");
    return;
  }
  const withTrailers = checked.commits;

  // 2. Resolve the "through" scope (or pick via TUI).
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

  // 3. Analyze the WHOLE stack, then gate on the in-scope units only.
  const analysis = await analyzeStack(
    ctx,
    { units, commits: withTrailers, prCache: checked.prCache, config },
    { cwd },
  );
  const scopeAnalysis = analysis.units.filter((a) => scope.unitIds.has(a.unit.id));
  const prByUnit: Record<string, PRCacheEntry | null> = {};
  for (const a of scopeAnalysis) prByUnit[a.unit.id] = checked.prCache[a.unit.id] ?? null;

  const blockers = landBlockers(scopeAnalysis, prByUnit);

  // Fresh live PR state keyed by branch, for classifyScope.
  const prByBranch = new Map<string, PRInfo | null>();
  for (const a of scopeAnalysis) {
    prByBranch.set(a.branch, checked.prMap?.get(a.branch) ?? null);
  }
  const verdict = classifyScope(blockers, prByBranch);

  if (verdict.kind === "hard") {
    printHardBlockers(verdict.perUnit, "Run `sp sync` and try again.");
    process.exit(1);
  }

  const plan: LandPlan = {
    tip,
    trunk: config.trunk,
    scopeUnits,
    scopeBranches: scopeUnits.map((u) => branchForUnit(u, config)),
    throughId,
  };

  // Decide whether we are entering the wait loop.
  let willPoll = opts.poll === true;

  if (verdict.kind === "ci-pending" && !willPoll) {
    // Bare land with CI as the sole blocker: surface --poll.
    const isInteractive = opts.isInteractive ?? defaultIsInteractive;
    if (isInteractive()) {
      const confirmFn = opts.confirm ?? defaultConfirm;
      const yes = await confirmFn("Would you like to poll until CI passes, then auto-land?");
      if (!yes) {
        console.log("Not landed; CI still running.");
        return;
      }
      willPoll = true;
    } else {
      console.error(renderReinvokeHint(plan.throughId));
      process.exit(1);
    }
  }

  // 3b. Unresolved review threads are advisory: prompt once, up front, while the
  // user is present (never inside the wait loop).
  const scopePRs = scopeUnits
    .map((u) => checked.prCache[u.id])
    .filter((pr): pr is NonNullable<typeof pr> => !!pr);
  const unresolved = scopePRs.filter((pr) => pr.reviewThreads.total > pr.reviewThreads.resolved);
  if (unresolved.length > 0) {
    const confirmFn = opts.confirm ?? defaultConfirm;
    const prs = unresolved.map((pr) => `#${pr.number}`).join(", ");
    const ok = await confirmFn(`PR(s) ${prs} have unresolved review threads. Land anyway?`);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  if (willPoll) {
    await runPollLoop(ctx, config, plan, units.length, opts);
    return;
  }
  await performLand(ctx, config, plan, units.length, cwd);
}

/** The push + cleanup tail. Consumes ONLY the frozen plan (no HEAD read). */
async function performLand(
  ctx: SpryContext,
  config: SpryConfig,
  plan: LandPlan,
  totalUnits: number,
  cwd: string | undefined,
): Promise<void> {
  // 4. One ff push to the target tip.
  const result = await pushBranch(ctx.git, {
    cwd,
    remote: config.remote,
    sha: plan.tip,
    branch: plan.trunk,
    forceWithLease: false,
  });
  if (!result.ok) {
    if (result.reason === "stale-ref") {
      console.error(`✗ ${plan.trunk} is ahead of your stack. Run \`sp rebase\` and try again.`);
    } else {
      console.error(`✗ Could not land: ${result.stderr.trim()}`);
    }
    process.exit(1);
  }

  const n = plan.scopeUnits.length;
  console.log(`✓ Landed ${n} PR${n === 1 ? "" : "s"} to ${plan.trunk}`);

  // 5. Cleanup tail — scrub the state of the units we just landed. The land has
  //    already succeeded; nothing below may abort it. Every failure here warns
  //    (dim) and continues.
  const landedIds = new Set(plan.scopeUnits.map((u) => u.id));
  await dropLandedFromPRCache(ctx, config, landedIds, cwd);
  await scrubLandedGroupRecords(ctx, config, landedIds, cwd);
  if (config.autoDeleteOnLand) {
    await deleteSpentBranches(ctx, config, plan.scopeUnits, cwd);
  }

  // 6. Closing guidance reflects what cleanup actually did.
  if (totalUnits > plan.scopeUnits.length) {
    console.log(kleur.dim("  Run `sp sync` to retarget the remaining PRs."));
  }
  if (!config.autoDeleteOnLand) {
    console.log(kleur.dim("  Run `sp clean` to delete the landed branches from the remote."));
  }
}

/** Print the per-unit blocker reasons for a hard-blocked scope. */
function printHardBlockers(perUnit: UnitBlockers[], guidance: string): void {
  console.error("✗ Cannot land: the following units are not ready:");
  for (const b of perUnit) {
    console.error(`  ${b.branch}:`);
    for (const r of b.reasons) console.error(`    - ${r}`);
  }
  console.error(`  ${guidance}`);
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
 *
 * Loads the records FRESH (mirroring `dropLandedFromPRCache`'s fresh
 * `loadPRCache`) rather than receiving a snapshot taken before the (possibly
 * long, `--poll`-driven) wait: `refs/spry/groups` is shared, so a snapshot
 * from before the wait could be stale by the time we scrub — e.g. the user
 * ran `sp group` on another stack while this land was polling — and writing
 * that stale snapshot back via `saveAllGroupRecords` would silently clobber
 * the newer records, locally and on the remote.
 */
async function scrubLandedGroupRecords(
  ctx: SpryContext,
  config: SpryConfig,
  landedIds: Set<string>,
  cwd: string | undefined,
): Promise<void> {
  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
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
    const push = await pushGroupRecords(ctx.git, config.remote, { cwd });
    if (!push.ok) {
      console.log(kleur.dim(`⚠ Could not push group records: ${push.warning}`));
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

/**
 * The `--poll` wait loop. Re-checks PR state on a cadence until the scope is
 * `ready` (lands via {@link performLand}) or turns `hard` (fails fast — a
 * mixed/non-CI blocker cannot be cleared by waiting). Consumes ONLY the frozen
 * `plan` — no `HEAD`/working-tree read — so the user can switch branches
 * mid-wait. Structural flags (missingId/unpushed/misTargeted) are frozen at
 * their pre-loop clean values: this scope already cleared the up-front
 * structural gate, and nothing the loop (or the user, on their working tree)
 * does can change them; only PR-derived readiness is re-evaluated per poll.
 */
async function runPollLoop(
  ctx: SpryContext,
  config: SpryConfig,
  plan: LandPlan,
  totalUnits: number,
  opts: LandOptions,
): Promise<void> {
  const intervalSeconds = opts.interval ?? DEFAULT_INTERVAL_SECONDS;
  const sleep = opts.sleep ?? ((s: number) => new Promise<void>((r) => setTimeout(r, s * 1000)));
  const pollPRs =
    opts.pollPRs ??
    ((branches: string[]) =>
      findPRsForBranches(ctx, branches, { cwd: opts.cwd, owner: config.owner, repo: config.repo }));

  // expectedBase/currentBase are only read when misTargeted is true — pinned
  // false here, so these are inert placeholders.
  const frozenAnalysis: UnitAnalysis[] = plan.scopeUnits.map((unit) => ({
    unit,
    branch: branchForUnit(unit, config),
    missingId: false,
    unpushed: false,
    misTargeted: false,
    currentBase: undefined,
    expectedBase: config.trunk,
  }));

  let bannerPrinted = false;

  for (;;) {
    const prMap = await pollPRs(plan.scopeBranches);
    const prByUnit: Record<string, PRInfo | null> = {};
    for (const a of frozenAnalysis) prByUnit[a.unit.id] = prMap.get(a.branch) ?? null;

    const blockers = landBlockers(frozenAnalysis, prByUnit);
    const verdict = classifyScope(blockers, prMap);

    if (verdict.kind === "ready") {
      await performLand(ctx, config, plan, totalUnits, opts.cwd);
      return;
    }
    if (verdict.kind === "hard") {
      printHardBlockers(
        verdict.perUnit,
        "The scope is no longer land-ready; resolve the above and re-run sp land.",
      );
      process.exit(1);
    }

    // ci-pending: banner once, then dim progress + sleep.
    if (!bannerPrinted) {
      const prs = verdict.prNumbers.map((n) => `#${n}`).join(", ");
      console.log(
        kleur.dim(`⧗ CI pending on ${prs}; polling every ${intervalSeconds}s (Ctrl-C to stop)…`),
      );
      bannerPrinted = true;
    } else {
      console.log(kleur.dim(`  …still pending`));
    }
    await sleep(intervalSeconds);
  }
}

function defaultIsInteractive(): boolean {
  return process.stdin.isTTY === true;
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
