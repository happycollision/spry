import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { docTest, fragmentPath } from "./doc.ts";

const repoRoot = join(import.meta.dir, "../..");
const fragmentsDir = join(repoRoot, ".test-tmp/doc-fragments");

beforeAll(async () => {
  await rm(join(fragmentsDir, "doc__disk_bridge__unit--900.json"), { force: true });
});

afterAll(async () => {
  await rm(join(fragmentsDir, "doc__disk_bridge__unit--900.json"), { force: true });
});

docTest(
  "writes fragment to disk on pass",
  { section: "doc/disk_bridge/unit", order: 900 },
  async (doc) => {
    doc.prose("unit-test fragment");
  },
);

test("docTest wrote the fragment JSON after running", async () => {
  const path = fragmentPath({ section: "doc/disk_bridge/unit", order: 900 });
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  expect(parsed.section).toBe("doc/disk_bridge/unit");
  expect(parsed.order).toBe(900);
  expect(parsed.entries).toEqual([{ type: "prose", content: "unit-test fragment" }]);
});

test("fragmentPath escapes slashes and pads order", () => {
  const path = fragmentPath({ section: "commands/view", order: 10 });
  expect(path.endsWith("/commands__view--010.json")).toBe(true);
});
