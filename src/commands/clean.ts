import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef } from "../git/index.ts";
import { deleteRemoteBranch } from "../gh/index.ts";
import type { DeleteRemoteBranchResult } from "../gh/index.ts";

export interface CleanOptions {
  cwd?: string;
  dryRun?: boolean;
  /**
   * Injected for testability; defaults to a real `git push --delete`. Takes the
   * remote branch name (e.g. `spry/me/feature`) and reports success or failure.
   */
  deleteBranch?: (branch: string) => Promise<DeleteRemoteBranchResult>;
}

// Deleting a ref that is already gone upstream (enumerate-then-vanish race, or a
// stale tracking ref that survived even a pruning fetch) is benign — the branch
// is already in the state we want. git's message for this is
// `error: unable to delete '<name>': remote ref does not exist`.
const ALREADY_GONE = /remote ref does not exist/i;

/**
 * Delete remote spry branches whose commits have landed on trunk.
 *
 * "Landed" is defined deterministically: a branch's tip commit is an ancestor
 * of `<remote>/<trunk>`. This is the simple reaper — it does NOT attempt
 * patch-id / cherry detection, Spry-Commit-Id trailer matching, or squash/rebase
 * merge detection. Ancestor-of-trunk only.
 */
export async function cleanCommand(ctx: SpryContext, opts: CleanOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });

  // 1. Fetch with --prune so remote-tracking refs and objects are local AND
  //    refs deleted upstream are dropped. clean enumerates the tracking refs as
  //    its source of truth, so a stale ref would otherwise make us try to delete
  //    a branch that no longer exists. (We prune here rather than touching the
  //    shared fetchRemote in src/git/behind.ts, which `sp rebase` relies on.)
  const fetchResult = await ctx.git.run(["fetch", "--prune", config.remote], { cwd });
  if (fetchResult.exitCode !== 0) {
    console.error(`✗ Could not fetch from ${config.remote}: ${fetchResult.stderr.trim()}`);
    process.exit(1);
  }

  const ref = trunkRef(config);

  // 2. Enumerate remote-tracking branches under <remote>/<branchPrefix>/* and
  //    keep those whose tip is an ancestor of trunk.
  const trackingPrefix = `refs/remotes/${config.remote}/`;
  const searchPath = `${trackingPrefix}${config.branchPrefix}/`;
  const forEach = await ctx.git.run(
    ["for-each-ref", "--format=%(refname) %(objectname)", searchPath],
    { cwd },
  );
  if (forEach.exitCode !== 0) {
    console.error(`✗ Could not list remote branches: ${forEach.stderr.trim()}`);
    process.exit(1);
  }

  const landed: string[] = [];
  for (const line of forEach.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space === -1) continue;
    const refname = trimmed.slice(0, space);
    const tip = trimmed.slice(space + 1);
    const branch = refname.slice(trackingPrefix.length);

    const ancestor = await ctx.git.run(["merge-base", "--is-ancestor", tip, ref], { cwd });
    if (ancestor.exitCode === 0) {
      landed.push(branch);
    }
  }

  if (landed.length === 0) {
    console.log("✓ No landed branches to clean");
    return;
  }

  // 3. Dry-run: report what would be deleted, touch nothing.
  if (opts.dryRun) {
    const n = landed.length;
    console.log(`Would delete ${n} landed branch${n === 1 ? "" : "es"}:`);
    for (const branch of landed) {
      console.log(kleur.dim(`  ${branch}`));
    }
    console.log(kleur.dim("Run `sp clean` to delete them."));
    return;
  }

  // 4. Delete each landed branch from the remote. A failed delete warns and
  //    continues — one bad branch must not abort the whole sweep. An
  //    "already gone" failure is benign and does not fail the command.
  const deleteBranch =
    opts.deleteBranch ??
    ((branch: string) => deleteRemoteBranch(ctx.git, { cwd, remote: config.remote, branch }));

  let deleted = 0;
  let hadFailure = false;
  for (const branch of landed) {
    const result = await deleteBranch(branch);
    if (result.ok) {
      console.log(`✓ Deleted ${branch}`);
      deleted++;
    } else if (ALREADY_GONE.test(result.stderr)) {
      console.log(kleur.dim(`  ${branch} already gone`));
    } else {
      console.error(`✗ Could not delete ${branch}: ${result.stderr.trim()}`);
      hadFailure = true;
    }
  }

  if (deleted > 0) {
    console.log(kleur.dim(`Cleaned ${deleted} landed branch${deleted === 1 ? "" : "es"}.`));
  }
  if (hadFailure) {
    process.exit(1);
  }
}
