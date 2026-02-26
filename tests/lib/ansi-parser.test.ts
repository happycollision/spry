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
