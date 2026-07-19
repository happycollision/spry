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
  fetchRemote,
} from "../git/index.ts";
import { expectedBaseFor as sharedExpectedBaseFor } from "./stack-analysis.ts";
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
import { fetchPRCache, savePRCache, pushPRCache, loadPRCache } from "../gh/pr-cache.ts";
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

export interface CheckSyncResult {
  units: PRUnit[];
  commits: CommitWithTrailers[];
  prMap: Map<string, PRInfo | null> | undefined;
  prCache: PRCache;
  config: SpryConfig;
  /**
   * Snapshot of remote-tracking tips (`refs/remotes/<remote>/<prefix>/*`)
   * captured BEFORE checkSync's fetch. Keyed by branch name without the
   * `refs/remotes/<remote>/` prefix (i.e. the `<branchPrefix>/<id>` form, same
   * as `listRemoteBranches`). Used to pin the push lease to what the local
   * clone knew the remote to be before the fetch refreshed it. A branch with
   * no tracking ref (never fetched) is absent.
   */
  preFetchRemoteTips: Map<string, string>;
}

/**
 * Snapshot the current remote-tracking tips for all spry branches
 * (`refs/remotes/<remote>/<prefix>/*`) into a `Map<branch, sha>`, keyed WITHOUT
 * the `refs/remotes/<remote>/` prefix. Must be called BEFORE any fetch so the
 * captured SHAs reflect the pre-fetch state of the tracking refs.
 */
async function snapshotRemoteTips(
  git: SpryContext["git"],
  remote: string,
  prefix: string,
  cwd: string | undefined,
): Promise<Map<string, string>> {
  const res = await git.run(
    ["for-each-ref", "--format=%(refname) %(objectname)", `refs/remotes/${remote}/${prefix}/`],
    { cwd },
  );
  const map = new Map<string, string>();
  if (res.exitCode !== 0) return map;
  const stripPrefix = `refs/remotes/${remote}/`;
  for (const line of res.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(" ");
    if (sp === -1) continue;
    const refname = t.slice(0, sp);
    const sha = t.slice(sp + 1).trim();
    if (refname.startsWith(stripPrefix)) map.set(refname.slice(stripPrefix.length), sha);
  }
  return map;
}

/**
 * Read-only acquisition of remote state into refs. Does a real `git fetch`
 * (updates refs/remotes/origin/* so analyzeStack can read tips), fetches group
 * records + PR cache, parses the stack, looks up live PR state, and refreshes
 * refs/spry/prs to mirror GitHub. Mutates NOTHING else — no inject, no push,
 * no createPR, no retargetPR.
 */
