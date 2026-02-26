import { test, expect, afterEach } from "bun:test";
import { collectFragment, getDocFragments, clearDocFragments } from "./doc.ts";

afterEach(() => {
  clearDocFragments();
});

test("collectFragment registers a fragment", () => {
  collectFragment({
    title: "Example feature",
    section: "commands/example",
    order: 10,
    entries: [
      { type: "prose", content: "This demonstrates the feature." },
      { type: "command", content: "sp example --flag" },
      { type: "output", content: "Example output here" },
    ],
  });

  const fragments = getDocFragments();
  expect(fragments).toHaveLength(1);
  expect(fragments[0]!.section).toBe("commands/example");
  expect(fragments[0]!.entries).toHaveLength(3);
});

test("multiple fragments accumulate", () => {
  collectFragment({
    title: "Second",
    section: "commands/sync",
    order: 20,
    entries: [{ type: "prose", content: "Second section" }],
  });
  collectFragment({
    title: "First",
    section: "commands/sync",
    order: 10,
    entries: [{ type: "prose", content: "First section" }],
  });

  const fragments = getDocFragments();
  expect(fragments).toHaveLength(2);
});

test("clearDocFragments resets state", () => {
  collectFragment({
    title: "Will be cleared",
    section: "test",
    order: 1,
    entries: [],
  });

  clearDocFragments();
  expect(getDocFragments()).toHaveLength(0);
});
