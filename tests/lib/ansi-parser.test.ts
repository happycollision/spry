import { test, expect } from "bun:test";
import { createScreenBuffer } from "./ansi-parser.ts";

test("plain text writes to buffer at cursor position", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Hello, world!");

  expect(screen.lineAt(0)).toBe("Hello, world!");
  expect(screen.cursor).toEqual({ x: 13, y: 0 });
});

test("newline moves cursor to next line", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Line 1\nLine 2");

  expect(screen.lineAt(0)).toBe("Line 1");
  expect(screen.lineAt(1)).toBe("Line 2");
  expect(screen.cursor).toEqual({ x: 6, y: 1 });
});

test("carriage return moves cursor to start of line", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Hello\rWorld");

  expect(screen.lineAt(0)).toBe("World");
});

test("cursor movement: ESC[nA (up)", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Line 0\nLine 1\nLine 2");
  screen.write("\x1b[2A"); // move up 2 lines

  expect(screen.cursor.y).toBe(0);
});

test("cursor movement: ESC[nB (down)", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Line 0");
  screen.write("\x1b[3B"); // move down 3 lines

  expect(screen.cursor.y).toBe(3);
});

test("cursor movement: ESC[nC (forward)", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("\x1b[5C"); // move forward 5

  expect(screen.cursor.x).toBe(5);
});

test("cursor movement: ESC[nD (back)", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Hello");
  screen.write("\x1b[3D"); // move back 3

  expect(screen.cursor.x).toBe(2);
});

test("cursor positioning: ESC[row;colH", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("\x1b[5;10H"); // row 5, col 10 (1-based)

  expect(screen.cursor).toEqual({ x: 9, y: 4 }); // 0-based
});

test("clear screen: ESC[2J", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Some text on screen");
  screen.write("\x1b[2J");

  expect(screen.lineAt(0)).toBe("");
});

test("clear line: ESC[2K", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("Hello, world!");
  screen.write("\x1b[2K"); // clear entire line

  expect(screen.lineAt(0)).toBe("");
});

test("ignores color/style codes without affecting buffer content", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("\x1b[1m\x1b[31mRed bold\x1b[0m normal");

  expect(screen.lineAt(0)).toBe("Red bold normal");
});

test("cursor hide/show are no-ops for buffer", () => {
  const screen = createScreenBuffer(80, 24);
  screen.write("\x1b[?25l"); // hide
  screen.write("visible");
  screen.write("\x1b[?25h"); // show

  expect(screen.lineAt(0)).toBe("visible");
});

test("scrolls up when newlines push output past the last row", () => {
  const screen = createScreenBuffer(80, 5);
  const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
  screen.write(lines.join("\n"));

  // 8 lines into a 5-row buffer: the first 3 scrolled off, the last 5 remain.
  expect(screen.lineAt(0)).toBe("line 4");
  expect(screen.lineAt(4)).toBe("line 8");
  const snapshot = screen.capture();
  expect(snapshot.text).not.toContain("line 3");
  expect(snapshot.text).toContain("line 8");
});

test("keeps only the last rows of output far exceeding the buffer height", () => {
  const screen = createScreenBuffer(80, 24);
  for (let i = 1; i <= 2000; i++) screen.write(`filler line ${i}\n`);
  screen.write("FINAL SENTINEL LINE");

  const snapshot = screen.capture();
  expect(snapshot.text).toContain("FINAL SENTINEL LINE");
  expect(screen.lineAt(23)).toBe("FINAL SENTINEL LINE");
  expect(snapshot.text).not.toContain("filler line 1977");
  expect(snapshot.text).toContain("filler line 1978");
});

test("a line wrapping past the bottom row also scrolls", () => {
  const screen = createScreenBuffer(10, 3);
  screen.write("aaa\nbbb\n");
  // Cursor is now on the last row; 25 chars wrap across 3 rows, scrolling twice.
  screen.write("0123456789ABCDEFGHIJKLMNO");

  expect(screen.lineAt(0)).toBe("0123456789");
  expect(screen.lineAt(1)).toBe("ABCDEFGHIJ");
  expect(screen.lineAt(2)).toBe("KLMNO");
});

test("writing the bottom-right cell does not scroll until more output follows", () => {
  // Full-screen TUIs paint every cell, including bottom-right, then reposition
  // with CUP. That must not shift the frame.
  const screen = createScreenBuffer(5, 2);
  screen.write("top\n");
  screen.write("12345"); // exactly fills the bottom row
  screen.write("\x1b[1;1H"); // CUP home, as a redraw would

  expect(screen.lineAt(0)).toBe("top");
  expect(screen.lineAt(1)).toBe("12345");
  expect(screen.cursor).toEqual({ x: 0, y: 0 });
});

test("capture returns frozen snapshot", () => {
  const screen = createScreenBuffer(80, 5);
  screen.write("Line 0\nLine 1\nLine 2");

  const snapshot = screen.capture();
  expect(snapshot.lines).toHaveLength(5);
  expect(snapshot.lines[0]).toBe("Line 0");
  expect(snapshot.lines[1]).toBe("Line 1");
  expect(snapshot.lines[2]).toBe("Line 2");
  expect(snapshot.lines[3]).toBe("");
  expect(snapshot.cursor).toEqual({ x: 6, y: 2 });
  expect(snapshot.text).toContain("Line 0\nLine 1\nLine 2");

  // Snapshot is frozen — further writes don't affect it
  screen.write("\nLine 3");
  expect(snapshot.lines[3]).toBe("");
});
