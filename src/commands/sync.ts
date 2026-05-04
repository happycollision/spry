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
import {
  parseCommitTrailers,
  parseStack,
  resolveIdentifiers,
  formatResolutionError,
} from "../parse/index.ts";
import type { PRUnit, CommitInfo } from "../parse/index.ts";
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
  GhAuthError,
  GhNotInstalledError,
} from "../gh/index.ts";
import type { SpryConfig } from "../git/config.ts";
import { selectUnits } from "../tui/index.ts";

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

  // 6. Retarget phase — gh required, falls back gracefully
  const retargetHadFailure = await retargetMismatched(
    ctx,
    config,
    units,
    [...pushResult.pushed, ...openedBranches],
    cwd,
  );

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

export function buildOpenCandidates(
  units: PRUnit[],
  existing: Set<string>,
  config: SpryConfig,
): { id: string; label: string; hint?: string; disabled?: boolean }[] {
  return units.map((unit) => {
    const branch = branchForUnit(unit, config);
    const isPublished = existing.has(branch);
    const isGroup = unit.type === "group";
    const disabled = isPublished || isGroup;
    let hint: string | undefined;
    if (isPublished) hint = "(already published)";
    else if (isGroup) hint = "(group — Step 7)";
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

function commitsToInfos(commits: CommitWithTrailers[]): CommitInfo[] {
  return commits.map((c) => {
    const trailers: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.trailers)) {
      if (typeof v === "string") trailers[k] = v;
    }
    return {
      hash: c.hash,
      subject: c.subject,
      body: c.body,
      trailers,
    };
  });
}

function resolveOpenTargets(
  raw: string,
  units: PRUnit[],
  commits: CommitWithTrailers[],
  existing: Set<string>,
  config: SpryConfig,
): ResolveTargetsResult {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    return { ok: false, error: "✗ --open: no IDs provided" };
  }

  const commitInfos = commitsToInfos(commits);
  const { unitIds, errors } = resolveIdentifiers(ids, units, commitInfos);
  if (errors.length > 0) {
    return { ok: false, error: errors.map((e) => formatResolutionError(e)).join("\n") };
  }

  for (const id of unitIds) {
    const unit = units.find((u) => u.id === id);
    if (!unit) continue;
    if (unit.type === "group") {
      return {
        ok: false,
        error:
          `✗ Groups not supported in --open yet (unit ${unit.id}).\n` +
          `  Group title storage lands with \`sp group\` (Step 7). For now, --open works on singles.`,
      };
    }
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
  const commitInfos = commitsToInfos(commits);

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
