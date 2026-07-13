import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { docTest, fragmentPath } from "./doc.ts";
import type { ScreenSnapshot } from "./ansi-parser.ts";

const repoRoot = join(import.meta.dir, "../..");
const fragmentsDir = join(repoRoot, ".test-tmp/doc-fragments");

const cleanupPaths = [
  "doc__disk_bridge__unit--900.json",
  "doc__scrub__literal--901.json",
  "doc__scrub__regex--902.json",
  "doc__scrub__repo--903.json",
  "doc__output_ansi__unit--911.json",
  "doc__output_ansi__unit--912.json",
  "doc__screen_ansi__unit--913.json",
];

beforeAll(async () => {
  await Promise.all(cleanupPaths.map((p) => rm(join(fragmentsDir, p), { force: true })));
});

afterAll(async () => {
  await Promise.all(cleanupPaths.map((p) => rm(join(fragmentsDir, p), { force: true })));
});

// Each verification test below reads the fragment its paired docTest writes.
// Under `bun test --concurrent` the pair may run in either order, so wait for
// the fragment to appear instead of assuming the docTest already finished.
// (beforeAll removed any stale copy, so an existing file is from this run.)
async function waitForFragment(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() > deadline) throw new Error(`fragment never appeared: ${path}`);
      await Bun.sleep(20);
    }
  }
}

docTest(
  "writes fragment to disk on pass",
  { section: "doc/disk_bridge/unit", order: 900 },
  async (doc) => {
    doc.prose("unit-test fragment");
  },
);

test("docTest wrote the fragment JSON after running", async () => {
  const path = fragmentPath({ section: "doc/disk_bridge/unit", order: 900 });
  const raw = await waitForFragment(path);
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
    doc.screen({
      lines: ["frame SECRET"],
      cursor: { x: 0, y: 0 },
      text: "frame SECRET",
      ansi: "frame SECRET",
    });
    doc.prose("prose SECRET");
  },
);

test("scrub literal: command/output/screen are scrubbed, prose is not", async () => {
  const path = fragmentPath({ section: "doc/scrub/literal", order: 901 });
  const parsed = JSON.parse(await waitForFragment(path));
  expect(parsed.entries).toEqual([
    { type: "command", content: "echo <redacted>" },
    { type: "output", content: "value=<redacted>" },
    { type: "screen", content: "frame <redacted>\n", ansiContent: "frame <redacted>\n" },
    { type: "prose", content: "prose SECRET" },
  ]);
});

docTest("scrub accepts regex patterns", { section: "doc/scrub/regex", order: 902 }, async (doc) => {
  doc.scrub(/[0-9]+/g, "N");
  doc.output("port=8080 retries=3");
});

test("scrub regex: replaces all matches", async () => {
  const path = fragmentPath({ section: "doc/scrub/regex", order: 902 });
  const parsed = JSON.parse(await waitForFragment(path));
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
  const parsed = JSON.parse(await waitForFragment(path));
  expect(parsed.entries).toEqual([
    {
      type: "output",
      content: "branch=feature cwd=/tmp/repo origin=/tmp/repo-origin",
    },
  ]);
});

docTest(
  "output stores ansiContent when ANSI codes present",
  { section: "doc/output_ansi/unit", order: 911 },
  async (doc) => {
    doc.output("\x1b[32mhello\x1b[0m world\n");
  },
);

test("output_ansi: content is stripped, ansiContent is raw", async () => {
  const path = fragmentPath({ section: "doc/output_ansi/unit", order: 911 });
  const parsed = JSON.parse(await waitForFragment(path));
  expect(parsed.entries[0].content).toBe("hello world\n");
  expect(parsed.entries[0].ansiContent).toBe("\x1b[32mhello\x1b[0m world\n");
});

docTest(
  "output without ANSI has no ansiContent",
  { section: "doc/output_ansi/unit", order: 912 },
  async (doc) => {
    doc.output("plain text\n");
  },
);

test("output_plain: no ansiContent field when no ANSI", async () => {
  const path = fragmentPath({ section: "doc/output_ansi/unit", order: 912 });
  const parsed = JSON.parse(await waitForFragment(path));
  expect(parsed.entries[0].content).toBe("plain text\n");
  expect(parsed.entries[0].ansiContent).toBeUndefined();
});

docTest(
  "screen stores trimmed content and ansiContent from snapshot",
  { section: "doc/screen_ansi/unit", order: 913 },
  async (doc) => {
    const fakeSnap: ScreenSnapshot = {
      lines: ["hello world", "second line", "", ""],
      cursor: { x: 0, y: 0 },
      text: "hello world\nsecond line",
      ansi: "\x1b[32mhello\x1b[0m world\nsecond line\n\n",
    };
    doc.screen(fakeSnap);
  },
);

test("screen_ansi: trailing blank rows trimmed, ansiContent stored", async () => {
  const path = fragmentPath({ section: "doc/screen_ansi/unit", order: 913 });
  const parsed = JSON.parse(await waitForFragment(path));
  expect(parsed.entries[0].content).toBe("hello world\nsecond line\n");
  expect(parsed.entries[0].ansiContent).toBe("\x1b[32mhello\x1b[0m world\nsecond line\n");
});
