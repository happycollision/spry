import { $ } from "bun";
import { getGitHubUsername } from "./api.ts";
import type { GitOptions } from "../git/commands.ts";
import { getTasprConfig } from "../git/config.ts";

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

  const [tasprConfig, username] = await Promise.all([getTasprConfig(), getGitHubUsername()]);

  cachedBranchConfig = { prefix: tasprConfig.branchPrefix, username };
  return cachedBranchConfig;
}

/**
 * Generate a branch name for a PRUnit.
 * Format: <prefix>/<username>/<prId>
 *
 * @example
 * getBranchName("a1b2c3d4", { prefix: "taspr", username: "msims" })
 * // => "taspr/msims/a1b2c3d4"
 */
export function getBranchName(prId: string, config: BranchNameConfig): string {
  return `${config.prefix}/${config.username}/${prId}`;
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
  const { cwd } = options;
  const cwdArgs = cwd ? ["-C", cwd] : [];
  const forceArgs = force ? ["--force"] : [];

  await $`git ${cwdArgs} push ${forceArgs} origin ${commitHash}:refs/heads/${branchName}`.quiet();
}
