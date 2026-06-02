import type { GroupTitles } from "../parse/types.ts";

interface GitOpts {
  cwd?: string;
}

interface GitRunner {
  run(
    args: string[],
    opts?: GitOpts,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export async function loadGroupTitles(git: GitRunner, opts?: GitOpts): Promise<GroupTitles> {
  const result = await git.run(["config", "--local", "--get-regexp", "^spry-group\\."], opts);
  if (result.exitCode !== 0) return {};

  const titles: GroupTitles = {};
  for (const line of result.stdout.trim().split("\n")) {
    if (!line) continue;
    // Format: spry-group.<id>.title <value>
    const match = line.match(/^spry-group\.([^.]+)\.title\s+(.+)$/);
    if (match) {
      const [, id, value] = match;
      if (id && value) titles[id] = value;
    }
  }
  return titles;
}

export async function saveGroupTitle(
  git: GitRunner,
  groupId: string,
  title: string,
  opts?: GitOpts,
): Promise<void> {
  await git.run(["config", "--local", `spry-group.${groupId}.title`, title], opts);
}
