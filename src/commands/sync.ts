import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import {
  loadConfig,
  trunkRef,
  getStackCommits,
  getCurrentBranch,
  injectMissingIds,
  branchForUnit,
  registerBranch,
} from "../git/index.ts";
import {
  loadGroupRecords,
  fetchGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
} from "../git/group-titles.ts";
import { loadTrackedBranches, saveTrackedBranches } from "../git/tracked-branches.ts";
import { injectMissingIdsForBranch } from "../git/rebase.ts";
import { isDetachedHead, getStackCommitsForBranch } from "../git/queries.ts";
import {
  parseCommitTrailers,
  parseStack,
  resolveIdentifiers,
  formatResolutionError,
} from "../parse/index.ts";
import type { PRUnit } from "../parse/index.ts";
import type { CommitWithTrailers } from "../parse/index.ts";
import { formatValidationError } from "../ui/format.ts";
import {
  listRemoteBranches,
  pushBranch,
  findPRsForBranches,
  retargetPR,
  createPR,
  formatPRTitle,
  formatPRBody,
  classifyGhInfraError,
} from "../gh/index.ts";
import { fetchPRCache, savePRCache, pushPRCache } from "../gh/pr-cache.ts";
import type { PRCache } from "../gh/pr-cache.ts";
import type { PRInfo } from "../gh/pr.ts";
import type { SpryConfig } from "../git/config.ts";
import { selectUnits } from "../tui/index.ts";

export interface SyncOptions {
  /** undefined = bare; null = boolean --open (TUI); string = comma-separated IDs */
  open?: string | null;
  cwd?: string;
  all?: boolean;
}

