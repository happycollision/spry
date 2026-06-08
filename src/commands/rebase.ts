import type { SpryContext } from "../lib/context.ts";
import {
  loadConfig,
  trunkRef,
  getStackCommits,
  getStackCommitsForBranch,
  getCurrentBranch,
  getFullSha,
  getCommitMessage,
  updateRef,
} from "../git/index.ts";
import { isDetachedHead } from "../git/queries.ts";
import { requireCleanWorkingTree } from "../git/status.ts";
import { rebasePlumbing, finalizeRewrite } from "../git/plumbing.ts";
import { parseConflictOutput } from "../git/conflict.ts";
import { fetchRemote, isStackBehindTrunk, isStackBehindTrunkForBranch } from "../git/behind.ts";
import {
  registerBranch,
  loadTrackedBranches,
  saveTrackedBranches,
} from "../git/tracked-branches.ts";
import type { SpryConfig } from "../git/config.ts";

export interface RebaseOptions {
  cwd?: string;
  all?: boolean;
}

export async function rebaseCommand(ctx: SpryContext, opts: RebaseOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });

  if (opts.all) {
    return rebaseAllCommand(ctx, config, cwd);
  }

  // --- single-branch path ---

  if (await isDetachedHead(ctx.git, { cwd })) {
    console.error("✗ Cannot rebase from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }

  await requireCleanWorkingTree(ctx.git, { cwd });

  const branch = await getCurrentBranch(ctx.git, { cwd });
  await registerBranch(ctx.git, branch, { cwd });

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
  const oldTip = commitHashes.at(-1) ?? "";
  await finalizeRewrite(ctx.git, branch, oldTip, result.newTip, { cwd });

  const n = commits.length;
  console.log(`✓ Rebased ${n} commit${n === 1 ? "" : "s"} onto ${config.trunk}`);
}

async function rebaseAllCommand(
  ctx: SpryContext,
  config: SpryConfig,
  cwd: string | undefined,
): Promise<void> {
  await requireCleanWorkingTree(ctx.git, { cwd });

  const fetchResult = await fetchRemote(ctx.git, config.remote, { cwd });
  if (!fetchResult.ok) {
    console.error(`✗ Could not fetch from ${config.remote}: ${fetchResult.stderr.trim()}`);
    process.exit(1);
  }

  // Register current branch (unless detached), then load full tracked list
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

  const ref = trunkRef(config);
  const stillTracked: string[] = [];
  let hadFailure = false;

  for (const branch of tracked) {
    // Check if branch still exists locally
    const revParse = await ctx.git.run(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd });
    if (revParse.exitCode !== 0) {
      console.log(`${branch}: removed (branch no longer exists)`);
      continue;
    }

    stillTracked.push(branch);

    const behind = await isStackBehindTrunkForBranch(ctx.git, branch, ref, { cwd });
    if (!behind) {
      console.log(`${branch}: ✓ already up to date`);
      continue;
    }

    const commits = await getStackCommitsForBranch(ctx.git, branch, ref, { cwd });
    if (commits.length === 0) {
      console.log(`${branch}: ✓ no commits in stack`);
      continue;
    }

    const ontoSha = await getFullSha(ctx.git, ref, { cwd });
    const commitHashes = commits.map((c) => c.hash);
    const result = await rebasePlumbing(ctx.git, ontoSha, commitHashes, { cwd });

    if (!result.ok) {
      const parsed = parseConflictOutput(result.conflictInfo);
      const shortSha = result.conflictCommit.slice(0, 8);
      const msg = await getCommitMessage(ctx.git, result.conflictCommit, { cwd });
      const subject = msg.split("\n")[0] ?? result.conflictCommit;
      console.error(`${branch}: ✗ Rebase would conflict on commit ${shortSha}: ${subject}`);
      if (parsed.files.length > 0) {
        for (const f of parsed.files) {
          console.error(`  - ${f}`);
        }
      }
      hadFailure = true;
      continue;
    }

    const oldTip = commitHashes.at(-1) ?? "";
    if (branch === currentBranch) {
      await finalizeRewrite(ctx.git, branch, oldTip, result.newTip, { cwd });
    } else {
      await updateRef(ctx.git, `refs/heads/${branch}`, result.newTip, oldTip, { cwd });
    }

    const n = commits.length;
    console.log(`${branch}: ✓ Rebased ${n} commit${n === 1 ? "" : "s"} onto ${config.trunk}`);
  }

  await saveTrackedBranches(ctx.git, stillTracked, { cwd });

  if (hadFailure) {
    process.exit(1);
  }
}
