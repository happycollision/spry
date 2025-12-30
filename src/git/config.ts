import { $ } from "bun";

export interface TasprConfig {
  branchPrefix: string;
  defaultBranch: string;
}

let cachedConfig: TasprConfig | null = null;

/**
 * Get taspr configuration from git config.
 * Result is memoized for the lifetime of the process.
 *
 * Configuration options:
 * - taspr.branchPrefix: Custom prefix for branch names (default: "taspr")
 * - taspr.defaultBranch: Default branch to stack on (default: auto-detect from origin)
 */
export async function getTasprConfig(): Promise<TasprConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const [prefixResult, defaultBranchResult] = await Promise.all([
    $`git config --get taspr.branchPrefix`.nothrow(),
    $`git config --get taspr.defaultBranch`.nothrow(),
  ]);

  const branchPrefix =
    prefixResult.exitCode === 0 ? prefixResult.stdout.toString().trim() : "taspr";

  let defaultBranch: string;
  if (defaultBranchResult.exitCode === 0) {
    defaultBranch = defaultBranchResult.stdout.toString().trim();
  } else {
    defaultBranch = await detectDefaultBranch();
  }

  cachedConfig = { branchPrefix, defaultBranch };
  return cachedConfig;
}

/**
 * Auto-detect the default branch from origin.
 * Queries the remote directly to get its HEAD reference.
 */
export async function detectDefaultBranch(): Promise<string> {
  // Method 1: Check local origin/HEAD symbolic ref (fast, no network)
  const localHeadResult = await $`git symbolic-ref refs/remotes/origin/HEAD`.quiet().nothrow();
  if (localHeadResult.exitCode === 0) {
    const ref = localHeadResult.stdout.toString().trim();
    return ref.replace("refs/remotes/origin/", "");
  }

  // Method 2: Query remote's HEAD directly (authoritative, requires network)
  const remoteResult = await $`git ls-remote --symref origin HEAD`.quiet().nothrow();
  if (remoteResult.exitCode === 0) {
    const output = remoteResult.stdout.toString();
    // Parse: "ref: refs/heads/main\tHEAD"
    const match = output.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error(
    "Could not detect default branch. Set it with: git config taspr.defaultBranch <branch>",
  );
}

/**
 * Clear the cached config. Useful for testing.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get the full remote reference for the default branch.
 * @example "origin/main" or "origin/master"
 */
export async function getDefaultBranchRef(): Promise<string> {
  const config = await getTasprConfig();
  return `origin/${config.defaultBranch}`;
}
