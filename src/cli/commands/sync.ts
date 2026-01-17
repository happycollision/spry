import { requireCleanWorkingTree, DirtyWorkingTreeError } from "../../git/status.ts";
import {
  injectMissingIds,
  getConflictInfo,
  formatConflictError,
  rebaseOntoMain,
} from "../../git/rebase.ts";
import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import {
  isStackBehindMain,
  getCommitsBehind,
  getLocalMainStatus,
  fastForwardLocalMain,
} from "../../git/behind.ts";
import { parseStack } from "../../core/stack.ts";
import { formatValidationError } from "../output.ts";
import {
  getDefaultBranch,
  DependencyError,
  GitHubAuthError,
  ConfigurationError,
  requireGitHubOrigin,
  NonGitHubOriginError,
} from "../../github/api.ts";
import { getBranchNameConfig, getBranchName, pushBranch } from "../../github/branches.ts";
import { getSpryConfig, isTempCommit } from "../../git/config.ts";
import {
  findPRsByBranches,
  createPR,
  deleteRemoteBranch,
  getPRBaseBranch,
  retargetPR,
  updatePRBody,
  type PRInfo,
} from "../../github/pr.ts";
import { asserted } from "../../utils/assert.ts";
import { getAllSyncStatuses, getSyncSummary, hasChanges } from "../../git/remote.ts";
import type { PRUnit, CommitInfo } from "../../types.ts";
import {
  parseApplySpec,
  resolveIdentifiers,
  resolveUpTo,
  formatResolutionError,
} from "../../core/identifier.ts";
import {
  readGroupTitles,
  fetchGroupTitles,
  pushGroupTitles,
  purgeOrphanedTitles,
} from "../../git/group-titles.ts";
import {
  readStackSettings,
  setContentHashes,
  pushStackSettings,
  fetchStackSettings,
  purgeOrphanedSettings,
} from "../../git/stack-settings.ts";
import {
  findPRTemplate,
  generateInitialPRBody,
  generateBodyContent,
  generateStackLinksContent,
  generateUpdatedPRBody,
  calculateContentHash,
  type StackPRInfo,
} from "../../github/pr-body.ts";
import { openSelect, type OpenSelectOption } from "../../tui/open-select.ts";
import { isTTY } from "../../tui/terminal.ts";
import { resolveUnitTitle, hasStoredTitle } from "../../core/title.ts";

export interface SyncOptions {
  open?: boolean;
  apply?: string;
  upTo?: string;
  interactive?: boolean;
  allowUntitledPr?: boolean;
}

interface MergedPRInfo {
  unit: PRUnit;
  pr: PRInfo;
  branchName: string;
}

/**
 * Find merged PRs in the stack and clean up their remote branches.
 * Returns units that are NOT merged (i.e., still active), along with a map of open PR info.
 * Also retargets any open PRs that were based on the merged branches.
 */
