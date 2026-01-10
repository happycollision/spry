import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import { formatValidationError } from "../output.ts";
import { getBranchNameConfig, getBranchName } from "../../github/branches.ts";
import { resolveUnitTitle } from "../../core/title.ts";
import {
  findPRsByBranches,
  landPR,
  deleteRemoteBranch,
  getPRMergeStatus,
  getPRBaseBranch,
  retargetPR,
  waitForPRState,
  PRNotFastForwardError,
  PRNotFoundError,
  PRNotReadyError,
} from "../../github/pr.ts";
import type { PRUnit, EnrichedPRUnit } from "../../types.ts";
import type { PRMergeStatus } from "../../github/pr.ts";

export interface LandCommandOptions {
  all?: boolean;
}

function getNotReadyReasons(status: PRMergeStatus): string[] {
  const reasons: string[] = [];
  if (status.checksStatus === "failing") {
    reasons.push("CI checks are failing");
  } else if (status.checksStatus === "pending") {
    reasons.push("CI checks are still running");
  }
  if (status.reviewDecision === "changes_requested") {
    reasons.push("Changes have been requested");
  } else if (status.reviewDecision === "review_required") {
    reasons.push("Review is required");
  }
  return reasons;
}

async function enrichUnitsWithPRInfo(units: PRUnit[]): Promise<EnrichedPRUnit[]> {
  const config = await getBranchNameConfig();

  // Build branch name lookup for all units
  const branchNames = units.map((unit) => getBranchName(unit.id, config));

  // Batch fetch all PRs in a single API call (open PRs only)
  const prMap = await findPRsByBranches(branchNames);

  // Enrich units with PR info
  return units.map((unit): EnrichedPRUnit => {
    const branchName = getBranchName(unit.id, config);
    const pr = prMap.get(branchName);

    if (pr) {
      return {
        ...unit,
        pr: {
          number: pr.number,
          url: pr.url,
          state: pr.state,
        },
      };
    }

    return unit;
  });
}

type EnrichedUnitWithPR = EnrichedPRUnit & { pr: NonNullable<EnrichedPRUnit["pr"]> };

/**
 * Land a single PR: merge and verify merged state on GitHub.
 * Caller is responsible for checking readiness beforehand.
 * Returns the branch name for later cleanup.
 */
async function landSinglePR(
  unit: EnrichedUnitWithPR,
  config: Awaited<ReturnType<typeof getBranchNameConfig>>,
): Promise<string> {
  console.log(`Merging PR #${unit.pr.number} (${resolveUnitTitle(unit)})...`);

  await landPR(unit.pr.number);

  // Verify PR is actually merged on GitHub before proceeding (wait up to 30s)
  const isMerged = await waitForPRState(unit.pr.number, "MERGED", 30000);
  if (!isMerged) {
    throw new Error(`PR #${unit.pr.number} was not marked as merged by GitHub after landing`);
  }

  console.log(`✓ Merged PR #${unit.pr.number} to main`);

  return getBranchName(unit.id, config);
}

