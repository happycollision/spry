import type { GitRunner } from "../../tests/lib/context.ts";
import type { SpryConfig } from "./config.ts";
import { trunkRef as getTrunkRef } from "./config.ts";
import {
  getCurrentBranch,
  isDetachedHead,
  getStackCommits,
  getCommitMessage,
  getFullSha,
} from "./queries.ts";
import {
  rewriteCommitChain,
  finalizeRewrite,
  rebasePlumbing,
} from "./plumbing.ts";
import { parseConflictOutput } from "./conflict.ts";
import { parseTrailers, addTrailers } from "../parse/trailers.ts";
import { generateCommitId } from "../parse/id.ts";
import { stat } from "node:fs/promises";
import { join } from "node:path";

// --- Types ---

export interface RebaseOptions {
  cwd?: string;
  branch?: string;
}

export type InjectIdsResult =
  | { ok: true; modifiedCount: number; rebasePerformed: boolean }
  | { ok: false; reason: "detached-head" };

export type RebaseResult =
  | { ok: true; commitCount: number; newTip: string }
  | { ok: false; reason: "detached-head" | "conflict"; conflictFile?: string };

export interface ConflictInfo {
  files: string[];
  currentCommit: string;
  currentSubject: string;
}

// --- Task 16: injectMissingIds ---

export async function injectMissingIds(
  git: GitRunner,
  trunkRef: string,
  options?: RebaseOptions,
): Promise<InjectIdsResult> {
  const cwd = options?.cwd;

  // 1. Check detached HEAD
  if (await isDetachedHead(git, { cwd })) {
    return { ok: false, reason: "detached-head" };
  }

  // 2. Get branch name
  const branch = options?.branch ?? (await getCurrentBranch(git, { cwd }));

  // 3. Get stack commits
  const commits = await getStackCommits(git, trunkRef, { cwd });

  // 4. If empty stack
  if (commits.length === 0) {
    return { ok: true, modifiedCount: 0, rebasePerformed: false };
  }

  // 5-6. Parse trailers and filter missing IDs
  const missingIds: string[] = [];
  for (const commit of commits) {
    const trailers = await parseTrailers(commit.body, git);
    if (!trailers["Spry-Commit-Id"]) {
      missingIds.push(commit.hash);
    }
  }

  // 7. If none missing
  if (missingIds.length === 0) {
    return { ok: true, modifiedCount: 0, rebasePerformed: false };
  }

  // 8. Build rewrites map
  const rewrites = new Map<string, string>();
  for (const hash of missingIds) {
    const id = generateCommitId();
    const originalMessage = await getCommitMessage(git, hash, { cwd });
    const newMessage = await addTrailers(
      originalMessage,
      { "Spry-Commit-Id": id },
      git,
    );
    rewrites.set(hash, newMessage);
  }

  // 9. Rewrite commit chain (all commits, not just missing ones)
  const allHashes = commits.map((c) => c.hash);
  const result = await rewriteCommitChain(git, allHashes, rewrites, { cwd });

  // 10. Finalize rewrite
  const oldTip = allHashes.at(-1) ?? "";
  if (!oldTip) {
    throw new Error("injectMissingIds: unexpected empty commit list");
  }
  await finalizeRewrite(git, branch, oldTip, result.newTip, { cwd });

  return {
    ok: true,
    modifiedCount: missingIds.length,
    rebasePerformed: true,
  };
}

// --- Task 17: rebaseOntoTrunk ---

