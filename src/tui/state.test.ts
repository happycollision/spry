import { test, expect, describe } from "bun:test";
import {
  createInitialState,
  quickSwap,
  moveCursor,
  toggleMoveMode,
  type CommitDisplay,
} from "./state.ts";

function makeCommits(count: number): CommitDisplay[] {
  return Array.from({ length: count }, (_, i) => ({
    hash: `hash${i}`,
    shortHash: `hash${i}`.slice(0, 8),
    subject: `Commit ${i}`,
  }));
}

describe("quickSwap", () => {
  test("swaps commit up without entering move mode", () => {
    const commits = makeCommits(3);
    const state = createInitialState(commits);

    // Move cursor to middle commit (index 1)
    const stateWithCursor = { ...state, cursor: 1 };

    // Quick swap up
    const result = quickSwap(stateWithCursor, "up");

    // Commit should have moved up
    expect(result.commits[0]?.hash).toBe("hash1");
    expect(result.commits[1]?.hash).toBe("hash0");

    // Cursor should follow the commit
    expect(result.cursor).toBe(0);

    // Move mode should NOT be entered
    expect(result.moveMode).toBeNull();

    // State should be dirty
    expect(result.dirty).toBe(true);
  });

  test("swaps commit down without entering move mode", () => {
    const commits = makeCommits(3);
    const state = createInitialState(commits);

    // Cursor at index 1
    const stateWithCursor = { ...state, cursor: 1 };

    // Quick swap down
    const result = quickSwap(stateWithCursor, "down");

    expect(result.commits[1]?.hash).toBe("hash2");
    expect(result.commits[2]?.hash).toBe("hash1");
    expect(result.cursor).toBe(2);
    expect(result.moveMode).toBeNull();
  });

  test("does nothing when at top and swapping up", () => {
    const commits = makeCommits(3);
    const state = createInitialState(commits);

    // Cursor at top (index 0)
    const result = quickSwap(state, "up");

    // State should be unchanged
    expect(result).toBe(state);
    expect(result.cursor).toBe(0);
    expect(result.dirty).toBe(false);
  });

  test("does nothing when at bottom and swapping down", () => {
    const commits = makeCommits(3);
    const state = createInitialState(commits);

    // Move cursor to bottom
    const stateAtBottom = { ...state, cursor: 2 };

    const result = quickSwap(stateAtBottom, "down");

    // State should be unchanged
    expect(result).toBe(stateAtBottom);
    expect(result.cursor).toBe(2);
  });

  test("swaps group assignments along with commits", () => {
    const commits = makeCommits(3);
    const state = createInitialState(commits);

    // Assign group A to commit at index 0
    state.groups.set(0, "A");
    state.groups.set(1, "B");

    // Cursor at index 1
    const stateWithCursor = { ...state, cursor: 1 };

    // Quick swap up (commit 1 goes to position 0)
    const result = quickSwap(stateWithCursor, "up");

    // Groups should have swapped
    expect(result.groups.get(0)).toBe("B"); // was at index 1
    expect(result.groups.get(1)).toBe("A"); // was at index 0
  });
});

describe("quickSwap vs regular move mode", () => {
  test("quickSwap does not affect moveMode state", () => {
    const commits = makeCommits(3);
    const state = createInitialState(commits);
    const stateWithCursor = { ...state, cursor: 1 };

    // Quick swap should not enter move mode
    const afterQuickSwap = quickSwap(stateWithCursor, "up");
    expect(afterQuickSwap.moveMode).toBeNull();

    // Regular toggleMoveMode should enter move mode
    const afterToggle = toggleMoveMode(stateWithCursor);
    expect(afterToggle.moveMode).toBe(1);
  });

  test("quickSwap works even when in move mode", () => {
    const commits = makeCommits(3);
    const state = createInitialState(commits);

    // Enter move mode at index 1
    const inMoveMode = toggleMoveMode({ ...state, cursor: 1 });
    expect(inMoveMode.moveMode).toBe(1);

    // Quick swap still works
    const afterQuickSwap = quickSwap(inMoveMode, "up");
    expect(afterQuickSwap.commits[0]?.hash).toBe("hash1");
    expect(afterQuickSwap.cursor).toBe(0);
  });
});
