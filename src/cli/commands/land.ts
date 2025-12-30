import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import { formatValidationError } from "../output.ts";
import { getBranchNameConfig, getBranchName } from "../../github/branches.ts";
import {
  findPRByBranch,
  landPR,
  deleteRemoteBranch,
  getPRMergeStatus,
  getPRBaseBranch,
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  return Promise.all(
    units.map(async (unit): Promise<EnrichedPRUnit> => {
      const branchName = getBranchName(unit.id, config);
      const pr = await findPRByBranch(branchName);

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
    }),
  );
}

type EnrichedUnitWithPR = EnrichedPRUnit & { pr: NonNullable<EnrichedPRUnit["pr"]> };

/**
 * Wait for GitHub to retarget a PR to main branch after its parent is merged.
 * GitHub automatically retargets PRs when their base branch is deleted.
 */
async function waitForPRRetarget(
  prNumber: number,
  targetBranch: string,
  maxWaitMs: number = 30000,
  pollIntervalMs: number = 2000,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const baseBranch = await getPRBaseBranch(prNumber);
    if (baseBranch === targetBranch) {
      return true;
    }
    await sleep(pollIntervalMs);
  }

  return false;
}

/**
 * Land a single PR: merge, verify merged state on GitHub, and delete branch.
 * Caller is responsible for checking readiness beforehand.
 */
async function landSinglePR(
  unit: EnrichedUnitWithPR,
  config: Awaited<ReturnType<typeof getBranchNameConfig>>,
): Promise<void> {
  console.log(`Merging PR #${unit.pr.number} (${unit.title})...`);

  await landPR(unit.pr.number);

  // Verify PR is actually merged on GitHub before proceeding (wait up to 30s)
  const isMerged = await waitForPRState(unit.pr.number, "MERGED", 30000);
  if (!isMerged) {
    throw new Error(`PR #${unit.pr.number} was not marked as merged by GitHub after landing`);
  }

  console.log(`✓ Merged PR #${unit.pr.number} to main`);

  // Clean up the remote branch
  const branchName = getBranchName(unit.id, config);
  await deleteRemoteBranch(branchName);
  console.log(`✓ Deleted remote branch ${branchName}`);
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
      let merged = 0;

      for (const unit of openPRs) {
        const status = mergeStatusMap.get(unit.pr.number);
        if (!status?.isReady) {
          if (merged > 0) {
            console.log(`Stopping at PR #${unit.pr.number} (not ready)`);
          } else {
            const reasons = status ? getNotReadyReasons(status) : ["Unknown status"];
            throw new PRNotReadyError(unit.pr.number, reasons);
          }
          break;
        }

        // After first merge, wait for GitHub to retarget PR to main
        if (merged > 0) {
          process.stdout.write(`Waiting for PR #${unit.pr.number} to retarget to main...`);
          const retargeted = await waitForPRRetarget(unit.pr.number, "main");
          if (!retargeted) {
            console.log(" timed out");
            console.log(`\nStopping: PR #${unit.pr.number} was not retargeted to main in time`);
            break;
          }
          console.log(" done");
        }

        await landSinglePR(unit, config);

        merged++;
        console.log(""); // Blank line between PRs
      }

      if (merged === 0) {
        console.log("No ready PRs to merge");
      } else {
        console.log(`✓ Merged ${merged} PR(s)`);
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

      await landSinglePR(bottomPR, config);
    }
  } catch (error) {
    if (error instanceof PRNotFastForwardError) {
      console.error(`✗ PR #${error.prNumber} is not ready to land:`);
      console.error(`  • ${error.reason}`);
      console.error("\nRun 'taspr view' to see status.");
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
      console.error("\nRun 'taspr view' to see status.");
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
