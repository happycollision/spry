import type { GroupTitles } from "../parse/types.ts";

interface GitOpts {
  cwd?: string;
  stdin?: string;
}

interface GitRunner {
  run(
    args: string[],
    opts?: GitOpts,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const GROUPS_REF = "refs/spry/groups";

export async function loadGroupTitles(git: GitRunner, opts?: GitOpts): Promise<GroupTitles> {
  const ls = await git.run(["ls-tree", GROUPS_REF], opts);
  // Non-zero means the ref doesn't exist yet — normal on first use.
  if (ls.exitCode !== 0) return {};

  const titles: GroupTitles = {};
  for (const line of ls.stdout.trim().split("\n")) {
    if (!line) continue;
    // format: "<mode> blob <sha>\t<name>"
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const groupId = line.slice(tab + 1);
    const cat = await git.run(["cat-file", "blob", `${GROUPS_REF}:${groupId}`], opts);
    if (cat.exitCode !== 0)
      throw new Error(`loadGroupTitles: cat-file failed for ${groupId}: ${cat.stderr}`);
    titles[groupId] = cat.stdout.trim();
  }
  return titles;
}

export async function saveGroupTitle(
  git: GitRunner,
  groupId: string,
  title: string,
  opts?: GitOpts,
): Promise<void> {
  // Write blob
  const blob = await git.run(["hash-object", "-w", "--stdin"], { ...opts, stdin: title });
  if (blob.exitCode !== 0) throw new Error(`saveGroupTitle: hash-object failed: ${blob.stderr}`);
  const blobSha = blob.stdout.trim();

  // Read existing tree entries (excluding this groupId)
  const existing: string[] = [];
  const ls = await git.run(["ls-tree", GROUPS_REF], opts);
  if (ls.exitCode === 0) {
    for (const line of ls.stdout.trim().split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab !== -1 && line.slice(tab + 1) !== groupId) existing.push(line);
    }
  }

  // Build new tree
  const newEntry = `100644 blob ${blobSha}\t${groupId}`;
  const treeInput = [...existing, newEntry].join("\n") + "\n";
  const tree = await git.run(["mktree"], { ...opts, stdin: treeInput });
  if (tree.exitCode !== 0) throw new Error(`saveGroupTitle: mktree failed: ${tree.stderr}`);
  const treeSha = tree.stdout.trim();

  // Create commit (with parent if ref exists)
  const commitArgs = ["commit-tree", treeSha, "-m", `set group title: ${groupId}`];
  const parent = await git.run(["rev-parse", "--verify", GROUPS_REF], opts);
  if (parent.exitCode === 0) commitArgs.push("-p", parent.stdout.trim());
  const commit = await git.run(commitArgs, opts);
  if (commit.exitCode !== 0)
    throw new Error(`saveGroupTitle: commit-tree failed: ${commit.stderr}`);

  // Update ref
  const ref = await git.run(["update-ref", GROUPS_REF, commit.stdout.trim()], opts);
  if (ref.exitCode !== 0) throw new Error(`saveGroupTitle: update-ref failed: ${ref.stderr}`);
}

export async function fetchGroupTitles(
  git: GitRunner,
  remote: string,
  opts?: GitOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const refspec = `${GROUPS_REF}:${GROUPS_REF}`;
  const result = await git.run(["fetch", remote, refspec], opts);
  if (result.exitCode === 0) return { ok: true };
  if (result.stderr.includes("couldn't find remote ref")) return { ok: true };
  return { ok: false, warning: result.stderr.trim() };
}