export async function syncCommand(ctx: SpryContext, opts: SyncOptions = {}): Promise<void> {
  if (opts.all && opts.open !== undefined) {
    console.error("✗ `sp sync --all` is push-only and cannot be combined with `--open`.");
    console.error("  Open PRs per stack with `sp sync --open`, then run `sp sync --all` to push.");
    process.exit(1);
  }

  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });

  if (opts.all) {
    return syncAllCommand(ctx, config, cwd);
  }

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

  const currentBranch = await getCurrentBranch(ctx.git, { cwd });
  await registerBranch(ctx.git, currentBranch, { cwd });

  // 2. Re-read commits + parse stack
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });
  const fetchResult = await fetchGroupRecords(ctx.git, config.remote, { cwd });
  if (!fetchResult.ok) {
    console.log(kleur.dim(`⚠ Could not fetch group records: ${fetchResult.warning}`));
  }
  const prCacheFetch = await fetchPRCache(ctx.git, config.remote, { cwd });
  if (!prCacheFetch.ok) {
    console.log(kleur.dim(`⚠ Could not fetch PR cache: ${prCacheFetch.warning}`));
  }
  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);
  const result = parseStack(withTrailers, groupTitles, commitGroups);
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

  // 5. --open: open new PRs (with their own pushes)
  let openedBranches: string[] = [];
  let openHadFailure = false;
  if (opts.open !== undefined) {
    let opened: OpenPRsResult | undefined;
    if (opts.open === null) {
      const candidates = buildOpenCandidates(units, existing, config);
      const result = await selectUnits(candidates);
      if (result.cancelled) {
        console.log("Cancelled.");
        // fall through — retarget still runs on push-phase output
      } else if (result.selectedIds.length === 0) {
        console.log("(no units selected)");
        // fall through — retarget still runs on push-phase output
      } else {
        opened = await openPRs(ctx, config, units, result.selectedIds, withTrailers, cwd);
      }
    } else {
      const targets = resolveOpenTargets(opts.open, units, withTrailers, existing, config);
      if (!targets.ok) {
        console.error(targets.error);
        process.exit(1);
      }
      opened = await openPRs(ctx, config, units, targets.unitIds, withTrailers, cwd);
    }
    if (opened) {
      openedBranches = opened.branches;
      openHadFailure = opened.hadFailure;
    }
  }

  // 6. Fetch PR info for all branches once; use for both retarget and cache
  const allBranches = units.map((u) => branchForUnit(u, config));
  let prMap: Map<string, PRInfo | null> | undefined;
  try {
    prMap = await findPRsForBranches(ctx, allBranches, {
      cwd,
      owner: config.owner,
      repo: config.repo,
    });
  } catch (err) {
    const hint = retargetingFallbackHint(err);
    console.log(kleur.dim(`${hint} (branches still updated)`));
  }

  const retargetBranches = [...pushResult.pushed, ...openedBranches];
  const retargetHadFailure = prMap
    ? await retargetMismatched(ctx, config, units, retargetBranches, prMap, cwd)
    : false;

  if (prMap) {
    await writePRCache(ctx, config, units, prMap, cwd);
  }

  const hadFailure = pushResult.hadFailure || openHadFailure || retargetHadFailure;
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
  existing: Map<string, string>,
  cwd: string | undefined,
): Promise<{ pushed: string[]; hadFailure: boolean }> {
  const pushed: string[] = [];
  let hadFailure = false;
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    if (!existing.has(branch)) continue;
    const headHash = unit.commits.at(-1);
    if (!headHash) continue;
    // Skip the push when the remote tip already equals the local tip: the push
    // would be a no-op round-trip. Retarget still runs on already-published
    // branches (see retargetBranches below), so an unchanged branch whose PR
    // has the wrong base is still fixed.
    if (existing.get(branch) === headHash) {
      pushed.push(branch);
      continue;
    }
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

export function buildOpenCandidates(
  units: PRUnit[],
  existing: ReadonlyMap<string, string>,
  config: SpryConfig,
): { id: string; label: string; hint?: string; disabled?: boolean }[] {
  return units.map((unit) => {
    const branch = branchForUnit(unit, config);
    const isPublished = existing.has(branch);
    const disabled = isPublished ? true : undefined;
    let hint: string | undefined;
    if (isPublished) hint = "(already published)";
    const label = `${unit.id}  ${unit.title ?? unit.subjects[0] ?? "Untitled"}`;
    const opt: { id: string; label: string; hint?: string; disabled?: boolean } = {
      id: unit.id,
      label,
    };
    if (hint !== undefined) opt.hint = hint;
    if (disabled) opt.disabled = true;
    return opt;
  });
}

type ResolveTargetsResult = { ok: true; unitIds: string[] } | { ok: false; error: string };

function resolveOpenTargets(
  raw: string,
  units: PRUnit[],
  commits: CommitWithTrailers[],
  existing: ReadonlyMap<string, string>,
  config: SpryConfig,
): ResolveTargetsResult {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    return { ok: false, error: "✗ --open: no IDs provided" };
  }

  const commitInfos = commits;
  const { unitIds, errors } = resolveIdentifiers(ids, units, commitInfos);
  if (errors.length > 0) {
    return { ok: false, error: errors.map((e) => formatResolutionError(e)).join("\n") };
  }

  for (const id of unitIds) {
    const unit = units.find((u) => u.id === id);
    if (!unit) continue;
    const branch = branchForUnit(unit, config);
    if (existing.has(branch)) {
      return {
        ok: false,
        error:
          `✗ Unit ${unit.id} already has a published branch (${branch}).\n` +
          `  --open is for first-time publish only.\n` +
          `  Run \`sp sync\` to update the branch (PR title/body updates land in a future step).`,
      };
    }
  }

  // Preserve stack order so stacked-PR base computation is correct.
  const orderedIds = units.map((u) => u.id).filter((id) => unitIds.has(id));
  return { ok: true, unitIds: orderedIds };
}

interface OpenPRsResult {
  branches: string[];
  hadFailure: boolean;
}

