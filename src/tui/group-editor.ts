import { getMergeBase, checkReorderConflicts } from "../git/index.ts";
import type { GitRunner } from "../lib/context.ts";
import type { CommitWithTrailers } from "../parse/stack.ts";
import type { GroupRecords } from "../parse/types.ts";
import { createInitialState, applyEvent, extractResult } from "./group-state.ts";
import type { GroupEditorResult, GroupEditorState, EditorEvent } from "./group-state.ts";
import { renderGroupEditor, SHOW_CURSOR } from "./group-render.ts";

export interface GroupEditorOptions {
  branch: string;
  trunkRef: string;
  cwd?: string;
  canReorder?: boolean;
}

export async function runGroupEditor(
  git: GitRunner,
  commits: CommitWithTrailers[],
  groupRecords: GroupRecords,
  opts: GroupEditorOptions,
): Promise<GroupEditorResult> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    throw new Error("sp group requires an interactive terminal (stdin is not a TTY)");
  }

  const mergeBase = await getMergeBase(git, opts.trunkRef, { cwd: opts.cwd });
  const originalHashes = commits.map((c) => c.hash);

  let state = createInitialState(commits, groupRecords, { canReorder: opts.canReorder });

  function render(): void {
    stdout.write(renderGroupEditor(state, opts.branch));
  }

  async function updateConflicts(currentState: GroupEditorState): Promise<void> {
    const currentHashes = currentState.rows.map((r) => r.hash);
    try {
      const conflictMap = await checkReorderConflicts(
        git,
        originalHashes,
        currentHashes,
        mergeBase,
        { cwd: opts.cwd },
      );
      const conflictIndices = new Set<number>();
      for (const key of conflictMap.keys()) {
        const [hashA, hashB] = key.split(":");
        currentState.rows.forEach((r, i) => {
          if (r.hash === hashA || r.hash === hashB) conflictIndices.add(i);
        });
      }
      state = applyEvent(state, { type: "conflicts-updated", conflicts: conflictIndices });
      render();
    } catch {
      // conflict prediction is best-effort — ignore errors
    }
  }

  let cleanedUp = false;
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    stdout.write(SHOW_CURSOR + "\n");
    stdin.setRawMode?.(false);
    stdin.pause();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  function onSignal(): void {
    cleanup();
    process.exit(130);
  }

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  stdin.setRawMode?.(true);
  stdin.resume();
  render();

  return new Promise<GroupEditorResult>((resolve) => {
    function onData(chunk: Buffer): void {
      const keys = parseKeys(chunk.toString());

      for (const key of keys) {
        if (state.mode === "normal") {
          if (key === "\r" || key === "\n") {
            stdin.off("data", onData);
            cleanup();
            resolve(extractResult(state));
            return;
          }
          if (key === "q" || key === "\x03" || key === "\x1b") {
            stdin.off("data", onData);
            cleanup();
            resolve({ newOrder: null, updatedRecords: {}, cancelled: true });
            return;
          }
        }

        const event = keyToEvent(key);
        if (!event) continue;

        const prevOrder = state.rows.map((r) => r.hash).join();
        state = applyEvent(state, event);

        // Trigger conflict prediction after each reorder step in move mode
        if (state.mode === "move" && state.rows.map((r) => r.hash).join() !== prevOrder) {
          updateConflicts(state).catch(() => {});
        }
      }

      render();
    }

    stdin.on("data", onData);
  }).finally(cleanup);
}

function parseKeys(data: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i] ?? "";
    if (ch === "\x1b" && data[i + 1] === "[" && i + 2 < data.length) {
      keys.push(data.slice(i, i + 3));
      i += 3;
    } else {
      keys.push(ch);
      i++;
    }
  }
  return keys;
}

function keyToEvent(key: string): EditorEvent | null {
  if (key === "\x1b[A") return { type: "arrow-up" };
  if (key === "\x1b[B") return { type: "arrow-down" };
  if (key === "\x1b[C") return { type: "arrow-right" };
  if (key === "\x1b[D") return { type: "arrow-left" };
  if (key === " ") return { type: "space" };
  if (key === "\r" || key === "\n") return { type: "enter" };
  if (key === "\x1b") return { type: "escape" };
  if (key === "\x7f") return { type: "backspace" };
  if (key.length === 1 && key >= " ") return { type: "char", char: key };
  return null;
}
