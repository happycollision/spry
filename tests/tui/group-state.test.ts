import { describe, expect, test } from "bun:test";
import { applyEvent, createInitialState } from "../../src/tui/group-state.ts";
import { renderGroupEditor } from "../../src/tui/group-render.ts";
import type { CommitWithTrailers } from "../../src/parse/stack.ts";

function commits(): CommitWithTrailers[] {
  return [
    {
      hash: "1111111111111111111111111111111111111111",
      subject: "First commit",
      body: "",
      trailers: { "Spry-Commit-Id": "aaa11111" },
    },
    {
      hash: "2222222222222222222222222222222222222222",
      subject: "Second commit",
      body: "",
      trailers: { "Spry-Commit-Id": "bbb22222" },
    },
  ];
}

describe("group editor reorder availability", () => {
  test("clean working tree allows entering move mode with Space", () => {
    const state = createInitialState(commits(), {}, { canReorder: true });

    const next = applyEvent(state, { type: "space" });

    expect(next.mode).toBe("move");
    expect(next.grabbed).toBe(0);
    expect(renderGroupEditor(next, "feature/x")).toContain("MOVE MODE");
    expect(renderGroupEditor(next, "feature/x")).not.toContain("Reordering disabled");
  });

  test("dirty working tree warns and keeps Space from entering move mode", () => {
    const state = createInitialState(commits(), {}, { canReorder: false });

    const next = applyEvent(state, { type: "space" });
    const rendered = renderGroupEditor(next, "feature/x");

    expect(next.mode).toBe("normal");
    expect(next.grabbed).toBeNull();
    expect(rendered).toContain("Reordering disabled");
    expect(rendered).toContain("working tree is dirty");
    expect(rendered).not.toContain("MOVE MODE");
  });
});