async function openPRs(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  targetIds: string[],
  commits: CommitWithTrailers[],
  cwd: string | undefined,
): Promise<OpenPRsResult> {
  const targetSet = new Set(targetIds);
  const failedPushTargets = new Set<string>();
  const branches: string[] = [];
  let hadFailure = false;
  const commitInfos = commits;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (!unit) continue;
    if (!targetSet.has(unit.id)) continue;

    const branch = branchForUnit(unit, config);
    const headHash = unit.commits.at(-1);
    if (!headHash) continue;

    // Skip when our predecessor in the stack is also a target whose push
    // failed: its remote branch doesn't exist, so `gh pr create --base` for
    // this unit would fail with a less actionable error. Predecessors that
    // are already published (not in targetSet) are trusted to have valid
    // remote branches.
    const prev = i > 0 ? units[i - 1] : undefined;
    if (prev && targetSet.has(prev.id) && failedPushTargets.has(prev.id)) {
      console.error(`⚠ Skipping ${branch}: predecessor ${prev.id}'s push failed.`);
      hadFailure = true;
      continue;
    }

    const pushResult = await pushBranch(ctx.git, {
      cwd,
      remote: config.remote,
      sha: headHash,
      branch,
      forceWithLease: true,
    });
    if (!pushResult.ok) {
      console.error(`⚠ Failed to push ${branch}: ${pushResult.stderr.trim()}`);
      failedPushTargets.add(unit.id);
      hadFailure = true;
      continue;
    }
    console.log(`↑ pushed ${branch}`);

    // Base is previous unit's branch in the local stack (or trunk for the first unit).
    const base = prev ? branchForUnit(prev, config) : config.trunk;

    const title = formatPRTitle(unit, commitInfos);
    const body = formatPRBody(unit, commitInfos);
    try {
      const pr = await createPR(ctx, { title, head: branch, base, body }, { cwd });
      console.log(`✓ Created PR #${pr.number}: ${title}`);
      console.log(`  ${pr.url}`);
      branches.push(branch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠ Failed to create PR for ${branch}: ${message}`);
      hadFailure = true;
    }
  }

  return { branches, hadFailure };
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
  prMap: Map<string, PRInfo | null>,
  cwd: string | undefined,
): Promise<boolean> {
  if (branches.length === 0) return false;

  let hadFailure = false;
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    if (!branches.includes(branch)) continue;
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

async function writePRCache(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  prMap: Map<string, PRInfo | null>,
  cwd: string | undefined,
): Promise<void> {
  const now = new Date().toISOString();
  const cache: PRCache = {};
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    const pr = prMap.get(branch);
    if (pr) cache[unit.id] = { ...pr, branch, cachedAt: now };
  }
  const count = Object.keys(cache).length;
  if (count === 0) return;
  try {
    await savePRCache(ctx.git, cache, { cwd });
    console.log(`✓ Updated PR cache (${count} ${count === 1 ? "PR" : "PRs"})`);
    const push = await pushPRCache(ctx.git, config.remote, { cwd });
    if (!push.ok) console.log(kleur.dim(`⚠ Could not push PR cache: ${push.warning}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(kleur.dim(`⚠ Could not save PR cache: ${message}`));
  }
}

interface StackState {
  branch: string;
  units: PRUnit[];
  pushed: string[];
}

async function syncAllCommand(
  ctx: SpryContext,
  config: SpryConfig,
  cwd: string | undefined,
): Promise<void> {
  const ref = trunkRef(config);

  // Remote/global reads — done once, not per branch.
  const fetchResult = await fetchGroupRecords(ctx.git, config.remote, { cwd });
  if (!fetchResult.ok) {
    console.log(kleur.dim(`⚠ Could not fetch group records: ${fetchResult.warning}`));
  }
  const prCacheFetch = await fetchPRCache(ctx.git, config.remote, { cwd });
  if (!prCacheFetch.ok) {
    console.log(kleur.dim(`⚠ Could not fetch PR cache: ${prCacheFetch.warning}`));
  }
  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);
  const existing = await listRemoteBranches(ctx.git, config.remote, config.branchPrefix, { cwd });

  // Register the current branch (unless detached), then load the full list.
  const currentBranch = (await isDetachedHead(ctx.git, { cwd }))
    ? null
    : await getCurrentBranch(ctx.git, { cwd });
  if (currentBranch) {
    await registerBranch(ctx.git, currentBranch, { cwd });
  }

  const tracked = await loadTrackedBranches(ctx.git, { cwd });
  if (tracked.length === 0) {
    console.log("✓ No tracked branches");
    return;
  }

  const stillTracked: string[] = [];
  const stacks: StackState[] = [];
  let hadFailure = false;

  for (const branch of tracked) {
    const exists = await ctx.git.run(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd });
    if (exists.exitCode !== 0) {
      console.log(`${branch}: removed (branch no longer exists)`);
      continue;
    }
    stillTracked.push(branch);
    console.log(`${branch}:`);

    // 1. Inject missing Spry-Commit-Ids. Current branch uses the worktree-safe
    //    path; others rewrite the ref only.
    const inject =
      branch === currentBranch
        ? await injectMissingIds(ctx.git, ref, { cwd })
        : await injectMissingIdsForBranch(ctx.git, branch, ref, { cwd });
    if (!inject.ok) {
      // Only reachable for the current-branch path (injectMissingIdsForBranch
      // never returns ok:false), and only on a detached HEAD — which here means
      // currentBranch is null, so this is defensive rather than expected.
      console.error(`  ✗ Could not inject commit IDs for ${branch}.`);
      hadFailure = true;
      continue;
    }
    if (inject.modifiedCount > 0) {
      console.log(`  ✓ Injected ${inject.modifiedCount} commit ID(s)`);
    }

    // 2. Parse this branch's stack into units.
    const commits = await getStackCommitsForBranch(ctx.git, branch, ref, { cwd });
    const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });
    const result = parseStack(withTrailers, groupTitles, commitGroups);
    if (!result.ok) {
      console.error(formatValidationError(result));
      hadFailure = true;
      continue;
    }
    if (result.units.length === 0) {
      console.log(`  ✓ No commits in stack`);
      continue;
    }

    // 3. Push the branches that already exist on the remote.
    const pushResult = await pushExistingBranches(ctx, config, result.units, existing, cwd);
    if (pushResult.hadFailure) hadFailure = true;

    stacks.push({ branch, units: result.units, pushed: pushResult.pushed });
  }

  // PR retarget + cache happen once, after the loop (Task 4 fills this in).
  await finishSyncAll(ctx, config, stacks, cwd);

  await saveTrackedBranches(ctx.git, stillTracked, { cwd });

  if (hadFailure) {
    console.log("⚠ Sync completed with warnings");
    process.exit(1);
  }
  console.log("✓ Sync complete");
}

