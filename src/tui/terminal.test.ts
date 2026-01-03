import { test, expect, describe } from "bun:test";
import { parseKeypress } from "./terminal.ts";

describe("parseKeypress", () => {
  describe("Shift+arrow keys", () => {
    test("Shift+Up is detected with shift flag", () => {
      // ESC [ 1 ; 2 A
      const shiftUp = Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x41]);
      const result = parseKeypress(shiftUp);
      expect(result.name).toBe("up");
      expect(result.shift).toBe(true);
      expect(result.ctrl).toBe(false);
      expect(result.meta).toBe(false);
    });

    test("Shift+Down is detected with shift flag", () => {
      const shiftDown = Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x42]);
      const result = parseKeypress(shiftDown);
      expect(result.name).toBe("down");
      expect(result.shift).toBe(true);
    });

    test("Shift+Left is detected with shift flag", () => {
      const shiftLeft = Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x44]);
      const result = parseKeypress(shiftLeft);
      expect(result.name).toBe("left");
      expect(result.shift).toBe(true);
    });

    test("Shift+Right is detected with shift flag", () => {
      const shiftRight = Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x43]);
      const result = parseKeypress(shiftRight);
      expect(result.name).toBe("right");
      expect(result.shift).toBe(true);
    });
  });

  describe("regular arrow keys", () => {
    test("Up arrow without modifiers", () => {
      const up = Buffer.from([0x1b, 0x5b, 0x41]);
      const result = parseKeypress(up);
      expect(result.name).toBe("up");
      expect(result.shift).toBe(false);
      expect(result.meta).toBe(false);
    });

    test("Down arrow without modifiers", () => {
      const down = Buffer.from([0x1b, 0x5b, 0x42]);
      const result = parseKeypress(down);
      expect(result.name).toBe("down");
      expect(result.shift).toBe(false);
    });
  });

  describe("Ctrl+arrow keys", () => {
    test("Ctrl+Up is detected with ctrl flag", () => {
      const ctrlUp = Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x41]);
      const result = parseKeypress(ctrlUp);
      expect(result.name).toBe("up");
      expect(result.ctrl).toBe(true);
      expect(result.shift).toBe(false);
    });
  });

  describe("Alt+arrow keys", () => {
    test("Alt+Up is detected with meta flag", () => {
      const altUp = Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41]);
      const result = parseKeypress(altUp);
      expect(result.name).toBe("up");
      expect(result.meta).toBe(true);
    });
  });
});
