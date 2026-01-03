import { requireCleanWorkingTree, DirtyWorkingTreeError } from "../../git/status.ts";
import { injectMissingIds, getConflictInfo, formatConflictError } from "../../git/rebase.ts";
import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import { formatValidationError } from "../output.ts";
import {
  getDefaultBranch,
  DependencyError,
  GitHubAuthError,
  ConfigurationError,
} from "../../github/api.ts";
import { getBranchNameConfig, getBranchName, pushBranch } from "../../github/branches.ts";
import { getTasprConfig, isTempCommit } from "../../git/config.ts";
import {
  findPRByBranch,
  createPR,
  deleteRemoteBranch,
  getPRBaseBranch,
  retargetPR,
  type PRInfo,
} from "../../github/pr.ts";
import { asserted } from "../../utils/assert.ts";
import { getAllSyncStatuses, getSyncSummary, hasChanges } from "../../git/remote.ts";
import type { PRUnit } from "../../types.ts";

export interface SyncOptions {
  open?: boolean;
}

interface MergedPRInfo {
  unit: PRUnit;
  pr: PRInfo;
  branchName: string;
}

/**
 * Find merged PRs in the stack and clean up their remote branches.
 * Returns units that are NOT merged (i.e., still active).
 * Also retargets any open PRs that were based on the merged branches.
 */
