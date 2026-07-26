// Shared terminal escape sequences and redraw strategy for the interactive
// TUIs (group editor, multi-select, single-select).
//
// The previous approach prepended a full-screen erase (ESC[2J) plus cursor
// home (ESC[H) to every frame. On most terminals ESC[2J dumps the erased
// screen into scrollback, so each redraw visually scrolled a page and left a
// trail of stale frames (spry-rp65).
//
// Instead we draw on the *alternate screen buffer*: enter it once on startup
// (ENTER_ALT_SCREEN), draw every frame there, and restore the primary buffer
// on exit (EXIT_ALT_SCREEN) — leaving the user's scrollback completely
// untouched. Within the alt buffer each frame homes the cursor and clears to
// the end of the screen (frameReset) so a shorter frame leaves no residue,
// again without pushing anything to scrollback.

const ESC = "\x1b";

/** Switch to the alternate screen buffer (saves cursor + primary screen). */
export const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
/** Restore the primary screen buffer (and cursor) — the exact pre-TUI state. */
export const EXIT_ALT_SCREEN = `${ESC}[?1049l`;

export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;

/**
 * Per-frame reset: home the cursor (ESC[H) then erase from the cursor to the
 * end of the screen (ESC[0J). Prepend to each rendered frame. Deliberately
 * avoids ESC[2J so nothing is pushed to scrollback.
 */
export function frameReset(): string {
  return `${ESC}[H${ESC}[0J`;
}

/** Sequence to write once when entering a TUI. */
export const ENTER_TUI = ENTER_ALT_SCREEN + HIDE_CURSOR;
/** Sequence to write once when leaving a TUI (restores cursor + primary screen). */
export const EXIT_TUI = SHOW_CURSOR + EXIT_ALT_SCREEN;
