import { $ } from "bun";
import { ghExecWithLimit } from "./retry.ts";

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
  const configResult = await $`git config --get spry.defaultBranch`.nothrow();
  if (configResult.exitCode === 0) {
    cachedDefaultBranch = configResult.stdout.toString().trim();
    return cachedDefaultBranch;
  }

  // Fall back to origin's default
  const remoteResult = await $`git remote show origin`.quiet().nothrow();
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

let cachedOriginUrl: string | null = null;

/**
 * Check if a remote URL is a GitHub repository.
 */
export function isGitHubUrl(url: string): boolean {
  return /github\.com[:/]/.test(url);
}

/**
 * Get the origin remote URL.
 * Result is memoized for the lifetime of the process.
 */
async function getOriginUrl(): Promise<string> {
  if (cachedOriginUrl !== null) {
    return cachedOriginUrl;
  }

  const result = await $`git remote get-url origin`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new ConfigurationError(
      "No 'origin' remote found. Spry requires a git repository with an 'origin' remote.",
    );
  }

  cachedOriginUrl = result.stdout.toString().trim();
  return cachedOriginUrl;
}

/**
 * Check if the origin remote is a GitHub repository.
 * Returns false if origin is not set or is not on github.com.
 */
export async function isGitHubOrigin(): Promise<boolean> {
  try {
    const url = await getOriginUrl();
    return isGitHubUrl(url);
  } catch {
    return false;
  }
}

/**
 * Require that the origin is a GitHub repository.
 * Throws a descriptive error if it's not.
 */
export async function requireGitHubOrigin(): Promise<void> {
  const url = await getOriginUrl();

  if (!isGitHubUrl(url)) {
    throw new NonGitHubOriginError(
      `This command requires a GitHub repository, but origin is not on github.com: ${url}`,
    );
  }
}
