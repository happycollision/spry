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
  const major = parseInt(match[1]!, 10);
  const minor = parseInt(match[2]!, 10);
  const version = `${major}.${minor}.${match[3]!}`;
  if (major < 2 || (major === 2 && minor < 40)) {
    throw new Error(
      `spry requires git 2.40 or later (found ${version}).\n` +
        `Update git: https://git-scm.com/downloads`,
    );
  }
  return version;
}