async function cleanupMergedPRs(
  units: PRUnit[],
  branchConfig: Awaited<ReturnType<typeof getBranchNameConfig>>,
  defaultBranch: string,
): Promise<{ activeUnits: PRUnit[]; cleanedUp: MergedPRInfo[] }> {
  const merged: MergedPRInfo[] = [];
  const active: { unit: PRUnit; pr: PRInfo | null; branchName: string }[] = [];

  for (const unit of units) {
    const branchName = getBranchName(unit.id, branchConfig);
    // Use includeAll to find merged PRs (gh pr list defaults to open only)
    const pr = await findPRByBranch(branchName, { includeAll: true });

    if (pr?.state === "MERGED") {
      merged.push({ unit, pr, branchName });
    } else {
      active.push({ unit, pr, branchName });
    }
  }

  if (merged.length > 0) {
    // Build set of merged branch names for quick lookup
    const mergedBranchNames = new Set(merged.map((m) => m.branchName));

    // Retarget any open PRs that are based on merged branches
    for (const { pr } of active) {
      if (pr?.state === "OPEN") {
        try {
          const baseBranch = await getPRBaseBranch(pr.number);
          if (mergedBranchNames.has(baseBranch)) {
            console.log(`Retargeting PR #${pr.number} to ${defaultBranch}...`);
            await retargetPR(pr.number, defaultBranch);
          }
        } catch {
          // Ignore errors - PR might already be retargeted or closed
        }
      }
    }

    // Now safe to delete remote branches for merged PRs
    for (const { branchName } of merged) {
      await deleteRemoteBranch(branchName);
    }
  }

  return { activeUnits: active.map((a) => a.unit), cleanedUp: merged };
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  try {
    // Check for ongoing rebase conflict
    const conflict = await getConflictInfo();
    if (conflict) {
      console.error(formatConflictError(conflict));
      process.exit(1);
    }

    // Check for uncommitted changes
    await requireCleanWorkingTree();

    // Get commits and check which need IDs
    let commits = await getStackCommitsWithTrailers();

    if (commits.length === 0) {
      console.log("✓ No commits in stack");
      return;
    }

    const missingCount = commits.filter((c) => !c.trailers["Taspr-Commit-Id"]).length;

    if (missingCount > 0) {
      // Add IDs via rebase
      console.log(`Adding IDs to ${missingCount} commit(s)...`);
      const result = await injectMissingIds();
      console.log(`✓ Added Taspr-Commit-Id to ${result.modifiedCount} commit(s)`);

      // Re-fetch commits after rebase (hashes changed)
      commits = await getStackCommitsWithTrailers();
    } else {
      console.log("✓ All commits have Taspr-Commit-Id");
    }

    // Parse and validate the stack
    const stackResult = parseStack(commits);
    if (!stackResult.ok) {
      console.error(formatValidationError(stackResult));
      process.exit(1);
    }

    const units = stackResult.units;
    if (units.length === 0) {
      console.log("✓ No changes to sync");
      return;
    }

    // Get branch config and default branch
    const branchConfig = await getBranchNameConfig();
    const defaultBranch = await getDefaultBranch();

    // Check for merged PRs and clean them up
    const { activeUnits, cleanedUp } = await cleanupMergedPRs(units, branchConfig, defaultBranch);

    if (cleanedUp.length > 0) {
      console.log(`✓ Cleaned up ${cleanedUp.length} merged PR(s):`);
      for (const { pr } of cleanedUp) {
        console.log(`  #${pr.number} ${pr.title}`);
      }
    }

    if (activeUnits.length === 0) {
      console.log("✓ No active PRs to sync");
      return;
    }

    // Check what needs syncing (only for non-merged units)
    const syncStatuses = await getAllSyncStatuses(activeUnits, branchConfig);
    const summary = getSyncSummary(syncStatuses);

    // When --open is specified, we need to check for missing PRs even if branches are up-to-date
    const needsPRCheck = options.open && activeUnits.length > 0;

    if (!hasChanges(syncStatuses) && !needsPRCheck) {
      console.log("✓ All branches up to date");
      return;
    }

    // Get temp commit prefixes for skipping PR creation
    const tasprConfig = await getTasprConfig();

    // Push branches and track PR status
    let baseBranch = defaultBranch;
    const created: PRInfo[] = [];
    const updated: PRInfo[] = [];
    const skippedNoPR: string[] = [];
    const skippedTemp: string[] = [];
    let pushedCount = 0;

    for (const unit of activeUnits) {
      const headBranch = getBranchName(unit.id, branchConfig);
      const headCommit = asserted(unit.commits.at(-1));
      const status = asserted(syncStatuses.get(unit.id));

      // Check for existing PR first to decide whether to push
      const existingPR = await findPRByBranch(headBranch);

      // Only push if:
      // 1. PR exists and needs update, OR
      // 2. --open is specified (will create PR)
      const shouldPush =
        (existingPR && status.needsUpdate) ||
        (options.open && (status.needsCreate || status.needsUpdate));

      if (shouldPush) {
        await pushBranch(headCommit, headBranch, status.needsUpdate);
        pushedCount++;
      }

      if (existingPR) {
        if (status.needsUpdate) {
          // Existing PR was updated by the push
          updated.push(existingPR);
        }
      } else if (options.open) {
        // Check if this is a temp commit (WIP, fixup!, etc.)
        if (isTempCommit(unit.title, tasprConfig.tempCommitPrefixes)) {
          // Skip PR creation for temp commits, but branch was already pushed for stacking
          skippedTemp.push(unit.title);
        } else {
          // Create new PR (--open is specified and no PR exists)
          const pr = await createPR({
            title: unit.title,
            head: headBranch,
            base: baseBranch,
          });
          created.push({ ...pr, state: "OPEN", title: unit.title });
        }
      } else if (status.needsCreate) {
        // No PR and --open not specified - don't push, just track
        skippedNoPR.push(unit.title);
      }

      // Next PR bases on this branch (use local branch name for stacking context)
      baseBranch = headBranch;
    }

    // Report results
    console.log("");

    if (pushedCount > 0) {
      console.log(`✓ Pushed ${pushedCount} branch(es)`);
    }

    if (created.length > 0) {
      console.log(`✓ Created ${created.length} PR(s):`);
      for (const pr of created) {
        console.log(`  #${pr.number} ${pr.url}`);
      }
    }

    if (updated.length > 0) {
      console.log(`✓ Updated ${updated.length} PR(s)`);
    }

    if (skippedNoPR.length > 0) {
      console.log(`✓ ${skippedNoPR.length} commit(s) ready (use --open to create PRs)`);
    }

    if (skippedTemp.length > 0) {
      console.log(`⚠ Skipped PR for ${skippedTemp.length} temporary commit(s):`);
      for (const title of skippedTemp) {
        console.log(`  ${title}`);
      }
      console.log(`  See: https://github.com/happycollision/taspr#temporary-commits`);
    }

    if (summary.upToDate > 0 && pushedCount === 0 && skippedNoPR.length === 0) {
      console.log(`✓ ${summary.upToDate} branch(es) already up to date`);
    }
  } catch (error) {
    if (error instanceof DirtyWorkingTreeError) {
      console.error("✗ Error: Cannot sync with uncommitted changes");
      console.error("");
      console.error("  You have:");
      if (error.status.hasStagedChanges) {
        console.error("    • staged changes");
      }
      if (error.status.hasUnstagedChanges) {
        console.error("    • unstaged changes");
      }
      console.error("");
      console.error("  Please commit or stash your changes first:");
      console.error("    git stash        # Temporarily save changes");
      console.error("    taspr sync       # Run sync");
      console.error("    git stash pop    # Restore changes");
      process.exit(1);
    }

    if (error instanceof DependencyError) {
      console.error(`✗ Missing dependency:\n${error.message}`);
      process.exit(1);
    }

    if (error instanceof GitHubAuthError) {
      console.error(`✗ GitHub authentication error:\n${error.message}`);
      process.exit(1);
    }

    if (error instanceof ConfigurationError) {
      console.error(`✗ Configuration error:\n${error.message}`);
      process.exit(1);
    }

    if (error instanceof Error) {
      console.error(`✗ Error: ${error.message}`);
    } else {
      console.error("✗ An unexpected error occurred");
    }
    process.exit(1);
  }
}
