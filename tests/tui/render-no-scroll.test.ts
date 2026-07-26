import { describe, test, expect } from "bun:test";
import { renderGroupEditor } from "../../src/tui/group-render.ts";
import { renderSelectFrame } from "../../src/tui/select.ts";
import { renderSelectOneFrame } from "../../src/tui/select-one.ts";
import { createInitialState } from "../../src/tui/group-state.ts";
import type { CommitWithTrailers } from "../../src/parse/stack.ts";

const ESC = "\x1b";
const FULL_SCREEN_ERASE = `${ESC}[2J`;

function commit(hash: string, subject: string): CommitWithTrailers {
  return { hash, subject, body: "", trailers: { "Spry-Commit-Id": hash } };
}

describe("TUI frames never emit full-screen erase (scrollback pollution)", () => {
  test("renderGroupEditor frame does not contain ESC[2J", () => {
    const state = createInitialState([commit("aaaaaaa", "first"), commit("bbbbbbb", "second")], {});
    const frame = renderGroupEditor(state, "my-branch");
    expect(frame).not.toContain(FULL_SCREEN_ERASE);
  });

  test("renderSelectFrame does not contain ESC[2J", () => {
    const frame = renderSelectFrame(
      [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ],
      new Set(["a"]),
      0,
      {},
    );
    expect(frame).not.toContain(FULL_SCREEN_ERASE);
  });

  test("renderSelectOneFrame does not contain ESC[2J", () => {
    const frame = renderSelectOneFrame(
      [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ],
      1,
      {},
    );
    expect(frame).not.toContain(FULL_SCREEN_ERASE);
  });
});