async function finishSyncAll(
  ctx: SpryContext,
  config: SpryConfig,
  stacks: StackState[],
  cwd: string | undefined,
): Promise<void> {
  if (stacks.length === 0) return;

  // One batched PR lookup across every branch of every stack.
  const allBranches = stacks.flatMap((s) => s.units.map((u) => branchForUnit(u, config)));
  let prMap: Map<string, PRInfo | null> | undefined;
  try {
    prMap = await findPRsForBranches(ctx, allBranches, {
      cwd,
      owner: config.owner,
      repo: config.repo,
    });
  } catch (err) {
    const hint = retargetingFallbackHint(err);
    console.log(kleur.dim(`${hint} (branches still updated)`));
    return;
  }

  // Retarget each stack independently against the shared map. Unlike
  // single-branch sync, retarget failures are non-fatal here: each one
  // self-logs in retargetMismatched, and one stack's failure shouldn't abort
  // syncing the rest. (Push failures still flip hadFailure in syncAllCommand.)
  for (const stack of stacks) {
    await retargetMismatched(ctx, config, stack.units, stack.pushed, prMap, cwd);
  }

  // Write the PR cache ONCE with all units combined. `writePRCache` builds the
  // cache from scratch and `savePRCache` replaces the whole tree, so a single
  // call with the concatenated units is clobber-safe (unit IDs are globally
  // unique).
  const combinedUnits = stacks.flatMap((s) => s.units);
  await writePRCache(ctx, config, combinedUnits, prMap, cwd);
}

function retargetingFallbackHint(err: unknown): string {
  const kind = classifyGhInfraError(err);
  if (kind === "no-gh") return "PR retargeting unavailable: install gh (https://cli.github.com)";
  if (kind === "auth") return "PR retargeting unavailable: gh auth login";
  if (kind === "no-remote") return "PR retargeting unavailable: not a GitHub repository";
  return "PR retargeting unavailable: network error";
}
