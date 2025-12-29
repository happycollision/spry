import { $ } from "bun";

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

  const result = await $`gh api user --jq .login`.quiet().nothrow();

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
  const configResult = await $`git config --get taspr.defaultBranch`.nothrow();
  if (configResult.exitCode === 0) {
    cachedDefaultBranch = configResult.stdout.toString().trim();
    return cachedDefaultBranch;
  }

  // Fall back to origin's default
  const remoteResult = await $`git remote show origin`.nothrow();
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
      "  git config taspr.defaultBranch main",
  );
}
