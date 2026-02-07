import { getStackCommitsWithTrailers, getCurrentBranch } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import { formatStackView, formatValidationError, formatAllPRsView } from "../output.ts";
import { getBranchNameConfig, getBranchName } from "../../github/branches.ts";
import { getGitHubService } from "../../github/service.ts";
export type { UserPR } from "../../github/service.ts";
import { isGitHubOrigin } from "../../github/api.ts";
import { readGroupTitles } from "../../git/group-titles.ts";
import type { PRUnit, EnrichedPRUnit, PRStatus } from "../../types.ts";

export interface ViewOptions {
  all?: boolean;
  mock?: boolean;
}

async function fetchPRStatus(prNumber: number): Promise<PRStatus> {
  const service = getGitHubService();
  // Fetch checks + review in one call, comments separately
  // (comments requires GraphQL, so can't easily combine)
  const [{ checks, review }, comments] = await Promise.all([
    service.getPRChecksAndReviewStatus(prNumber),
    service.getPRCommentStatus(prNumber),
  ]);

  return { checks, review, comments };
}

async function enrichUnitsWithPRInfo(units: PRUnit[]): Promise<EnrichedPRUnit[]> {
  const service = getGitHubService();
  const config = await getBranchNameConfig();

  // Build branch name lookup for all units
  const branchNames = units.map((unit) => getBranchName(unit.id, config));

  // Batch fetch all PRs in a single API call
  const prMap = await service.findPRsByBranches(branchNames, { includeAll: true });

  // Find open PRs that need status fetching
  const openPRNumbers: number[] = [];
  for (const unit of units) {
    const branchName = getBranchName(unit.id, config);
    const pr = prMap.get(branchName);
    if (pr?.state === "OPEN") {
      openPRNumbers.push(pr.number);
    }
  }

  // Fetch statuses for all open PRs (still N calls per status type, but no longer N×3 parallel)
  // TODO: Further optimize with batch GraphQL query (spry-6yt)
  const statusMap = new Map<number, PRStatus>();
  for (const prNumber of openPRNumbers) {
    statusMap.set(prNumber, await fetchPRStatus(prNumber));
  }

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
          status: statusMap.get(pr.number),
        },
      };
    }

    return unit;
  });
}

/**
 * Add mock PR data to units for testing display without hitting GitHub API.
 * Merged PRs are contiguous from the bottom, then open PRs with various statuses.
 */
function enrichUnitsWithMockPRInfo(units: PRUnit[]): EnrichedPRUnit[] {
  // Statuses for open PRs - cycle through these
  const openStatuses: PRStatus[] = [
    { checks: "passing", review: "approved", comments: { total: 3, resolved: 3 } },
    { checks: "failing", review: "changes_requested", comments: { total: 5, resolved: 2 } },
    { checks: "pending", review: "review_required", comments: { total: 0, resolved: 0 } },
  ];

  return units.map((unit, i): EnrichedPRUnit => {
    // First unit is merged, rest are open with varying statuses
    // One unit has no PR yet
    if (i === 0) {
      // Bottom of stack: merged
      return {
        ...unit,
        pr: {
          number: 100 + i,
          url: `https://github.com/example/repo/pull/${100 + i}`,
          state: "MERGED",
        },
      };
    } else if (i === units.length - 1 && units.length > 2) {
      // Top of stack: no PR yet
      return unit;
    } else {
      // Middle: open PRs with various statuses
      const statusIndex = (i - 1) % openStatuses.length;
      return {
        ...unit,
        pr: {
          number: 100 + i,
          url: `https://github.com/example/repo/pull/${100 + i}`,
          state: "OPEN",
          status: openStatuses[statusIndex],
        },
      };
    }
  });
}

async function viewAllPRs(): Promise<void> {
  const service = getGitHubService();
  const username = await service.getUsername();
  const prs = await service.listUserPRs(username);
  console.log(formatAllPRsView(prs, username));
}

export async function viewCommand(options: ViewOptions = {}): Promise<void> {
  try {
    if (options.all) {
      await viewAllPRs();
      return;
    }

    const [commits, branchName, groupTitles] = await Promise.all([
      getStackCommitsWithTrailers(),
      getCurrentBranch(),
      readGroupTitles(),
    ]);

    const result = parseStack(commits, groupTitles);

    if (!result.ok) {
      console.error(formatValidationError(result));
      process.exit(1);
    }

    // Only fetch PR info if origin is a GitHub repository
    const useGitHub = await isGitHubOrigin();
    const enrichedUnits = options.mock
      ? enrichUnitsWithMockPRInfo(result.units)
      : useGitHub
        ? await enrichUnitsWithPRInfo(result.units)
        : result.units;
    const commitCount = commits.length;
    console.log(await formatStackView(enrichedUnits, branchName, commitCount));
  } catch (error) {
    if (error instanceof Error) {
      console.error(`✗ Error: ${error.message}`);
    } else {
      console.error("✗ An unexpected error occurred");
    }
    process.exit(1);
  }
}