export async function checkSync(
  ctx: SpryContext,
  opts: { cwd?: string } = {},
): Promise<CheckSyncResult> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });
  const ref = trunkRef(config);

  // Capture remote-tracking tips BEFORE the fetch. These are what the local
  // clone last knew the remote to be; the push phase pins its lease to them so
  // the fetch below cannot mask a concurrent remote force-push.
  const preFetchRemoteTips = await snapshotRemoteTips(
    ctx.git,
    config.remote,
    config.branchPrefix,
    cwd,
  );

  await fetchRemote(ctx.git, config.remote, { cwd });

  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });

  const fetchResult = await fetchGroupRecords(ctx.git, config.remote, { cwd });
  if (!fetchResult.ok)
    console.log(kleur.dim(`⚠ Could not fetch group records: ${fetchResult.warning}`));
  const prCacheFetch = await fetchPRCache(ctx.git, config.remote, { cwd });
  if (!prCacheFetch.ok)
    console.log(kleur.dim(`⚠ Could not fetch PR cache: ${prCacheFetch.warning}`));

  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);
  const parsed = parseStack(withTrailers, groupTitles, commitGroups);
  if (!parsed.ok) {
    console.error(formatValidationError(parsed));
    process.exit(1);
  }
  const units = parsed.units;

  let prMap: Map<string, PRInfo | null> | undefined;
  if (units.length > 0) {
    const allBranches = units.map((u) => branchForUnit(u, config));
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
    if (prMap) await writePRCache(ctx, config, units, prMap, cwd);
  }

  const prCache = await loadPRCache(ctx.git, { cwd });
  return { units, commits: withTrailers, prMap, prCache, config, preFetchRemoteTips };
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

  // 2. Acquire remote state (fetch + parse + PR lookup + PR-cache refresh).
  const checked = await checkSync(ctx, { cwd });
  const units = checked.units;
  const withTrailers = checked.commits;
  if (units.length === 0) {
    console.log("✓ No commits in stack");
    return;
  }

  // 3. Cheap signal: which branches already exist on the remote?
  const existing = await listRemoteBranches(ctx.git, config.remote, config.branchPrefix, { cwd });

  // 3.5 Phase 1 — pre-push park. When the stack has been reordered, an
  // in-place force-push can make a PR's head reachable from its stale base and
  // GitHub marks it MERGED. Parking every mismatched open PR onto trunk first
  // removes those stale relationships. Branches whose park fails are excluded
  // from the push (fail-safe) and flip hadFailure.
  const prMapForPark = checked.prMap;
  let parkFailed = new Set<string>();
  if (prMapForPark && stackHasReorder(units, prMapForPark, config)) {
    const existingBranches = units
      .map((u) => branchForUnit(u, config))
      .filter((b) => existing.has(b));
    parkFailed = await parkMismatchedToTrunk(
      ctx,
      config,
      units,
      existingBranches,
      prMapForPark,
      cwd,
    );
  }

  // 4. Push phase — only branches that already exist remotely (skip park failures)
  const pushResult = await pushExistingBranches(
    ctx,
    config,
    units,
    existing,
    checked.preFetchRemoteTips,
    cwd,
    parkFailed,
  );

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
        opened = await openPRs(
          ctx,
          config,
          units,
          result.selectedIds,
          withTrailers,
          checked.preFetchRemoteTips,
          cwd,
        );
      }
    } else {
      const targets = resolveOpenTargets(opts.open, units, withTrailers, existing, config);
      if (!targets.ok) {
        console.error(targets.error);
        process.exit(1);
      }
      opened = await openPRs(
        ctx,
        config,
        units,
        targets.unitIds,
        withTrailers,
        checked.preFetchRemoteTips,
        cwd,
      );
    }
    if (opened) {
      openedBranches = opened.branches;
      openHadFailure = opened.hadFailure;
    }
  }

  // 6. Reuse the PR info checkSync already fetched (and cached) for retarget.
  const prMap = checked.prMap;

  const retargetBranches = [...pushResult.pushed, ...openedBranches];
  const retargetHadFailure = prMap
    ? await retargetMismatched(ctx, config, units, retargetBranches, prMap, cwd)
    : false;

  // checkSync already wrote the PR cache once from the same prMap. Only rewrite
  // it when a retarget pass ran (branches were pushed/opened) — otherwise the
  // first write already reflects reality and a second savePRCache + pushPRCache
  // would be a redundant ref push and a duplicate console line.
  if (prMap && retargetBranches.length > 0) {
    await writePRCache(ctx, config, units, prMap, cwd);
  }

  const hadFailure =
    pushResult.hadFailure || openHadFailure || retargetHadFailure || parkFailed.size > 0;
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
  preFetchTips: Map<string, string>,
  cwd: string | undefined,
  skip: ReadonlySet<string> = new Set(),
): Promise<{ pushed: string[]; hadFailure: boolean }> {
  const pushed: string[] = [];
  let hadFailure = false;
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    if (!existing.has(branch)) continue;
    if (skip.has(branch)) continue; // park failed for this branch — do not push
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
      // Pin the lease to what the clone knew the remote to be BEFORE
      // checkSync's fetch. Undefined (branch never fetched) falls back to the
      // bare lease.
      leaseExpectedSha: preFetchTips.get(branch),
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
  preFetchTips: Map<string, string>,
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
      // First-publish branches have no remote ref yet → undefined → bare lease
      // (effectively create-only, today's behavior).
      leaseExpectedSha: preFetchTips.get(branch),
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

/**
 * A reorder is "detected" when at least one open PR's current on-GitHub base
 * (from prMap) differs from the base a correctly-stacked PR would have
 * (expectedBaseFor). When nothing is changing, sync takes the cheap path and
 * skips the pre-push park entirely. Closed/merged PRs and units with no PR are
 * ignored — only open PRs can be endangered by the push.
 */
export function stackHasReorder(
  units: PRUnit[],
  prMap: Map<string, PRInfo | null>,
  config: SpryConfig,
): boolean {
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    const pr = prMap.get(branch);
    if (!pr || pr.state !== "OPEN") continue;
    if (pr.baseRefName !== sharedExpectedBaseFor(unit, units, config)) return true;
  }
  return false;
}

