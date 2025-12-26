import { getStackCommitsWithTrailers, getCurrentBranch } from "../../git/commands.ts";
import { parseStack } from "../../core/stack.ts";
import { formatStackView, formatValidationError } from "../output.ts";

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

    const commitCount = commits.length;
    console.log(formatStackView(result.units, branchName, commitCount));
  } catch (error) {
    if (error instanceof Error) {
      console.error(`✗ Error: ${error.message}`);
    } else {
      console.error("✗ An unexpected error occurred");
    }
    process.exit(1);
  }
}