export async function landCommand(options: LandCommandOptions = {}): Promise<void> {
  try {
    const commits = await getStackCommitsWithTrailers();

    if (commits.length === 0) {
      console.log("No commits in stack");
      return;
    }

    const result = parseStack(commits);

    if (!result.ok) {
      console.error(formatValidationError(result));
      process.exit(1);
    }

    const enrichedUnits = await enrichUnitsWithPRInfo(result.units);
    const config = await getBranchNameConfig();

    // Get all open PRs (bottom of stack is first in array)
    const openPRs = enrichedUnits.filter((u): u is EnrichedUnitWithPR => u.pr?.state === "OPEN");

    if (openPRs.length === 0) {
      console.log("No open PRs in stack");
      return;
    }

    // Snapshot merge status for all open PRs upfront
    // This ensures we only land PRs that were ready when we started
    const mergeStatusMap = new Map<number, PRMergeStatus>();
    await Promise.all(
      openPRs.map(async (unit) => {
        const status = await getPRMergeStatus(unit.pr.number);
        mergeStatusMap.set(unit.pr.number, status);
      }),
    );

    if (options.all) {
      // Land all consecutive ready PRs (based on snapshot)
      // We defer branch deletion until all PRs are merged so GitHub can auto-retarget
      const mergedBranches: string[] = [];

      for (let i = 0; i < openPRs.length; i++) {
        const unit = openPRs[i];
        if (!unit) continue;
        const nextUnit = openPRs[i + 1];
        const status = mergeStatusMap.get(unit.pr.number);

        if (!status?.isReady) {
          if (mergedBranches.length > 0) {
            console.log(`Stopping at PR #${unit.pr.number} (not ready)`);
          } else {
            const reasons = status ? getNotReadyReasons(status) : ["Unknown status"];
            throw new PRNotReadyError(unit.pr.number, reasons);
          }
          break;
        }

        // Before merging, retarget this PR to main if needed (after first merge)
        if (mergedBranches.length > 0) {
          const currentBase = await getPRBaseBranch(unit.pr.number);
          if (currentBase !== "main") {
            console.log(`Retargeting PR #${unit.pr.number} to main...`);
            await retargetPR(unit.pr.number, "main");
          }
        }

        // Before merging, also retarget the NEXT PR to main (so it doesn't get closed when we delete this branch)
        if (nextUnit) {
          const nextBase = await getPRBaseBranch(nextUnit.pr.number);
          if (nextBase !== "main") {
            console.log(`Retargeting PR #${nextUnit.pr.number} to main...`);
            await retargetPR(nextUnit.pr.number, "main");
          }
        }

        const branchName = await landSinglePR(unit, config);
        mergedBranches.push(branchName);

        console.log(""); // Blank line between PRs
      }

      // Clean up all merged branches at the end
      if (mergedBranches.length > 0) {
        console.log("Cleaning up merged branches...");
        for (const branchName of mergedBranches) {
          await deleteRemoteBranch(branchName);
          console.log(`✓ Deleted remote branch ${branchName}`);
        }
        console.log("");
        console.log(`✓ Merged ${mergedBranches.length} PR(s)`);
      } else {
        console.log("No ready PRs to merge");
      }
    } else {
      // Land single bottom PR
      const [bottomPR] = openPRs;
      if (!bottomPR) {
        console.log("No open PRs in stack");
        return;
      }

      const status = mergeStatusMap.get(bottomPR.pr.number);
      if (!status?.isReady) {
        const reasons = status ? getNotReadyReasons(status) : ["Unknown status"];
        throw new PRNotReadyError(bottomPR.pr.number, reasons);
      }

      // Land the PR
      const branchName = await landSinglePR(bottomPR, config);

      // If there's a next PR in the stack, retarget it to main before deleting this branch
      // This prevents the next PR from being closed when its base branch is deleted
      const nextPR = openPRs[1];
      if (nextPR) {
        const nextBase = await getPRBaseBranch(nextPR.pr.number);
        if (nextBase !== "main") {
          console.log(`Retargeting PR #${nextPR.pr.number} to main...`);
          await retargetPR(nextPR.pr.number, "main");
        }
      }

      // Now safe to delete the branch
      await deleteRemoteBranch(branchName);
      console.log(`✓ Deleted remote branch ${branchName}`);
    }
  } catch (error) {
    if (error instanceof PRNotFastForwardError) {
      console.error(`✗ PR #${error.prNumber} is not ready to land:`);
      console.error(`  • ${error.reason}`);
      console.error("\nRun 'spry view' to see status.");
      process.exit(1);
    }

    if (error instanceof PRNotFoundError) {
      console.error(`✗ PR #${error.prNumber} not found`);
      process.exit(1);
    }

    if (error instanceof PRNotReadyError) {
      console.error(`✗ PR #${error.prNumber} is not ready to land:`);
      for (const reason of error.reasons) {
        console.error(`  • ${reason}`);
      }
      console.error("\nRun 'spry view' to see status.");
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
