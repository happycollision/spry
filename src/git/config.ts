import { $ } from "bun";

export type TemplateLocation = "prepend" | "afterBody" | "afterStackLinks" | "append";

export interface SpryConfig {
  branchPrefix: string;
  remote: string;
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
 * - spry.remote: Remote to use (default: auto-detect - single remote, or 'origin')
 * - spry.branchPrefix: Custom prefix for branch names (default: "spry")
 * - spry.defaultBranch: Default branch to stack on (default: auto-detect from remote)
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
    remoteResult,
    prefixResult,
    defaultBranchResult,
    tempPrefixesResult,
    showStackLinksResult,
    includePrTemplateResult,
    prTemplateLocationResult,
  ] = await Promise.all([
    $`git config --get spry.remote`.quiet().nothrow(),
    $`git config --get spry.branchPrefix`.quiet().nothrow(),
    $`git config --get spry.defaultBranch`.quiet().nothrow(),
    $`git config --get spry.tempCommitPrefixes`.quiet().nothrow(),
    $`git config --get spry.showStackLinks`.quiet().nothrow(),
    $`git config --get spry.includePrTemplate`.quiet().nothrow(),
    $`git config --get spry.prTemplateLocation`.quiet().nothrow(),
  ]);

  // Detect remote first (may auto-persist if single remote)
  const configuredRemote =
    remoteResult.exitCode === 0 ? remoteResult.stdout.toString().trim() : undefined;
  const remote = await detectRemote(configuredRemote);

  const branchPrefix = prefixResult.exitCode === 0 ? prefixResult.stdout.toString().trim() : "spry";

  let defaultBranch: string;
  if (defaultBranchResult.exitCode === 0) {
    defaultBranch = defaultBranchResult.stdout.toString().trim();
  } else {
    defaultBranch = await detectDefaultBranch(remote);
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
    remote,
    defaultBranch,
    tempCommitPrefixes,
    showStackLinks,
    includePrTemplate,
    prTemplateLocation,
  };
  return cachedConfig;
}

/**
 * Auto-detect the remote to use.
 * Detection order:
 * 1. If git config spry.remote is set, use that
 * 2. If only one remote exists, use it AND persist to config
 * 3. If 'origin' remote exists, use it
 * 4. Otherwise throw with helpful error listing available remotes
 */
export async function detectRemote(configuredRemote?: string): Promise<string> {
  // 1. If explicitly configured, use that
  if (configuredRemote) {
    return configuredRemote;
  }

  // Get list of all remotes
  const remotesResult = await $`git remote`.quiet().nothrow();
  if (remotesResult.exitCode !== 0) {
    throw new Error("Not a git repository or unable to list remotes");
  }

  const remotes = remotesResult.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((r) => r.length > 0);

  if (remotes.length === 0) {
    throw new Error("No git remotes found. Add a remote with:\n  git remote add origin <url>");
  }

  // 2. If only one remote, use it and persist to config for future-proofing
  if (remotes.length === 1) {
    const remote = remotes[0];
    // Persist to config so if more remotes are added later, we remember the choice
    await $`git config spry.remote ${remote}`.quiet().nothrow();
    return remote;
  }

  // 3. If 'origin' exists, use it (common convention)
  if (remotes.includes("origin")) {
    return "origin";
  }

  // 4. Multiple remotes, no 'origin', not configured - need user to choose
  throw new Error(
    `Multiple remotes found and no default configured.\n` +
      `Set your target remote with:\n` +
      `  git config spry.remote <remote-name>\n\n` +
      `Available remotes: ${remotes.join(", ")}`,
  );
}

/**
 * Auto-detect the default branch from the configured remote.
 * Queries the remote directly to get its HEAD reference.
 */
export async function detectDefaultBranch(remote: string): Promise<string> {
  // Method 1: Check local <remote>/HEAD symbolic ref (fast, no network)
  const localHeadResult = await $`git symbolic-ref refs/remotes/${remote}/HEAD`.quiet().nothrow();
  if (localHeadResult.exitCode === 0) {
    const ref = localHeadResult.stdout.toString().trim();
    return ref.replace(`refs/remotes/${remote}/`, "");
  }

  // Method 2: Query remote's HEAD directly (authoritative, requires network)
  const remoteResult = await $`git ls-remote --symref ${remote} HEAD`.quiet().nothrow();
  if (remoteResult.exitCode === 0) {
    const output = remoteResult.stdout.toString();
    // Parse: "ref: refs/heads/main\tHEAD"
    const match = output.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error(
    `Could not detect default branch for remote '${remote}'.\n` +
      `Set it with: git config spry.defaultBranch <branch>`,
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
 * @example "origin/main" or "upstream/master"
 */
export async function getDefaultBranchRef(): Promise<string> {
  const config = await getSpryConfig();
  return `${config.remote}/${config.defaultBranch}`;
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
