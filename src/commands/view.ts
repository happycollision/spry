import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef, getCurrentBranch, getStackCommits } from "../git/index.ts";
import { resolveRemoteTrackingTip } from "../git/branch.ts";
import { classifyDrift } from "../git/drift.ts";
import type { Drift } from "../git/drift.ts";
import { loadGroupRecords, buildCommitGroupMap, extractGroupTitles } from "../git/group-titles.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { buildStackTree } from "../parse/stack-tree.ts";
import { enrichFromCache } from "../gh/enrich.ts";
import type { EnrichedUnit } from "../gh/enrich.ts";
import { loadPRCache } from "../gh/pr-cache.ts";
import { formatStackView, formatValidationError } from "../ui/format.ts";

export interface ViewOptions {
  cwd?: string;
  json?: boolean;
}

export async function viewCommand(ctx: SpryContext, opts: ViewOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });
  const branch = await getCurrentBranch(ctx.git, { cwd });
  const ref = trunkRef(config);
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = parseCommitTrailers(commits, ctx.git, { cwd });

  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);
  const result = parseStack(withTrailers, groupTitles, commitGroups);

  if (!result.ok) {
    console.error(formatValidationError(result));
    process.exit(1);
  }

  const prCache = await loadPRCache(ctx.git, { cwd });
  const enriched: EnrichedUnit[] = enrichFromCache(result.units, prCache);

  const drift: Drift[] = [];
  for (const unit of result.units) {
    const localTip = unit.commits[unit.commits.length - 1] ?? "";
    const syncedHeadSha = prCache[unit.id]?.syncedHeadSha;
    const remoteTrackingTip = await resolveRemoteTrackingTip(ctx.git, unit, config, { cwd });
    drift.push(classifyDrift({ localTip, syncedHeadSha, remoteTrackingTip }));
  }

  if (opts.json) {
    console.log(JSON.stringify(buildStackTree(enriched, drift), null, 2));
    return;
  }

  console.log(formatStackView(enriched, branch, commits.length, ref, drift));
}
