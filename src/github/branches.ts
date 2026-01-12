import { $ } from "bun";
import { getGitHubUsername } from "./api.ts";
import type { GitOptions } from "../git/commands.ts";
import { getSpryConfig } from "../git/config.ts";
import { validateBranchName } from "../core/validation.ts";

export interface BranchNameConfig {
  prefix: string;
  username: string;
}

let cachedBranchConfig: BranchNameConfig | null = null;

/**
 * Get the configuration for branch naming.
 * Result is memoized for the lifetime of the process.
 */
export async function getBranchNameConfig(): Promise<BranchNameConfig> {
  if (cachedBranchConfig) {
    return cachedBranchConfig;
  }

  const [spryConfig, username] = await Promise.all([getSpryConfig(), getGitHubUsername()]);

  cachedBranchConfig = { prefix: spryConfig.branchPrefix, username };
  return cachedBranchConfig;
}

/**
 * Generate a branch name for a PRUnit.
 * Format: <prefix>/<username>/<prId>
 *
 * @example
 * getBranchName("a1b2c3d4", { prefix: "spry", username: "msims" })
 * // => "spry/msims/a1b2c3d4"
 */
export function getBranchName(prId: string, config: BranchNameConfig): string {
  const branchName = `${config.prefix}/${config.username}/${prId}`;

  // Validate the generated branch name
  const validation = validateBranchName(branchName);
  if (!validation.ok) {
    throw new Error(`Invalid branch name '${branchName}': ${validation.error}`);
  }

  return branchName;
}

/**
 * Push a commit to a remote branch.
 * Creates the branch if it doesn't exist, updates it if it does.
 */
export async function pushBranch(
  commitHash: string,
  branchName: string,
  force: boolean = false,
  options: GitOptions = {},
): Promise<void> {
  // Validate branch name before pushing
  const validation = validateBranchName(branchName);
  if (!validation.ok) {
    throw new Error(`Invalid branch name '${branchName}': ${validation.error}`);
  }

  const { cwd } = options;
  const cwdArgs = cwd ? ["-C", cwd] : [];
  const forceArgs = force ? ["--force"] : [];

  await $`git ${cwdArgs} push ${forceArgs} origin ${commitHash}:refs/heads/${branchName}`.quiet();
}
