import { getMergeBase, checkReorderConflicts } from "../git/index.ts";
import type { GitRunner } from "../lib/context.ts";
import type { CommitWithTrailers } from "../parse/stack.ts";
import type { GroupRecords } from "../parse/types.ts";
import {
  createInitialState,
  applyEvent,
  extractResult,
  validateMergeGroups,
} from "./group-state.ts";
import type { GroupEditorResult, GroupEditorState, EditorEvent } from "./group-state.ts";
import { renderGroupEditor } from "./group-render.ts";
import { ENTER_TUI, EXIT_TUI } from "./screen.ts";
import {
  editMessageExternally,
  seedMergeMessage,
  placeholderMergeMessage,
} from "./external-editor.ts";
import type { MergeGroupResult } from "./group-state.ts";
import type { CommitMergeGroupMap } from "../parse/types.ts";

export interface GroupEditorOptions {
  branch: string;
  trunkRef: string;
  cwd?: string;
  canReorder?: boolean;
  // Existing merge groups (commitId → merge-group id) and their current merge
  // commit messages (by merge-group id), so already-materialized merges load
  // into the editor instead of appearing unmerged.
  mergeGroups?: CommitMergeGroupMap;
  mergeMessages?: Record<string, string>;
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

  let state = createInitialState(commits, groupRecords, {
    canReorder: opts.canReorder,
    mergeGroups: opts.mergeGroups,
    mergeMessages: opts.mergeMessages,
  });

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
    stdout.write(EXIT_TUI);
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
  stdout.write(ENTER_TUI);
  render();

  return new Promise<GroupEditorResult>((resolve) => {
    function onData(chunk: Buffer): void {
      const keys = parseKeys(chunk.toString());

      for (const key of keys) {
        if (state.mode === "normal") {
          if (key === "\r" || key === "\n") {
            // Invalid merge groups are allowed while editing but not on save —
            // surface them and keep the editor open instead of silently
            // "fixing" the user's intent.
            const problems = validateMergeGroups(state);
            if (problems.length > 0) {
              state = { ...state, problems };
              render();
              continue;
            }
            stdin.off("data", onData);
            cleanup();
            resolve(extractResult(state));
            return;
          }
          if (key === "q" || key === "\x03" || key === "\x1b") {
            stdin.off("data", onData);
            cleanup();
            resolve({
              newOrder: null,
              updatedRecords: {},
              mergeGroups: [],
              mergeChanged: false,
              cancelled: true,
            });
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

export interface CollectMessagesResult {
  mergeGroups: MergeGroupResult[];
  // Groups that got the synthesized placeholder because the editor was closed
  // without a message — reported so the command layer can say so.
  placeheld: number;
}

/**
 * Collect merge commit messages AFTER the TUI has exited.
 *
 * Deliberately not done while editing: the user is experimenting with where
 * merges go, and an editor popping up on every `⇧→` would make that unusable.
 * By the time this runs the layout is settled, so each new group gets exactly
 * one editor pass, seeded git-style from its first member's subject.
 *
 * Closing the editor without writing a message does NOT abort — the group is
 * created with the same placeholder subject `--apply` synthesizes. Discarding
 * a whole layout over a skipped message would be a bad trade, and the merge
 * commit can be reworded later with plain git.
 */
export async function collectMergeMessages(
  mergeGroups: MergeGroupResult[],
  io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } = {
    stdin: process.stdin,
    stdout: process.stdout,
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<CollectMessagesResult> {
  const out: MergeGroupResult[] = [];
  let placeheld = 0;
  for (const group of mergeGroups) {
    if (!group.needsMessage) {
      out.push(group);
      continue;
    }
    const edited = await editMessageExternally(seedMergeMessage(group.firstSubject), io, env);
    const message = edited ?? placeholderMergeMessage(group.firstSubject);
    if (edited === null) placeheld++;
    out.push({ ...group, message, needsMessage: false });
  }
  return { mergeGroups: out, placeheld };
}

// CSI sequences end at the first byte in the 0x40–0x7e range, so a modified
// arrow ("\x1b[1;2A", shift-up) is consumed whole rather than split into a bare
// escape plus stray characters (which is what a fixed 3-byte slice would do).
export function parseKeys(data: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i] ?? "";
    if (ch === "\x1b" && data[i + 1] === "[") {
      let j = i + 2;
      while (j < data.length) {
        const code = data.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) break;
        j++;
      }
      if (j < data.length) {
        keys.push(data.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }
    keys.push(ch);
    i++;
  }
  return keys;
}

// Modifier-encoded arrows: "\x1b[1;<mod><letter>", where mod is 1 + a bitmask
// (shift 1, alt 2, ctrl 4). So 2 = shift, 5 = ctrl, and 6/7/8 are ctrl with
// shift/alt also held — mapped here too so a stray extra modifier still works.
//
// NB: a terminal cannot report a modifier key on its own; it only ever delivers
// a key WITH its modifiers applied. So "hold shift to grab" is really "shift
// plus an arrow moves the commit", which feels the same when tapping arrows
// with shift held down.
const MODIFIED_ARROWS: Record<string, EditorEvent> = {
  // Shift — move the commit under the cursor / merge toggles.
  "\x1b[1;2A": { type: "shift-arrow-up" },
  "\x1b[1;2B": { type: "shift-arrow-down" },
  "\x1b[1;2C": { type: "shift-arrow-right" },
  "\x1b[1;2D": { type: "shift-arrow-left" },
  // Ctrl — jump to the next group boundary.
  "\x1b[1;5A": { type: "ctrl-arrow-up" },
  "\x1b[1;5B": { type: "ctrl-arrow-down" },
  "\x1b[1;6A": { type: "ctrl-arrow-up" },
  "\x1b[1;6B": { type: "ctrl-arrow-down" },
  // Cmd on some terminals reports as meta/alt.
  "\x1b[1;3A": { type: "ctrl-arrow-up" },
  "\x1b[1;3B": { type: "ctrl-arrow-down" },
  "\x1b[1;9A": { type: "ctrl-arrow-up" },
  "\x1b[1;9B": { type: "ctrl-arrow-down" },
};

export function keyToEvent(key: string): EditorEvent | null {
  const modified = MODIFIED_ARROWS[key];
  if (modified) return modified;
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
