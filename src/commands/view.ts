import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef, getCurrentBranch, getStackCommits } from "../git/index.ts";
import {
  loadGroupRecords,
  fetchGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
} from "../git/group-titles.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { enrichUnits } from "../gh/enrich.ts";
import type { EnrichedUnit } from "../gh/enrich.ts";
import { formatStackView, formatValidationError } from "../ui/format.ts";

export interface ViewOptions {
  noFetch?: boolean;
}

export async function viewCommand(ctx: SpryContext, opts: ViewOptions = {}): Promise<void> {
  const config = await loadConfig(ctx.git);
  const branch = await getCurrentBranch(ctx.git);
  const ref = trunkRef(config);
  const commits = await getStackCommits(ctx.git, ref);
  const withTrailers = await parseCommitTrailers(commits, ctx.git);

  if (!opts.noFetch) {
    const fetchResult = await fetchGroupRecords(ctx.git, config.remote);
    if (!fetchResult.ok) {
      console.log(kleur.dim(`⚠ Could not fetch group records: ${fetchResult.warning}`));
    }
  }
  const groupRecords = await loadGroupRecords(ctx.git);
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);
  const result = parseStack(withTrailers, groupTitles, commitGroups);

  if (!result.ok) {
    console.error(formatValidationError(result));
    process.exit(1);
  }

  const enriched: EnrichedUnit[] = opts.noFetch
    ? result.units.map((unit) => ({ unit, pr: null }))
    : await enrichUnits(ctx, result.units, config);

  console.log(formatStackView(enriched, branch, commits.length, ref));
}
