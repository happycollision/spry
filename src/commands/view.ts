import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef, getCurrentBranch, getStackCommits } from "../git/index.ts";
import { loadGroupRecords, buildCommitGroupMap, extractGroupTitles } from "../git/group-titles.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { enrichFromCache } from "../gh/enrich.ts";
import type { EnrichedUnit } from "../gh/enrich.ts";
import { loadPRCache } from "../gh/pr-cache.ts";
import { formatStackView, formatValidationError } from "../ui/format.ts";

export async function viewCommand(ctx: SpryContext): Promise<void> {
  const config = await loadConfig(ctx.git);
  const branch = await getCurrentBranch(ctx.git);
  const ref = trunkRef(config);
  const commits = await getStackCommits(ctx.git, ref);
  const withTrailers = await parseCommitTrailers(commits, ctx.git);

  const groupRecords = await loadGroupRecords(ctx.git);
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);
  const result = parseStack(withTrailers, groupTitles, commitGroups);

  if (!result.ok) {
    console.error(formatValidationError(result));
    process.exit(1);
  }

  const prCache = await loadPRCache(ctx.git);
  const enriched: EnrichedUnit[] = enrichFromCache(result.units, prCache);

  console.log(formatStackView(enriched, branch, commits.length, ref));
}
