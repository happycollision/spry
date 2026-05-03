import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { docTest, fragmentPath } from "./doc.ts";

const repoRoot = join(import.meta.dir, "../..");
const fragmentsDir = join(repoRoot, ".test-tmp/doc-fragments");

const cleanupPaths = [
  "doc__disk_bridge__unit--900.json",
  "doc__scrub__literal--901.json",
  "doc__scrub__regex--902.json",
  "doc__scrub__repo--903.json",
];

beforeAll(async () => {
  await Promise.all(cleanupPaths.map((p) => rm(join(fragmentsDir, p), { force: true })));
});

afterAll(async () => {
  await Promise.all(cleanupPaths.map((p) => rm(join(fragmentsDir, p), { force: true })));
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

docTest(
  "scrub replaces literal strings in captured entries",
  { section: "doc/scrub/literal", order: 901 },
  async (doc) => {
    doc.scrub("SECRET", "<redacted>");
    doc.command("echo SECRET");
    doc.output("value=SECRET");
    doc.screen("frame SECRET");
    doc.prose("prose SECRET");
  },
);

test("scrub literal: command/output/screen are scrubbed, prose is not", async () => {
  const path = fragmentPath({ section: "doc/scrub/literal", order: 901 });
  const parsed = JSON.parse(await readFile(path, "utf8"));
  expect(parsed.entries).toEqual([
    { type: "command", content: "echo <redacted>" },
    { type: "output", content: "value=<redacted>" },
    { type: "screen", content: "frame <redacted>" },
    { type: "prose", content: "prose SECRET" },
  ]);
});

docTest("scrub accepts regex patterns", { section: "doc/scrub/regex", order: 902 }, async (doc) => {
  doc.scrub(/[0-9]+/g, "N");
  doc.output("port=8080 retries=3");
});

test("scrub regex: replaces all matches", async () => {
  const path = fragmentPath({ section: "doc/scrub/regex", order: 902 });
  const parsed = JSON.parse(await readFile(path, "utf8"));
  expect(parsed.entries).toEqual([{ type: "output", content: "port=N retries=N" }]);
});

docTest(
  "scrub(repo) replaces uniqueId and paths",
  { section: "doc/scrub/repo", order: 903 },
  async (doc) => {
    const fakeRepo = {
      uniqueId: "pure-goat-vx6",
      path: "/tmp/spry-test-pure-goat-vx6",
      originPath: "/tmp/spry-test-origin-pure-goat-vx6",
    };
    doc.scrub(fakeRepo);
    doc.output(
      "branch=feature-pure-goat-vx6 cwd=/tmp/spry-test-pure-goat-vx6 origin=/tmp/spry-test-origin-pure-goat-vx6",
    );
  },
);

test("scrub(repo): paths replaced as a unit, dashed uniqueId collapses, bare uniqueId stripped", async () => {
  const path = fragmentPath({ section: "doc/scrub/repo", order: 903 });
  const parsed = JSON.parse(await readFile(path, "utf8"));
  expect(parsed.entries).toEqual([
    {
      type: "output",
      content: "branch=feature cwd=/tmp/repo origin=/tmp/repo-origin",
    },
  ]);
});
