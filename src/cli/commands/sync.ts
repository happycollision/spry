import { requireCleanWorkingTree, DirtyWorkingTreeError } from "../../git/status.ts";
import { injectMissingIds } from "../../git/rebase.ts";
import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import {
  getDefaultBranch,
  DependencyError,
  GitHubAuthError,
  ConfigurationError,
} from "../../github/api.ts";
import { getBranchNameConfig, getBranchName, pushBranch } from "../../github/branches.ts";
import { findPRByBranch, createPR, type PRInfo } from "../../github/pr.ts";
import { asserted } from "../../utils/assert.ts";
import { getAllSyncStatuses, getSyncSummary, hasChanges } from "../../git/remote.ts";

export interface SyncOptions {
  open?: boolean;
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  try {
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
      console.error(`✗ Stack validation error: ${stackResult.error}`);
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

    // Check what needs syncing
    const syncStatuses = await getAllSyncStatuses(units, branchConfig);
    const summary = getSyncSummary(syncStatuses);

    // When --open is specified, we need to check for missing PRs even if branches are up-to-date
    const needsPRCheck = options.open && units.length > 0;

    if (!hasChanges(syncStatuses) && !needsPRCheck) {
      console.log("✓ All branches up to date");
      return;
    }

    // Push branches and track PR status
    let baseBranch = defaultBranch;
    const created: PRInfo[] = [];
    const updated: PRInfo[] = [];
    const skippedNoPR: string[] = [];

    const totalToPush = summary.toCreate + summary.toUpdate;
    if (totalToPush > 0) {
      console.log(`\nPushing ${totalToPush} branch(es)...`);
    }

    for (const unit of units) {
      const headBranch = getBranchName(unit.id, branchConfig);
      const headCommit = asserted(unit.commits.at(-1));
      const status = asserted(syncStatuses.get(unit.id));

      // Only push if needed
      if (status.needsCreate || status.needsUpdate) {
        await pushBranch(headCommit, headBranch, status.needsUpdate);
      }

      // Check for existing PR
      const existingPR = await findPRByBranch(headBranch);

      if (existingPR) {
        if (status.needsUpdate) {
          // Existing PR was updated by the push
          updated.push(existingPR);
        }
      } else if (options.open) {
        // Create new PR (--open is specified and no PR exists)
        const pr = await createPR({
          title: unit.title,
          head: headBranch,
          base: baseBranch,
        });
        created.push({ ...pr, state: "OPEN", title: unit.title });
      } else if (status.needsCreate) {
        // No PR and --open not specified
        skippedNoPR.push(unit.title);
      }

      // Next PR bases on this branch
      baseBranch = headBranch;
    }

    // Report results
    console.log("");

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
      console.log(`✓ ${skippedNoPR.length} branch(es) pushed without PR (use --open to create)`);
    }

    if (summary.upToDate > 0) {
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
