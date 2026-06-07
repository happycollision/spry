import type { SpryContext } from "../lib/context.ts";
import {
  loadConfig,
  trunkRef,
  getStackCommits,
  getCurrentBranch,
  getFullSha,
  getCommitMessage,
} from "../git/index.ts";
import { isDetachedHead } from "../git/queries.ts";
import { requireCleanWorkingTree } from "../git/status.ts";
import { rebasePlumbing, finalizeRewrite } from "../git/plumbing.ts";
import { parseConflictOutput } from "../git/conflict.ts";
import { fetchRemote, isStackBehindTrunk } from "../git/behind.ts";

export interface RebaseOptions {
  cwd?: string;
}

export async function rebaseCommand(ctx: SpryContext, opts: RebaseOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });

  if (await isDetachedHead(ctx.git, { cwd })) {
    console.error("✗ Cannot rebase from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }

  await requireCleanWorkingTree(ctx.git, { cwd });

  const ref = trunkRef(config);

  // 1. Fetch remote
  const fetchResult = await fetchRemote(ctx.git, config.remote, { cwd });
  if (!fetchResult.ok) {
    console.error(`✗ Could not fetch from ${config.remote}: ${fetchResult.stderr.trim()}`);
    process.exit(1);
  }

  // 2. Check if behind
  const behind = await isStackBehindTrunk(ctx.git, ref, { cwd });
  if (!behind) {
    console.log("✓ Already up to date");
    return;
  }

  // 3. Get stack commits
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  if (commits.length === 0) {
    console.log("✓ No commits in stack");
    return;
  }

  const ontoSha = await getFullSha(ctx.git, ref, { cwd });
  const commitHashes = commits.map((c) => c.hash);

  // 4. Dry-run: rebasePlumbing creates commit objects but does NOT update refs
  const result = await rebasePlumbing(ctx.git, ontoSha, commitHashes, { cwd });

  if (!result.ok) {
    const parsed = parseConflictOutput(result.conflictInfo);
    const shortSha = result.conflictCommit.slice(0, 8);
    const msg = await getCommitMessage(ctx.git, result.conflictCommit, { cwd });
    const subject = msg.split("\n")[0] ?? result.conflictCommit;

    console.error(`✗ Rebase would conflict on commit ${shortSha}: ${subject}`);
    if (parsed.files.length > 0) {
      console.error("");
      console.error("  Conflicting files:");
      for (const f of parsed.files) {
        console.error(`    - ${f}`);
      }
    }
    console.error("");
    console.error("  Resolve the upstream changes manually, then run `sp rebase` again.");
    console.error("  Or use `git rebase` for interactive conflict resolution.");
    process.exit(1);
  }

  // 5. Apply: update branch ref and working tree
  const branch = await getCurrentBranch(ctx.git, { cwd });
  const oldTip = commitHashes.at(-1) ?? "";
  await finalizeRewrite(ctx.git, branch, oldTip, result.newTip, { cwd });

  const n = commits.length;
  console.log(`✓ Rebased ${n} commit${n === 1 ? "" : "s"} onto ${config.trunk}`);
}
