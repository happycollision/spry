import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef, getCurrentBranch, getStackCommits } from "../git/index.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { formatStackView, formatValidationError } from "../ui/format.ts";

export async function viewCommand(ctx: SpryContext): Promise<void> {
  const config = await loadConfig(ctx.git);
  const branch = await getCurrentBranch(ctx.git);
  const ref = trunkRef(config);
  const commits = await getStackCommits(ctx.git, ref);
  const withTrailers = await parseCommitTrailers(commits, ctx.git);
  const result = parseStack(withTrailers);

  if (!result.ok) {
    console.error(formatValidationError(result));
    process.exit(1);
  }

  console.log(formatStackView(result.units, branch, commits.length, ref));
}
