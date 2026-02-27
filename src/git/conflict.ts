import type { GitRunner } from "../../tests/lib/context.ts";
import { mergeTree } from "./plumbing.ts";

export interface ConflictOptions {
  cwd?: string;
}

export interface ConflictResult {
  status: "clean" | "warning" | "conflict";
  files?: string[];
}

// --- Task 14: getCommitFiles, checkFileOverlap, parseConflictOutput ---

export async function getCommitFiles(
  git: GitRunner,
  hash: string,
  options?: ConflictOptions,
): Promise<string[]> {
  const result = await git.run(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", hash],
    { cwd: options?.cwd },
  );
  const trimmed = result.stdout.trim();
  if (!trimmed) return [];
  return trimmed.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function checkFileOverlap(
  git: GitRunner,
  commitA: string,
  commitB: string,
  options?: ConflictOptions,
): Promise<string[]> {
  const [filesA, filesB] = await Promise.all([
    getCommitFiles(git, commitA, options),
    getCommitFiles(git, commitB, options),
  ]);
  const setB = new Set(filesB);
  return filesA.filter((f) => setB.has(f));
}

export function parseConflictOutput(output: string): { files: string[] } {
  const regex =
    /CONFLICT \([^)]+\): (?:Merge conflict in|Add\/add|Rename\/rename) (.+)/g;
  const files = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    files.add((match[1] ?? "").trim());
  }
  return { files: [...files] };
}

// --- Task 15: simulateMerge, predictConflict, checkReorderConflicts ---

export async function simulateMerge(
  git: GitRunner,
  base: string,
  commitA: string,
  commitB: string,
  overlappingFiles: string[],
  options?: ConflictOptions,
): Promise<ConflictResult> {
  const result = await mergeTree(git, base, commitA, commitB, options);

  if (!result.ok) {
    const parsed = parseConflictOutput(result.conflictInfo);
    return {
      status: "conflict",
      files: parsed.files.length > 0 ? parsed.files : overlappingFiles,
    };
  }

  if (overlappingFiles.length > 0) {
    return { status: "warning", files: overlappingFiles };
  }

  return { status: "clean" };
}

export async function predictConflict(
  git: GitRunner,
  commitA: string,
  commitB: string,
  mergeBase: string,
  options?: ConflictOptions,
): Promise<ConflictResult> {
  const overlap = await checkFileOverlap(git, commitA, commitB, options);

  if (overlap.length === 0) {
    return { status: "clean" };
  }

  return simulateMerge(git, mergeBase, commitA, commitB, overlap, options);
}

export async function checkReorderConflicts(
  git: GitRunner,
  currentOrder: string[],
  newOrder: string[],
  mergeBase: string,
  options?: ConflictOptions,
): Promise<Map<string, ConflictResult>> {
  const results = new Map<string, ConflictResult>();

  // Build position maps
  const currentPos = new Map<string, number>();
  for (let i = 0; i < currentOrder.length; i++) {
    const current = currentOrder[i];
    if (current !== undefined) currentPos.set(current, i);
  }

  const newPos = new Map<string, number>();
  for (let i = 0; i < newOrder.length; i++) {
    const item = newOrder[i];
    if (item !== undefined) newPos.set(item, i);
  }

  // Check each pair in new order where relative order changed
  for (let i = 0; i < newOrder.length; i++) {
    for (let j = i + 1; j < newOrder.length; j++) {
      const a = newOrder[i] ?? "";
      const b = newOrder[j] ?? "";

      const oldPosA = currentPos.get(a);
      const oldPosB = currentPos.get(b);

      // Only check pairs whose relative order changed
      if (oldPosA === undefined || oldPosB === undefined) continue;
      if (oldPosA < oldPosB) continue; // same relative order

      const key = `${a}:${b}`;
      const result = await predictConflict(git, a, b, mergeBase, options);
      if (result.status !== "clean") {
        results.set(key, result);
      }
    }
  }

  return results;
}