export async function rebaseOntoTrunk(
  git: GitRunner,
  config: SpryConfig,
  options?: RebaseOptions,
): Promise<RebaseResult> {
  const cwd = options?.cwd;

  // 1. Check detached HEAD
  if (await isDetachedHead(git, { cwd })) {
    return { ok: false, reason: "detached-head" };
  }

  // 2. Get trunk ref
  const ref = getTrunkRef(config);

  // 3. Get stack commits
  const commits = await getStackCommits(git, ref, { cwd });

  // 4. Empty stack
  if (commits.length === 0) {
    const newTip = await getFullSha(git, "HEAD", { cwd });
    return { ok: true, commitCount: 0, newTip };
  }

  // 5. Get onto SHA
  const ontoSha = await getFullSha(git, ref, { cwd });

  // 6. Rebase via plumbing
  const commitHashes = commits.map((c) => c.hash);
  const result = await rebasePlumbing(git, ontoSha, commitHashes, { cwd });

  // 7. Conflict
  if (!result.ok) {
    const parsed = parseConflictOutput(result.conflictInfo);
    return {
      ok: false,
      reason: "conflict",
      conflictFile: parsed.files[0],
    };
  }

  // 8. Success - finalize
  const branch =
    options?.branch ?? (await getCurrentBranch(git, { cwd }));
  const oldTip = commitHashes.at(-1) ?? "";
  if (!oldTip) {
    throw new Error("rebaseOntoTrunk: unexpected empty commit list");
  }
  await finalizeRewrite(git, branch, oldTip, result.newTip, { cwd });

  return {
    ok: true,
    commitCount: commits.length,
    newTip: result.newTip,
  };
}

// --- Task 18: getConflictInfo, formatConflictError ---

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function getConflictInfo(
  git: GitRunner,
  options?: RebaseOptions,
): Promise<ConflictInfo | null> {
  const cwd = options?.cwd;

  // 1-2. Check for rebase-merge or rebase-apply directory
  const rebaseMergeResult = await git.run(
    ["rev-parse", "--git-path", "rebase-merge"],
    { cwd },
  );
  const rebaseApplyResult = await git.run(
    ["rev-parse", "--git-path", "rebase-apply"],
    { cwd },
  );

  const rebaseMergePath = cwd
    ? join(cwd, rebaseMergeResult.stdout.trim())
    : rebaseMergeResult.stdout.trim();
  const rebaseApplyPath = cwd
    ? join(cwd, rebaseApplyResult.stdout.trim())
    : rebaseApplyResult.stdout.trim();

  const inRebaseMerge = await pathExists(rebaseMergePath);
  const inRebaseApply = await pathExists(rebaseApplyPath);

  // 3. If neither exists, not in rebase
  if (!inRebaseMerge && !inRebaseApply) {
    return null;
  }

  // 4. Get conflicted files from git status --porcelain
  const statusResult = await git.run(["status", "--porcelain"], { cwd });
  const conflictPattern = /^(UU|AA|DD|AU|UA|DU|UD) (.+)$/;
  const files: string[] = [];
  for (const line of statusResult.stdout.split("\n")) {
    const match = line.match(conflictPattern);
    if (match) {
      files.push(match[2] ?? "");
    }
  }

  // 5. Get current rebase commit info
  const rebaseHeadResult = await git.run(["rev-parse", "REBASE_HEAD"], { cwd });
  const fullSha = rebaseHeadResult.stdout.trim();
  const currentCommit = fullSha.slice(0, 8);

  const subjectResult = await git.run(
    ["log", "-1", "--format=%s", fullSha],
    { cwd },
  );
  const currentSubject = subjectResult.stdout.trim();

  return { files, currentCommit, currentSubject };
}

export function formatConflictError(info: ConflictInfo): string {
  const lines: string[] = [];
  lines.push(
    `Rebase conflict on commit ${info.currentCommit}: ${info.currentSubject}`,
  );
  lines.push("");
  lines.push("Conflicting files:");
  for (const file of info.files) {
    lines.push(`  - ${file}`);
  }
  lines.push("");
  lines.push("To resolve:");
  lines.push("  1. Fix the conflicts in the files listed above");
  lines.push("  2. Stage the resolved files with: git add <file>");
  lines.push("  3. Continue the rebase with: git rebase --continue");
  lines.push("");
  lines.push("To abort the rebase: git rebase --abort");
  return lines.join("\n");
}
