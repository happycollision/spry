import { getStackCommitsWithTrailers, getCurrentBranch } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import { formatStackView, formatValidationError } from "../output.ts";
import { getBranchNameConfig, getBranchName } from "../../github/branches.ts";
import { findPRByBranch } from "../../github/pr.ts";
import type { PRUnit, EnrichedPRUnit } from "../../types.ts";

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

export async function viewCommand(): Promise<void> {
  try {
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
    console.log(formatStackView(enrichedUnits, branchName, commitCount));
  } catch (error) {
    if (error instanceof Error) {
      console.error(`✗ Error: ${error.message}`);
    } else {
      console.error("✗ An unexpected error occurred");
    }
    process.exit(1);
  }
}