async function cleanupMergedPRs(
  units: PRUnit[],
  branchConfig: Awaited<ReturnType<typeof getBranchNameConfig>>,
  defaultBranch: string,
): Promise<{
  activeUnits: PRUnit[];
  cleanedUp: MergedPRInfo[];
  openPRMap: Map<string, PRInfo | null>;
}> {
  const merged: MergedPRInfo[] = [];
  const active: { unit: PRUnit; pr: PRInfo | null; branchName: string }[] = [];

  // Batch fetch all PR info in a single API call
  const branchNames = units.map((u) => getBranchName(u.id, branchConfig));
  const prMap = await findPRsByBranches(branchNames, { includeAll: true });

  for (const unit of units) {
    const branchName = getBranchName(unit.id, branchConfig);
    const pr = prMap.get(branchName) ?? null;

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

  // Build map of open PRs for active units (reuse data from batch fetch)
  const openPRMap = new Map<string, PRInfo | null>();
  for (const { branchName, pr } of active) {
    // Only include open PRs (not closed/merged) for downstream use
    openPRMap.set(branchName, pr?.state === "OPEN" ? pr : null);
  }

  return { activeUnits: active.map((a) => a.unit), cleanedUp: merged, openPRMap };
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  try {
    // If --open is requested, verify this is a GitHub repository
    if (options.open) {
      await requireGitHubOrigin();
    }

    // Check for ongoing rebase conflict
    const conflict = await getConflictInfo();
    if (conflict) {
      console.error(formatConflictError(conflict));
      process.exit(1);
    }

    // Check for uncommitted changes
    await requireCleanWorkingTree();

    // Fetch from remote to get latest state
    // isStackBehindMain fetches as a side effect
    const behindMain = await isStackBehindMain();
    const commitsBehind = behindMain ? await getCommitsBehind() : 0;

    // Try to fast-forward local main if it's behind origin
    const localMainStatus = await getLocalMainStatus();
    if (localMainStatus.canFastForward) {
      await fastForwardLocalMain();
      const config = await getSpryConfig();
      console.log(
        `✓ Fast-forwarded local ${config.defaultBranch} (${localMainStatus.commitsBehind} commit(s))`,
      );
    } else if (localMainStatus.isBehind && !localMainStatus.canFastForward) {
      const config = await getSpryConfig();
      console.log(
        `⚠ Local ${config.defaultBranch} is ${localMainStatus.commitsBehind} commit(s) behind but has ${localMainStatus.commitsAhead} local commit(s)`,
      );
    }

    // If stack is behind origin/main, rebase onto it
    if (behindMain) {
      console.log(`Rebasing onto latest (${commitsBehind} commit(s) behind)...`);
      const rebaseResult = await rebaseOntoMain();
      if (!rebaseResult.success) {
        // Rebase failed with conflict - getConflictInfo will detect this on next run
        console.error("");
        console.error(`✗ Rebase conflict in: ${rebaseResult.conflictFile}`);
        console.error("");
        console.error("To resolve:");
        console.error("  1. Edit the conflicting files");
        console.error("  2. git add <fixed files>");
        console.error("  3. git rebase --continue");
        console.error("  4. sp sync");
        console.error("");
        console.error("To abort:");
        console.error("  git rebase --abort");
        process.exit(1);
      }
      console.log(`✓ Rebased ${rebaseResult.commitCount} commit(s) onto latest`);
    }

    // Fetch group titles and stack settings from remote at start of sync
    await Promise.all([fetchGroupTitles(), fetchStackSettings()]);

    // Get commits and check which need IDs
    let commits = await getStackCommitsWithTrailers();

    if (commits.length === 0) {
      console.log("✓ No commits in stack");
      return;
    }

    const missingCount = commits.filter((c) => !c.trailers["Spry-Commit-Id"]).length;

    if (missingCount > 0) {
      // Add IDs via rebase
      console.log(`Adding IDs to ${missingCount} commit(s)...`);
      const result = await injectMissingIds();
      console.log(`✓ Added Spry-Commit-Id to ${result.modifiedCount} commit(s)`);

      // Re-fetch commits after rebase (hashes changed)
      commits = await getStackCommitsWithTrailers();
    } else {
      console.log("✓ All commits have Spry-Commit-Id");
    }

    // Read group titles from ref storage
    const groupTitles = await readGroupTitles();

    // Parse and validate the stack
    const stackResult = parseStack(commits, groupTitles);
    if (!stackResult.ok) {
      console.error(formatValidationError(stackResult));
      process.exit(1);
    }

    const units = stackResult.units;

    // Purge orphaned titles and settings (for groups/units that no longer exist)
    const currentGroupIds = units.filter((u) => u.type === "group").map((u) => u.id);
    const allUnitIds = units.map((u) => u.id);
    await Promise.all([purgeOrphanedTitles(currentGroupIds), purgeOrphanedSettings(allUnitIds)]);
    if (units.length === 0) {
      console.log("✓ No changes to sync");
      return;
    }

    // Get branch config and default branch
    const branchConfig = await getBranchNameConfig();
    const defaultBranch = await getDefaultBranch();

    // Check for merged PRs and clean them up
    // Also returns openPRMap with PR status for active units (fetched in batch)
    if (isTTY()) process.stdout.write("Fetching PR status...");
    const { activeUnits, cleanedUp, openPRMap } = await cleanupMergedPRs(
      units,
      branchConfig,
      defaultBranch,
    );
    if (isTTY()) process.stdout.write("\r\x1b[K"); // Clear the line

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
    if (isTTY()) process.stdout.write("Checking branch status...");
    const syncStatuses = await getAllSyncStatuses(activeUnits, branchConfig);
    if (isTTY()) process.stdout.write("\r\x1b[K"); // Clear the line
    const summary = getSyncSummary(syncStatuses);

    // When --open is specified, we need to check for missing PRs even if branches are up-to-date
    const needsPRCheck = options.open && activeUnits.length > 0;

    if (!hasChanges(syncStatuses) && !needsPRCheck) {
      console.log("✓ All branches up to date");
      return;
    }

    // Get spry config and PR template
    const spryConfig = await getSpryConfig();
    const prTemplate = spryConfig.includePrTemplate ? await findPRTemplate() : undefined;

    // Read existing stack settings for content hash tracking
    const stackSettings = await readStackSettings();

    // Validate mutually exclusive options
    const selectorCount = [options.apply, options.upTo, options.interactive].filter(Boolean).length;
    if (selectorCount > 1) {
      console.error("✗ Error: --apply, --up-to, and --interactive are mutually exclusive");
      process.exit(1);
    }

    // These options require --open
    if ((options.apply || options.upTo || options.interactive) && !options.open) {
      console.error("✗ Error: --apply, --up-to, and --interactive require --open flag");
      process.exit(1);
    }

    // Parse --apply, --up-to, or run interactive selection to get set of units to open PRs for
    let applyUnitIds: Set<string> | null = null;

    if (options.apply) {
      try {
        const identifiers = parseApplySpec(options.apply);
        const { unitIds, errors } = resolveIdentifiers(
          identifiers,
          activeUnits,
          commits as CommitInfo[],
        );

        if (errors.length > 0) {
          for (const error of errors) {
            console.error(formatResolutionError(error));
          }
          process.exit(1);
        }

        applyUnitIds = unitIds;
      } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    } else if (options.upTo) {
      const result = resolveUpTo(options.upTo, activeUnits, commits as CommitInfo[]);
      if (!result.ok) {
        console.error(formatResolutionError(result.error));
        process.exit(1);
      }
      applyUnitIds = result.unitIds;
    } else if (options.interactive) {
      // Build options for interactive selection using cached PR data
      const selectOptions: OpenSelectOption[] = [];
      for (const unit of activeUnits) {
        const headBranch = getBranchName(unit.id, branchConfig);
        const existingPR = openPRMap.get(headBranch) ?? null;
        const unitTitle = resolveUnitTitle(unit);
        const isTemp = isTempCommit(unitTitle, spryConfig.tempCommitPrefixes);

        selectOptions.push({
          id: unit.id,
          label: unitTitle,
          shortId: unit.id.slice(0, 8),
          hasPR: existingPR !== null,
          prNumber: existingPR?.number,
          isTemp,
        });
      }

      const result = await openSelect(selectOptions);
      if (result.cancelled) {
        console.log("Cancelled.");
        return;
      }

      applyUnitIds = new Set(result.selectedIds);
    }

    // Push branches and track PR status
    let baseBranch = defaultBranch;
    const created: PRInfo[] = [];
    const updated: PRInfo[] = [];
    const skippedNoPR: string[] = [];
    const skippedTemp: string[] = [];
    const skippedByApply: string[] = [];
    let pushedCount = 0;

    // Track all PRs in the stack for second-pass body updates
    // Maps unit ID to { prNumber, index }
    const prsByUnitId = new Map<string, { prNumber: number; index: number }>();

    // Build unit index lookup (position in stack, 0 = oldest)
    const unitIndexMap = new Map<string, number>();
    activeUnits.forEach((unit, idx) => unitIndexMap.set(unit.id, idx));

    // Track which units need body updates in the second pass
    const unitsNeedingBodyUpdate: { unit: PRUnit; prNumber: number; isNew: boolean }[] = [];

    // Find the highest unit index that will have a PR (existing or to-be-created)
    // We only need to push branches up to this point - anything beyond is unnecessary
    let highestPRUnitIndex = -1;
    for (let i = 0; i < activeUnits.length; i++) {
      const unit = asserted(activeUnits[i]);
      const headBranch = getBranchName(unit.id, branchConfig);
      const existingPR = openPRMap.get(headBranch) ?? null;
      const unitTitle = resolveUnitTitle(unit);
      const isTemp = isTempCommit(unitTitle, spryConfig.tempCommitPrefixes);

      // This unit will have a PR if:
      // 1. It already has one, OR
      // 2. --open is set AND it's not temp AND (no applyUnitIds filter OR it's in the filter)
      const willHavePR =
        existingPR !== null ||
        (options.open && !isTemp && (!applyUnitIds || applyUnitIds.has(unit.id)));

      if (willHavePR) {
        highestPRUnitIndex = i;
      }
    }

    for (let unitIdx = 0; unitIdx < activeUnits.length; unitIdx++) {
      const unit = asserted(activeUnits[unitIdx]);
      const headBranch = getBranchName(unit.id, branchConfig);
      const headCommit = asserted(unit.commits.at(-1));
      const status = asserted(syncStatuses.get(unit.id));
      const unitTitle = resolveUnitTitle(unit);

      // Use cached PR data from cleanupMergedPRs batch fetch
      const existingPR = openPRMap.get(headBranch) ?? null;

      // Only push if this unit is at or below the highest unit with a PR:
      // 1. PR exists and needs update, OR
      // 2. --open is specified AND unit is within the PR boundary (at or below highest PR)
      const withinPRBoundary = unitIdx <= highestPRUnitIndex;
      const shouldPush =
        (existingPR && status.needsUpdate) ||
        (options.open && withinPRBoundary && (status.needsCreate || status.needsUpdate));

      if (shouldPush) {
        await pushBranch(headCommit, headBranch, status.needsUpdate);
        pushedCount++;
      }

      if (existingPR) {
        // Track existing PR for body updates
        const unitIndex = unitIndexMap.get(unit.id) ?? 0;
        prsByUnitId.set(unit.id, { prNumber: existingPR.number, index: unitIndex });

        if (status.needsUpdate) {
          // Existing PR was updated by the push - may need body update too
          updated.push(existingPR);
          unitsNeedingBodyUpdate.push({ unit, prNumber: existingPR.number, isNew: false });
        }
      } else if (options.open) {
        // Check if this is a temp commit (WIP, fixup!, etc.)
        if (isTempCommit(unitTitle, spryConfig.tempCommitPrefixes)) {
          // Skip PR creation for temp commits, but branch was already pushed for stacking
          skippedTemp.push(unitTitle);
        } else if (applyUnitIds && !applyUnitIds.has(unit.id)) {
          // Skip PR creation if --apply is specified and this unit is not in the list
          // Branch was still pushed for stacking
          skippedByApply.push(unitTitle);
        } else {
          // Validate that groups have stored titles before creating PRs
          if (unit.type === "group" && !hasStoredTitle(unit) && !options.allowUntitledPr) {
            console.error("");
            console.error(`✗ Error: Group "${unit.id}" has no stored title`);
            console.error("");
            console.error("  Set a title using: sp group");
            console.error("  Or allow fallback: sp sync --open --allow-untitled-pr");
            process.exit(1);
          }

          // Create new PR (--open is specified and no PR exists)
          // Generate initial body without stack links (will be added in second pass)
          const unitIndex = unitIndexMap.get(unit.id) ?? 0;
          const body = generateInitialPRBody({
            unit,
            commits: commits as CommitInfo[],
            prTemplate,
            prTemplateLocation: spryConfig.prTemplateLocation,
            showStackLinks: false, // Stack links added in second pass
          });

          if (isTTY()) {
            process.stdout.write(`Creating PR for "${unitTitle}"...`);
          } else {
            process.stdout.write(`Creating PR for "${unitTitle}"... `);
          }
          const pr = await createPR({
            title: unitTitle,
            head: headBranch,
            base: baseBranch,
            body,
          });
          if (isTTY()) {
            process.stdout.write("\r\x1b[K"); // Clear the line
          } else {
            console.log(`#${pr.number}`);
          }

          created.push({ ...pr, state: "OPEN", title: unitTitle });
          prsByUnitId.set(unit.id, { prNumber: pr.number, index: unitIndex });
          unitsNeedingBodyUpdate.push({ unit, prNumber: pr.number, isNew: true });
        }
      } else if (status.needsCreate) {
        // No PR and --open not specified - don't push, just track
        skippedNoPR.push(unitTitle);
      }

      // Next PR bases on this branch (use local branch name for stacking context)
      baseBranch = headBranch;
    }

    // Second pass: Update PR bodies with stack links (if enabled and we have multiple PRs)
    const shouldUpdateBodies = spryConfig.showStackLinks && prsByUnitId.size > 1;
    const newContentHashes: Record<string, string> = {};

    if (shouldUpdateBodies && unitsNeedingBodyUpdate.length > 0) {
      // Build stack PR info for all PRs in the stack
      const stackPRs: StackPRInfo[] = [];
      for (const [_unitId, info] of prsByUnitId) {
        stackPRs.push({ prNumber: info.prNumber, index: info.index });
      }

      for (const { unit, prNumber, isNew } of unitsNeedingBodyUpdate) {
        const unitIndex = unitIndexMap.get(unit.id) ?? 0;
        const bodyContent = generateBodyContent(unit, commits as CommitInfo[]);
        const stackLinksContent = generateStackLinksContent(stackPRs, unitIndex, defaultBranch);
        const contentHash = calculateContentHash(bodyContent, stackLinksContent);

        // Check if content has changed (skip update if hash matches)
        const existingHash = stackSettings.contentHashes[unit.id];
        if (!isNew && existingHash === contentHash) {
          // Content hasn't changed, skip update
          continue;
        }

        // Get existing PR body and generate updated body
        const existingBody = isNew
          ? generateInitialPRBody({
              unit,
              commits: commits as CommitInfo[],
              prTemplate,
              prTemplateLocation: spryConfig.prTemplateLocation,
              showStackLinks: false,
            })
          : (openPRMap.get(getBranchName(unit.id, branchConfig))?.body ?? "");

        const updatedBody = generateUpdatedPRBody({
          existingBody,
          bodyContent,
          stackLinksContent,
          showStackLinks: true,
        });

        await updatePRBody(prNumber, updatedBody);
        newContentHashes[unit.id] = contentHash;
      }

      // Save content hashes for change detection
      if (Object.keys(newContentHashes).length > 0) {
        await setContentHashes(newContentHashes);
      }
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
      console.log(`  See: https://github.com/happycollision/spry-cli#temporary-commits`);
    }

    if (skippedByApply.length > 0) {
      console.log(`✓ ${skippedByApply.length} branch(es) pushed without PR (not in --apply list)`);
    }

    if (summary.upToDate > 0 && pushedCount === 0 && skippedNoPR.length === 0) {
      console.log(`✓ ${summary.upToDate} branch(es) already up to date`);
    }

    // Push group titles and stack settings to remote at end of sync
    await Promise.all([pushGroupTitles(), pushStackSettings()]);
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
      console.error("    sp sync          # Run sync");
      console.error("    git stash pop    # Restore changes");
      process.exit(1);
    }

    if (error instanceof NonGitHubOriginError) {
      console.error(`✗ ${error.message}`);
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
