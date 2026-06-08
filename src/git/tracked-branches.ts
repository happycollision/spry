import type { GitRunner } from "../lib/context.ts";

export const TRACKED_BRANCHES_REF = "refs/spry/local/tracked-branches";

interface GitOpts {
  cwd?: string;
}

export async function loadTrackedBranches(git: GitRunner, opts?: GitOpts): Promise<string[]> {
  const cat = await git.run(["cat-file", "blob", `${TRACKED_BRANCHES_REF}:data`], opts);
  if (cat.exitCode !== 0) return [];
  try {
    return JSON.parse(cat.stdout.trim()) as string[];
  } catch {
    console.error("⚠ tracked-branches: could not parse stored branch list, resetting");
    return [];
  }
}

export async function saveTrackedBranches(
  git: GitRunner,
  branches: string[],
  opts?: GitOpts,
): Promise<void> {
  if (branches.length === 0) {
    await git.run(["update-ref", "-d", TRACKED_BRANCHES_REF], opts);
    return;
  }

  const content = JSON.stringify(branches);
  const blob = await git.run(["hash-object", "-w", "--stdin"], { ...opts, stdin: content });
  if (blob.exitCode !== 0)
    throw new Error(`saveTrackedBranches: hash-object failed: ${blob.stderr}`);

  const treeInput = `100644 blob ${blob.stdout.trim()}\tdata\n`;
  const tree = await git.run(["mktree"], { ...opts, stdin: treeInput });
  if (tree.exitCode !== 0) throw new Error(`saveTrackedBranches: mktree failed: ${tree.stderr}`);

  const commitArgs = ["commit-tree", tree.stdout.trim(), "-m", "update tracked branches"];
  const parent = await git.run(["rev-parse", "--verify", TRACKED_BRANCHES_REF], opts);
  if (parent.exitCode === 0) commitArgs.push("-p", parent.stdout.trim());
  const commit = await git.run(commitArgs, opts);
  if (commit.exitCode !== 0)
    throw new Error(`saveTrackedBranches: commit-tree failed: ${commit.stderr}`);

  const ref = await git.run(["update-ref", TRACKED_BRANCHES_REF, commit.stdout.trim()], opts);
  if (ref.exitCode !== 0) throw new Error(`saveTrackedBranches: update-ref failed: ${ref.stderr}`);
}

export async function registerBranch(
  git: GitRunner,
  branch: string,
  opts?: GitOpts,
): Promise<void> {
  const branches = await loadTrackedBranches(git, opts);
  if (branches.includes(branch)) return;
  await saveTrackedBranches(git, [...branches, branch], opts);
}
