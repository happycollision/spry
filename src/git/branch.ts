import type { SpryConfig } from "./config.ts";
import type { PRUnit } from "../parse/types.ts";
import type { GitRunner } from "../lib/context.ts";
import { validateBranchName } from "../parse/validation.ts";

export function branchForUnit(unit: PRUnit, config: SpryConfig): string {
  const name = `${config.branchPrefix}/${unit.id}`;
  const validation = validateBranchName(name);
  if (!validation.ok) {
    throw new Error(`Invalid derived branch name '${name}': ${validation.error}`);
  }
  return name;
}

interface GitOpts {
  cwd?: string;
}

/**
 * Resolve a unit's remote-tracking tip (`refs/remotes/<remote>/<prefix>/<id>`)
 * to a SHA, offline. Returns undefined when the tracking ref is absent (e.g. the
 * unit was never pushed, or never fetched). Never throws on a missing ref.
 */
export async function resolveRemoteTrackingTip(
  git: GitRunner,
  unit: PRUnit,
  config: SpryConfig,
  opts?: GitOpts,
): Promise<string | undefined> {
  const ref = `refs/remotes/${config.remote}/${config.branchPrefix}/${unit.id}`;
  const res = await git.run(["rev-parse", "--verify", "--quiet", ref], opts);
  if (res.exitCode !== 0) return undefined;
  const sha = res.stdout.trim();
  return sha === "" ? undefined : sha;
}
