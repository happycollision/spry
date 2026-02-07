import { $ } from "bun";
import { ghExecWithLimit } from "./retry.ts";
import { getSpryConfig } from "../git/config.ts";

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyError";
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class NonGitHubOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonGitHubOriginError";
  }
}

/**
 * Check if the gh CLI is installed.
 */
export async function ensureGhInstalled(): Promise<void> {
  const result = await $`which gh`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new DependencyError(
      "gh CLI not found. Please install it:\n" +
        "  brew install gh          # macOS\n" +
        "  apt install gh           # Ubuntu\n" +
        "  https://cli.github.com   # Other",
    );
  }
}

/**
 * Get the current user's GitHub username.
 * Requires the gh CLI to be installed and authenticated.
 */
export async function getGitHubUsername(): Promise<string> {
  await ensureGhInstalled();

  const args = ["gh", "api", "user", "--jq", ".login"];
  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    throw new GitHubAuthError(
      "Failed to get GitHub username. Ensure gh CLI is authenticated.\n" + "Run: gh auth login",
    );
  }

  return result.stdout.toString().trim();
}

let cachedDefaultBranch: string | null = null;

/**
 * Get the default branch for the repository (usually main or master).
 * Result is memoized for the lifetime of the process.
 */
export async function getDefaultBranch(): Promise<string> {
  if (cachedDefaultBranch) {
    return cachedDefaultBranch;
  }

  // Try git config first
  const configResult = await $`git config --get spry.defaultBranch`.quiet().nothrow();
  if (configResult.exitCode === 0) {
    cachedDefaultBranch = configResult.stdout.toString().trim();
    return cachedDefaultBranch;
  }

  // Fall back to configured remote's default
  const config = await getSpryConfig();
  const remoteResult = await $`git remote show ${config.remote}`.quiet().nothrow();
  if (remoteResult.exitCode === 0) {
    const remote = remoteResult.stdout.toString();
    const match = remote.match(/HEAD branch: (\S+)/);
    if (match?.[1]) {
      cachedDefaultBranch = match[1];
      return cachedDefaultBranch;
    }
  }

  throw new ConfigurationError(
    "Unable to determine the default branch.\n" +
      "Please set it manually:\n" +
      "  git config spry.defaultBranch main",
  );
}

let cachedRemoteUrl: string | null = null;

/**
 * Clear the cached remote URL. Useful for testing.
 */
export function clearRemoteUrlCache(): void {
  cachedRemoteUrl = null;
}

/**
 * Check if a remote URL is a GitHub repository.
 */
export function isGitHubUrl(url: string): boolean {
  return /github\.com[:/]/.test(url);
}

/**
 * Get the configured remote's URL.
 * Result is memoized for the lifetime of the process.
 */
async function getRemoteUrl(): Promise<string> {
  if (cachedRemoteUrl !== null) {
    return cachedRemoteUrl;
  }

  const config = await getSpryConfig();
  const result = await $`git remote get-url ${config.remote}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new ConfigurationError(
      `No '${config.remote}' remote found. Spry requires a git repository with a configured remote.`,
    );
  }

  cachedRemoteUrl = result.stdout.toString().trim();
  return cachedRemoteUrl;
}

/**
 * Check if the configured remote is a GitHub repository.
 * Returns false if remote is not set or is not on github.com.
 *
 * In snapshot replay mode (SPRY_SNAPSHOT_MODE=replay), always returns true
 * since the snapshot service will handle GitHub API calls.
 */
export async function isGitHubOrigin(): Promise<boolean> {
  if (process.env.SPRY_SNAPSHOT_MODE === "replay") {
    return true;
  }
  try {
    const url = await getRemoteUrl();
    return isGitHubUrl(url);
  } catch {
    return false;
  }
}

/**
 * Require that the configured remote is a GitHub repository.
 * Throws a descriptive error if it's not.
 *
 * In snapshot replay mode, this is a no-op (always passes).
 */
export async function requireGitHubOrigin(): Promise<void> {
  if (process.env.SPRY_SNAPSHOT_MODE === "replay") {
    return;
  }
  const url = await getRemoteUrl();

  if (!isGitHubUrl(url)) {
    throw new NonGitHubOriginError(
      `This command requires a GitHub repository, but origin is not on github.com: ${url}`,
    );
  }
}
