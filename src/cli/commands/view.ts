import { $ } from "bun";
import { getStackCommitsWithTrailers, getCurrentBranch } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import { formatStackView, formatValidationError, formatAllPRsView } from "../output.ts";
import { getBranchNameConfig, getBranchName } from "../../github/branches.ts";
import {
  findPRByBranch,
  getPRChecksStatus,
  getPRReviewStatus,
  getPRCommentStatus,
} from "../../github/pr.ts";
import { ensureGhInstalled } from "../../github/api.ts";
import type { PRUnit, EnrichedPRUnit, PRStatus } from "../../types.ts";

export interface ViewOptions {
  all?: boolean;
}

async function fetchPRStatus(prNumber: number): Promise<PRStatus> {
  const [checks, review, comments] = await Promise.all([
    getPRChecksStatus(prNumber),
    getPRReviewStatus(prNumber),
    getPRCommentStatus(prNumber),
  ]);

  return { checks, review, comments };
}

async function enrichUnitsWithPRInfo(units: PRUnit[]): Promise<EnrichedPRUnit[]> {
  const config = await getBranchNameConfig();

  return Promise.all(
    units.map(async (unit): Promise<EnrichedPRUnit> => {
      const branchName = getBranchName(unit.id, config);
      const pr = await findPRByBranch(branchName);

      if (pr) {
        // Only fetch status for open PRs
        const status = pr.state === "OPEN" ? await fetchPRStatus(pr.number) : undefined;

        return {
          ...unit,
          pr: {
            number: pr.number,
            url: pr.url,
            state: pr.state,
            status,
          },
        };
      }

      return unit;
    }),
  );
}

export interface UserPR {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
  url: string;
}

async function viewAllPRs(): Promise<void> {
  await ensureGhInstalled();

  // Get current GitHub username
  const usernameResult = await $`gh api user --jq .login`.quiet().nothrow();
  if (usernameResult.exitCode !== 0) {
    throw new Error("Failed to get GitHub username. Are you authenticated with `gh auth login`?");
  }
  const username = usernameResult.stdout.toString().trim();

  // Get all PRs authored by the current user
  const result =
    await $`gh pr list --author ${username} --state all --json number,title,state,headRefName,url --limit 100`
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    throw new Error(`Failed to list PRs: ${result.stderr.toString()}`);
  }

  const prs = JSON.parse(result.stdout.toString()) as UserPR[];
  console.log(formatAllPRsView(prs, username));
}

export async function viewCommand(options: ViewOptions = {}): Promise<void> {
  try {
    if (options.all) {
      await viewAllPRs();
      return;
    }

    const [commits, branchName] = await Promise.all([
      getStackCommitsWithTrailers(),
      getCurrentBranch(),
    ]);

    const result = parseStack(commits);

    if (!result.ok) {
      console.error(formatValidationError(result));
      process.exit(1);
    }

    const enrichedUnits = await enrichUnitsWithPRInfo(result.units);
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
