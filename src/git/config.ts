import { $ } from "bun";

export type TemplateLocation = "prepend" | "afterBody" | "afterStackLinks" | "append";

export interface SpryConfig {
  branchPrefix: string;
  defaultBranch: string;
  tempCommitPrefixes: string[];
  showStackLinks: boolean;
  includePrTemplate: boolean;
  prTemplateLocation: TemplateLocation;
}

/**
 * Default prefixes that indicate temporary commits.
 * These commits won't automatically get PRs during sync --open.
 * Comparison is case-insensitive.
 */
export const DEFAULT_TEMP_COMMIT_PREFIXES = ["WIP", "fixup!", "amend!", "squash!"];

let cachedConfig: SpryConfig | null = null;

/**
 * Get spry configuration from git config.
 * Result is memoized for the lifetime of the process.
 *
 * Configuration options:
 * - spry.branchPrefix: Custom prefix for branch names (default: "spry")
 * - spry.defaultBranch: Default branch to stack on (default: auto-detect from origin)
 * - spry.tempCommitPrefixes: Comma-separated prefixes for temp commits (default: "WIP,fixup!,amend!,squash!")
 * - spry.showStackLinks: Show stack links in PR body (default: true)
 * - spry.includePrTemplate: Include PR template in PR body (default: true)
 * - spry.prTemplateLocation: Where to place PR template - "prepend", "afterBody", "afterStackLinks", "append" (default: "afterBody")
 */
export async function getSpryConfig(): Promise<SpryConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const [
    prefixResult,
    defaultBranchResult,
    tempPrefixesResult,
    showStackLinksResult,
    includePrTemplateResult,
    prTemplateLocationResult,
  ] = await Promise.all([
    $`git config --get spry.branchPrefix`.nothrow(),
    $`git config --get spry.defaultBranch`.nothrow(),
    $`git config --get spry.tempCommitPrefixes`.nothrow(),
    $`git config --get spry.showStackLinks`.nothrow(),
    $`git config --get spry.includePrTemplate`.nothrow(),
    $`git config --get spry.prTemplateLocation`.nothrow(),
  ]);

  const branchPrefix = prefixResult.exitCode === 0 ? prefixResult.stdout.toString().trim() : "spry";

  let defaultBranch: string;
  if (defaultBranchResult.exitCode === 0) {
    defaultBranch = defaultBranchResult.stdout.toString().trim();
  } else {
    defaultBranch = await detectDefaultBranch();
  }

  // Parse tempCommitPrefixes from comma-separated string, or use defaults
  // Set to empty string to disable: git config spry.tempCommitPrefixes ""
  let tempCommitPrefixes: string[];
  if (tempPrefixesResult.exitCode === 0) {
    const value = tempPrefixesResult.stdout.toString().trim();
    // Empty string means explicitly disabled
    if (value === "") {
      tempCommitPrefixes = [];
    } else {
      tempCommitPrefixes = value
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    }
  } else {
    tempCommitPrefixes = DEFAULT_TEMP_COMMIT_PREFIXES;
  }

  // Parse boolean settings (default true)
  const showStackLinks =
    showStackLinksResult.exitCode === 0
      ? showStackLinksResult.stdout.toString().trim().toLowerCase() !== "false"
      : true;

  const includePrTemplate =
    includePrTemplateResult.exitCode === 0
      ? includePrTemplateResult.stdout.toString().trim().toLowerCase() !== "false"
      : true;

  // Parse prTemplateLocation with validation (default "afterBody")
  let prTemplateLocation: TemplateLocation = "afterBody";
  if (prTemplateLocationResult.exitCode === 0) {
    const value = prTemplateLocationResult.stdout.toString().trim() as TemplateLocation;
    const validLocations: TemplateLocation[] = [
      "prepend",
      "afterBody",
      "afterStackLinks",
      "append",
    ];
    if (validLocations.includes(value)) {
      prTemplateLocation = value;
    }
  }

  cachedConfig = {
    branchPrefix,
    defaultBranch,
    tempCommitPrefixes,
    showStackLinks,
    includePrTemplate,
    prTemplateLocation,
  };
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
    "Could not detect default branch. Set it with: git config spry.defaultBranch <branch>",
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
  const config = await getSpryConfig();
  return `origin/${config.defaultBranch}`;
}

/**
 * Check if a commit title indicates a temporary commit that shouldn't get a PR.
 * Matches against configured prefixes (case-insensitive).
 *
 * Default prefixes: WIP, fixup!, amend!, squash!
 *
 * @param title - The commit title to check
 * @param prefixes - Prefixes to check against (from config)
 */
export function isTempCommit(title: string, prefixes: string[]): boolean {
  const lowerTitle = title.toLowerCase();
  return prefixes.some((prefix) => lowerTitle.startsWith(prefix.toLowerCase()));
}
