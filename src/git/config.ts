import type { GitRunner } from "../../tests/lib/context.ts";

export interface SpryConfig {
  trunk: string;
  remote: string;
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

async function suggestTrunk(
  git: GitRunner,
  remote: string,
  cwd?: string,
): Promise<string[]> {
  const result = await git.run(
    ["branch", "-r", "--format=%(refname:short)"],
    { cwd },
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  const prefix = `${remote}/`;
  return result.stdout
    .trim()
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith(prefix) && !b.includes("/HEAD"))
    .map((b) => b.slice(prefix.length));
}

export async function readConfig(
  git: GitRunner,
  options?: ConfigOptions,
): Promise<SpryConfig> {
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

  return { trunk, remote };
}

export async function loadConfig(
  git: GitRunner,
  options?: ConfigOptions,
): Promise<SpryConfig> {
  await checkGitVersion(git);
  return readConfig(git, options);
}
