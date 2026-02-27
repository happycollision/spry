import type { GitRunner } from "../../tests/lib/context.ts";

export interface PlumbingOptions {
  cwd?: string;
}

// --- Task 8: getTree, getParent, getParents ---

export async function getTree(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", `${commit}^{tree}`], {
    cwd: options?.cwd,
  });
  return result.stdout.trim();
}

export async function getParent(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", `${commit}^`], {
    cwd: options?.cwd,
  });
  return result.stdout.trim();
}

export async function getParents(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string[]> {
  const result = await git.run(["rev-parse", `${commit}^@`], {
    cwd: options?.cwd,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- Task 9: getAuthorEnv, getAuthorAndCommitterEnv, createCommit ---

export async function getAuthorEnv(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<Record<string, string>> {
  const result = await git.run(
    ["log", "-1", "--format=%an%x00%ae%x00%ai", commit],
    { cwd: options?.cwd },
  );
  const [name, email, date] = result.stdout.trim().split("\x00");
  return {
    GIT_AUTHOR_NAME: name ?? "",
    GIT_AUTHOR_EMAIL: email ?? "",
    GIT_AUTHOR_DATE: date ?? "",
  };
}

export async function getAuthorAndCommitterEnv(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<Record<string, string>> {
  const result = await git.run(
    ["log", "-1", "--format=%an%x00%ae%x00%ai%x00%cn%x00%ce%x00%ci", commit],
    { cwd: options?.cwd },
  );
  const [aName, aEmail, aDate, cName, cEmail, cDate] = result.stdout
    .trim()
    .split("\x00");
  return {
    GIT_AUTHOR_NAME: aName ?? "",
    GIT_AUTHOR_EMAIL: aEmail ?? "",
    GIT_AUTHOR_DATE: aDate ?? "",
    GIT_COMMITTER_NAME: cName ?? "",
    GIT_COMMITTER_EMAIL: cEmail ?? "",
    GIT_COMMITTER_DATE: cDate ?? "",
  };
}

export async function createCommit(
  git: GitRunner,
  tree: string,
  parents: string[],
  message: string,
  env: Record<string, string>,
  options?: PlumbingOptions,
): Promise<string> {
  const args = ["commit-tree", tree];
  for (const p of parents) {
    args.push("-p", p);
  }
  const result = await git.run(args, {
    cwd: options?.cwd,
    env,
    stdin: message,
  });
  return result.stdout.trim();
}

// --- Task 10: mergeTree, updateRef, resetToCommit ---

export type MergeTreeResult =
  | { ok: true; tree: string }
  | { ok: false; conflictInfo: string };

export async function mergeTree(
  git: GitRunner,
  base: string,
  ours: string,
  theirs: string,
  options?: PlumbingOptions,
): Promise<MergeTreeResult> {
  const result = await git.run(
    ["merge-tree", "--write-tree", `--merge-base=${base}`, ours, theirs],
    { cwd: options?.cwd },
  );
  if (result.exitCode !== 0) {
    return { ok: false, conflictInfo: result.stdout + result.stderr };
  }
  return { ok: true, tree: result.stdout.trim().split("\n")[0] ?? "" };
}

export async function updateRef(
  git: GitRunner,
  ref: string,
  newSha: string,
  oldSha?: string,
  options?: PlumbingOptions,
): Promise<void> {
  const args = ["update-ref", ref, newSha];
  if (oldSha) {
    args.push(oldSha);
  }
  await git.run(args, { cwd: options?.cwd });
}

export async function resetToCommit(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<void> {
  await git.run(["reset", "--hard", commit], { cwd: options?.cwd });
}

// --- Task 11: rewriteCommitChain ---

export interface ChainRewriteResult {
  newTip: string;
  mapping: Map<string, string>;
}

async function getCommitMessageInternal(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string> {
  const result = await git.run(["log", "-1", "--format=%B", commit], {
    cwd: options?.cwd,
  });
  return result.stdout.replace(/\n+$/, "");
}

export async function rewriteCommitChain(
  git: GitRunner,
  commits: string[],
  rewrites: Map<string, string>,
  options?: PlumbingOptions,
): Promise<ChainRewriteResult> {
  const mapping = new Map<string, string>();
  let previousNewSha: string | null = null;

  for (const commit of commits) {
    const tree = await getTree(git, commit, options);
    const env = await getAuthorAndCommitterEnv(git, commit, options);
    const message =
      rewrites.get(commit) ??
      (await getCommitMessageInternal(git, commit, options));

    // Determine parent: use rewritten parent if available, else original parent
    const originalParents = await getParents(git, commit, options);
    const parents: string[] = [];
    if (previousNewSha) {
      parents.push(previousNewSha);
    } else if (originalParents.length > 0) {
      parents.push(originalParents[0] ?? "");
    }

    const newSha = await createCommit(git, tree, parents, message, env, options);
    mapping.set(commit, newSha);
    previousNewSha = newSha;
  }

  if (!previousNewSha) {
    throw new Error("rewriteCommitChain: no commits were rewritten");
  }
  return { newTip: previousNewSha, mapping };
}

// --- Task 12: rebasePlumbing, finalizeRewrite ---

export type PlumbingRebaseResult =
  | { ok: true; newTip: string; mapping: Map<string, string> }
  | { ok: false; conflictCommit: string; conflictInfo: string };

export async function rebasePlumbing(
  git: GitRunner,
  onto: string,
  commits: string[],
  options?: PlumbingOptions,
): Promise<PlumbingRebaseResult> {
  if (commits.length === 0) {
    return { ok: true, newTip: onto, mapping: new Map() };
  }

  const mapping = new Map<string, string>();
  let currentTip = onto;

  for (const commit of commits) {
    const originalParents = await getParents(git, commit, options);
    const originalParent = originalParents[0] ?? "";
    const mergeResult = await mergeTree(
      git,
      originalParent,
      currentTip,
      commit,
      options,
    );

    if (!mergeResult.ok) {
      return {
        ok: false,
        conflictCommit: commit,
        conflictInfo: mergeResult.conflictInfo,
      };
    }

    const env = await getAuthorAndCommitterEnv(git, commit, options);
    const message = await getCommitMessageInternal(git, commit, options);
    const newSha = await createCommit(
      git,
      mergeResult.tree,
      [currentTip],
      message,
      env,
      options,
    );

    mapping.set(commit, newSha);
    currentTip = newSha;
  }

  return { ok: true, newTip: currentTip, mapping };
}

export async function finalizeRewrite(
  git: GitRunner,
  branch: string,
  oldTip: string,
  newTip: string,
  options?: PlumbingOptions,
): Promise<void> {
  const oldTree = await getTree(git, oldTip, options);
  const newTree = await getTree(git, newTip, options);

  await updateRef(git, `refs/heads/${branch}`, newTip, oldTip, options);

  if (oldTree !== newTree) {
    await resetToCommit(git, newTip, options);
  }
}
