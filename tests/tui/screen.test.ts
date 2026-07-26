import { describe, test, expect } from "bun:test";
import {
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  frameReset,
} from "../../src/tui/screen.ts";

const ESC = "\x1b";
const FULL_SCREEN_ERASE = `${ESC}[2J`;

describe("screen escape sequences", () => {
  test("alt-screen enter/exit use the ?1049 private mode", () => {
    expect(ENTER_ALT_SCREEN).toBe(`${ESC}[?1049h`);
    expect(EXIT_ALT_SCREEN).toBe(`${ESC}[?1049l`);
  });

  test("cursor visibility toggles use the ?25 private mode", () => {
    expect(HIDE_CURSOR).toBe(`${ESC}[?25l`);
    expect(SHOW_CURSOR).toBe(`${ESC}[?25h`);
  });

  test("frameReset homes the cursor and clears to end of screen — never full-screen erase", () => {
    // ESC[2J dumps the prior frame into scrollback on most terminals, which is
    // the scroll-per-redraw bug. A per-frame reset must home + clear-to-end
    // instead so nothing is pushed to scrollback.
    expect(frameReset()).toBe(`${ESC}[H${ESC}[0J`);
    expect(frameReset()).not.toContain(FULL_SCREEN_ERASE);
  });
});
