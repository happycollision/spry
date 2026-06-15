import type { GitRunner } from "../lib/context.ts";

export interface SpryConfig {
  trunk: string;
  remote: string;
  branchPrefix: string;
  /** GitHub repo owner for PR API queries. Resolved best-effort; undefined on
   *  non-GitHub remotes with no `spry.repo` override. */
  owner?: string;
  /** GitHub repo name for PR API queries. See {@link SpryConfig.owner}. */
  repo?: string;
}

export function trunkRef(config: SpryConfig): string {
  return `${config.remote}/${config.trunk}`;
}

export async function checkGitVersion(git: GitRunner): Promise<string> {
  const result = await git.run(["--version"]);
  const match = result.stdout.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Could not parse git version from: ${result.stdout.trim()}`);
  }
  const major = parseInt(match[1] ?? "0", 10);
  const minor = parseInt(match[2] ?? "0", 10);
  const version = `${major}.${minor}.${match[3] ?? "0"}`;
  if (major < 2 || (major === 2 && minor < 40)) {
    throw new Error(
      `spry requires git 2.40 or later (found ${version}).\n` +
        `Update git: https://git-scm.com/downloads`,
    );
  }
  return version;
}

export interface ConfigOptions {
  cwd?: string;
}

async function listRemotes(git: GitRunner, cwd?: string): Promise<string[]> {
  const result = await git.run(["remote"], { cwd });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  return result.stdout
    .trim()
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
}

async function suggestTrunk(git: GitRunner, remote: string, cwd?: string): Promise<string[]> {
  const result = await git.run(["branch", "-r", "--format=%(refname:short)"], { cwd });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  const prefix = `${remote}/`;
  return result.stdout
    .trim()
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith(prefix) && !b.includes("/HEAD"))
    .map((b) => b.slice(prefix.length));
}

export async function readConfig(git: GitRunner, options?: ConfigOptions): Promise<SpryConfig> {
  const cwd = options?.cwd;

  // Read remote first (needed for trunk suggestions)
  const remoteResult = await git.run(["config", "--get", "spry.remote"], { cwd });
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) {
    const remotes = await listRemotes(git, cwd);
    const suggestion =
      remotes.length > 0
        ? `\nAvailable remotes: ${remotes.join(", ")}\nSet it with: git config spry.remote ${remotes.includes("origin") ? "origin" : remotes[0]}`
        : `\nSet it with: git config spry.remote origin`;
    throw new Error(`spry.remote is not configured.${suggestion}`);
  }
  const remote = remoteResult.stdout.trim();

  // Read trunk
  const trunkResult = await git.run(["config", "--get", "spry.trunk"], { cwd });
  if (trunkResult.exitCode !== 0 || !trunkResult.stdout.trim()) {
    const candidates = await suggestTrunk(git, remote, cwd);
    const suggestion =
      candidates.length > 0
        ? `\nAvailable branches on ${remote}: ${candidates.join(", ")}\nSet it with: git config spry.trunk ${candidates.includes("main") ? "main" : candidates[0]}`
        : `\nSet it with: git config spry.trunk main`;
    throw new Error(`spry.trunk is not configured.${suggestion}`);
  }
  const trunk = trunkResult.stdout.trim();

  // Read branchPrefix
  const prefixResult = await git.run(["config", "--get", "spry.branchPrefix"], { cwd });
  if (prefixResult.exitCode !== 0 || !prefixResult.stdout.trim()) {
    throw new Error(
      `spry.branchPrefix is not configured.\n` +
        `Set it with: git config spry.branchPrefix spry/<your-username>\n` +
        `(Used to derive branch names for synced PRs: <prefix>/<unit-id>)`,
    );
  }
  const branchPrefix = prefixResult.stdout.trim();

  const { owner, repo } = await resolveRepoSlug(git, remote, cwd);

  return { trunk, remote, branchPrefix, owner, repo };
}

/**
 * Resolve the GitHub owner/repo used for PR API queries (`gh api graphql` needs
 * them as explicit variables — gh does not auto-populate them). Prefers an
 * explicit `spry.repo` override (format `owner/repo`); otherwise parses the
 * remote URL. Best-effort: returns undefined fields when neither is available
 * (e.g. a local-path remote in tests), since commands that never touch PRs
 * don't need them.
 */
async function resolveRepoSlug(
  git: GitRunner,
  remote: string,
  cwd?: string,
): Promise<{ owner?: string; repo?: string }> {
  const overrideResult = await git.run(["config", "--get", "spry.repo"], { cwd });
  const override = overrideResult.exitCode === 0 ? overrideResult.stdout.trim() : "";
  if (override) {
    const [owner, repo] = override.split("/");
    if (owner && repo) return { owner, repo };
  }

  const urlResult = await git.run(["remote", "get-url", remote], { cwd });
  if (urlResult.exitCode === 0) {
    const match = urlResult.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) return { owner: match[1], repo: match[2] };
  }

  return {};
}

export async function loadConfig(git: GitRunner, options?: ConfigOptions): Promise<SpryConfig> {
  await checkGitVersion(git);
  return readConfig(git, options);
}