/**
 * Phase 1 of a reorder-safe sync: retarget every open, mismatched PR in
 * `branches` to `config.trunk` BEFORE the push. Trunk never contains a stack
 * head, so `gh pr edit --base trunk` always succeeds; parking here removes the
 * stale base relationships that would otherwise let the force-push mark a PR
 * MERGED. Returns the set of branches whose park FAILED — the caller must not
 * push those (pushing with an unparked stale base risks the merge).
 *
 * Why excluding just the failed PR's OWN branch from the push is sufficient
 * (and not, as it first appears, the wrong lever): GitHub decides MERGED by
 * commit-SHA reachability from the base branch tip, and a reorder rewrites every
 * repositioned commit to a fresh SHA (`rebasePlumbing` → `commit-tree`). A PR is
 * only parked when it is *mismatched* — i.e. its position relative to its base
 * changed — which means its head commit was rewritten to a new SHA that appears
 * in no branch's pushed history. So a PR left unparked by a failed park cannot
 * have its (old-SHA) head made reachable by any *other* branch's push. The one
 * way an old head SHA survives verbatim into another pushed branch is an
 * unchanged bottom prefix, but such a PR is *matched* (base == expectedBase) and
 * is never parked. The parked set and the surviving-old-SHA set are disjoint, so
 * skipping the failed PR's own branch is enough. (See beads spry-8vz2 for an
 * optional defensive hardening — abort the whole stack's push on any park
 * failure — that would remove the reliance on this SHA-rewriting invariant.)
 */
export async function parkMismatchedToTrunk(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  branches: string[],
  prMap: Map<string, PRInfo | null>,
  cwd: string | undefined,
): Promise<Set<string>> {
  const failed = new Set<string>();
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    if (!branches.includes(branch)) continue;
    const pr = prMap.get(branch);
    if (!pr || pr.state !== "OPEN") continue;
    // Already on trunk (e.g. the bottom unit) — nothing to park.
    if (pr.baseRefName === config.trunk) continue;
    // Only park PRs whose base is actually changing; a PR already correctly
    // stacked and staying put needs no intermediate hop.
    if (pr.baseRefName === sharedExpectedBaseFor(unit, units, config)) continue;
    try {
      await retargetPR(ctx, pr.number, config.trunk, { cwd });
      console.log(`↻ parked PR #${pr.number} → ${config.trunk}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠ Could not park PR #${pr.number}: ${message}`);
      failed.add(branch);
    }
  }
  return failed;
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
    const expected = sharedExpectedBaseFor(unit, units, config);
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
    // Only an OPEN PR is the unit's live PR. A MERGED/CLOSED record on the same
    // head branch is stale residue (GitHub never deletes PRs, so a reused branch
    // keeps old records) — caching it would print a phantom "Updated PR cache"
    // and let sp view render a stale state. Merged-state display comes from the
    // cache write made while the PR was still open; land/clean own its removal.
    if (pr && pr.state === "OPEN") cache[unit.id] = { ...pr, branch, cachedAt: now };
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

    // 3. Parse only — push happens after the batched PR lookup + park below.
    stacks.push({ branch, units: result.units, pushed: [] });
  }

  // Batched PR lookup BEFORE any push, so each stack can park its mismatched
  // open PRs to trunk before it is force-pushed (reorder-merge fix, spry-206).
  const allBranches = stacks.flatMap((s) => s.units.map((u) => branchForUnit(u, config)));
  let prMap: Map<string, PRInfo | null> | undefined;
  if (allBranches.length > 0) {
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
  }

  // Park + push each stack. Park (if reordered) precedes that stack's push.
  // `sp sync --all` does not run checkSync's fetch, so there is no pre-fetch
  // snapshot to pin against — pass an empty map for the lease baseline, which
  // falls back to the bare `--force-with-lease` (today's behavior).
  for (const stack of stacks) {
    let parkFailed = new Set<string>();
    if (prMap && stackHasReorder(stack.units, prMap, config)) {
      const existingBranches = stack.units
        .map((u) => branchForUnit(u, config))
        .filter((b) => existing.has(b));
      parkFailed = await parkMismatchedToTrunk(
        ctx,
        config,
        stack.units,
        existingBranches,
        prMap,
        cwd,
      );
      if (parkFailed.size > 0) hadFailure = true;
    }
    const pushResult = await pushExistingBranches(
      ctx,
      config,
      stack.units,
      existing,
      new Map(),
      cwd,
      parkFailed,
    );
    if (pushResult.hadFailure) hadFailure = true;
    stack.pushed = pushResult.pushed;
  }

  // PR retarget + cache — reuse the prMap we already fetched.
  await finishSyncAll(ctx, config, stacks, prMap, cwd);

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
  prMap: Map<string, PRInfo | null> | undefined,
  cwd: string | undefined,
): Promise<void> {
  if (stacks.length === 0) return;
  if (!prMap) return; // lookup failed upstream; branches were still pushed

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
