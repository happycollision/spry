// Launching $EDITOR from inside a TUI that owns the alternate screen buffer.
//
// Used by the group editor to collect a merge commit's message. The message is
// seeded git-style (subject line, blank line, then `#` comment help), and the
// same abort-on-empty convention as git applies: an empty message — or an
// unmodified exit — aborts whatever the edit was for.
//
// The pure seed/parse helpers are separated from the spawn so they can be unit
// tested; the spawn itself is thin and manually verified (it needs a real tty).

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, HIDE_CURSOR, SHOW_CURSOR } from "./screen.ts";

const HELP = [
  "# Lines starting with # are ignored. The first line is the merge commit",
  "# subject. Everything below the blank line is the merge commit body.",
];

/**
 * Subject used when the editor is closed without writing a message.
 *
 * Deliberately a placeholder rather than an abort: by this point the user has
 * already laid out their groups, and discarding that over a skipped message
 * would be a terrible trade. The merge commit is a real commit, so they can
 * reword it with plain git afterward.
 *
 * Identical to what `sp group --apply` synthesizes (src/commands/group.ts), so
 * the interactive and non-interactive paths produce the same commit.
 */
export function placeholderMergeMessage(firstMemberSubject: string): string {
  return `Merge: ${firstMemberSubject || "changes"}`;
}

/** Seed the temp-file contents for a merge message, given the first member's subject. */
export function seedMergeMessage(firstMemberSubject: string): string {
  return [firstMemberSubject, "", ...HELP, ""].join("\n");
}

/**
 * Parse an edited merge-message file: strip `#` comment lines, trim surrounding
 * blank lines, and return the result. An empty result means "abort" (git's
 * convention), signalled here as null.
 */
export function parseMergeMessage(raw: string): string | null {
  const kept = raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  return kept.length === 0 ? null : kept;
}

/** Resolve the editor command, matching git's precedence. */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string {
  return env["EDITOR"] || env["GIT_EDITOR"] || "vi";
}

export interface ExternalEditorIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /**
   * Whether a TUI is currently on screen and should be restored afterward.
   *
   * Merge messages are collected AFTER the group editor exits, so by then there
   * is no TUI to return to: re-entering the alt screen and raw mode would leave
   * the user's shell in raw mode with nothing reading stdin (i.e. an apparently
   * hung terminal). Defaults to false — restore only when explicitly asked.
   */
  restoreTui?: boolean;
}

/**
 * Suspend the TUI, run $EDITOR on a seeded temp file, and resume.
 *
 * Sequence (per the design): leave the alt screen, restore cooked/echo tty so
 * the editor can drive the terminal itself, spawn inheriting the tty and wait,
 * then re-enter raw mode and the alt screen. The caller redraws afterward.
 *
 * Returns the parsed message, or null when the user aborted (empty message or
 * an unmodified exit).
 */
export async function editMessageExternally(
  seed: string,
  io: ExternalEditorIO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "spry-merge-"));
  const file = join(dir, "MERGE_MSG");
  await writeFile(file, seed, "utf8");

  // Hand the terminal to the editor: primary screen, cooked tty, nothing of
  // ours reading stdin. Safe to run even when no TUI is up (the escape codes
  // are no-ops then, and raw mode is already off).
  if (io.restoreTui) io.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  io.stdin.setRawMode?.(false);
  io.stdin.pause();

  try {
    const editor = resolveEditor(env);
    await new Promise<void>((resolve, reject) => {
      // `sh -c` so an editor set with arguments (e.g. "code --wait") works.
      const child = spawn("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", () => resolve());
    });

    const edited = await readFile(file, "utf8");
    // An unmodified exit is an abort, matching git.
    if (edited === seed) return null;
    return parseMergeMessage(edited);
  } finally {
    // Only re-arm the terminal when a TUI is actually going to keep driving it.
    // Otherwise leave it cooked and paused, exactly as the editor left it, so
    // the process can exit cleanly back to the shell.
    if (io.restoreTui) {
      io.stdin.resume();
      io.stdin.setRawMode?.(true);
      io.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    }
    await rm(dir, { recursive: true, force: true });
  }
}
