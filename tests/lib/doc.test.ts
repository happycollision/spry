import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { collectFragment, getDocFragments, clearDocFragments, docTest } from "./doc.ts";

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

const repoRoot = join(import.meta.dir, "../..");
const fragmentsDir = join(repoRoot, ".test-tmp/doc-fragments");

afterEach(async () => {
  await rm(join(fragmentsDir, "doc__disk_bridge__unit--900.json"), {
    force: true,
  });
});

// docTest registers a bun test internally. It must run at module load time.
docTest(
  "writes fragment to disk on pass",
  { section: "doc/disk_bridge/unit", order: 900 },
  async (doc) => {
    doc.prose("unit-test fragment");
  },
);

test("docTest wrote the fragment JSON after running", async () => {
  const path = join(fragmentsDir, "doc__disk_bridge__unit--900.json");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  expect(parsed.section).toBe("doc/disk_bridge/unit");
  expect(parsed.order).toBe(900);
  expect(parsed.entries).toEqual([{ type: "prose", content: "unit-test fragment" }]);
});
