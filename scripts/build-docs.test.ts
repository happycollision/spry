import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, readFile } from "node:fs/promises";
import { assembleMarkdown, assembleHtml, buildDocsFromDisk } from "./build-docs.ts";
import type { DocFragment } from "../tests/lib/doc-types.ts";
import { SHA_POOL, SPRY_ID_POOL, buildShaMap, buildSpryMap } from "../tests/lib/sha-scanner.ts";

test("assembles fragments into markdown grouped by section", () => {
  const fragments: DocFragment[] = [
    {
      title: "Basic sync",
      section: "commands/sync",
      order: 10,
      entries: [
        { type: "prose", content: "Sync your stack:" },
        { type: "command", content: "sp sync" },
        { type: "output", content: "✓ Synced 3 commits" },
      ],
    },
    {
      title: "Sync with open",
      section: "commands/sync",
      order: 20,
      entries: [
        { type: "prose", content: "Open PRs during sync:" },
        { type: "command", content: "sp sync --open" },
      ],
    },
  ];

  const result = assembleMarkdown(fragments);
  const syncDoc = result.get("commands/sync");

  expect(syncDoc).toBeDefined();
  expect(syncDoc).toContain("# sync");
  expect(syncDoc).toContain("Sync your stack:");
  expect(syncDoc).toContain("```\nsp sync\n```");
  expect(syncDoc).toContain("```\n✓ Synced 3 commits\n```");
  expect(syncDoc).toContain("Open PRs during sync:");
  // Order matters: "Basic sync" before "Sync with open"
  expect(syncDoc!.indexOf("Sync your stack:")).toBeLessThan(
    syncDoc!.indexOf("Open PRs during sync:"),
  );
});

test("screen entries render as code blocks", () => {
  const fragments: DocFragment[] = [
    {
      title: "Group editor",
      section: "commands/group",
      order: 10,
      entries: [
        { type: "prose", content: "The group editor:" },
        { type: "screen", content: "Group Editor - 3 commits\n→ [A] abc123 First commit" },
      ],
    },
  ];

  const result = assembleMarkdown(fragments);
  const groupDoc = result.get("commands/group");

  expect(groupDoc).toContain("```\nGroup Editor - 3 commits");
});

const tmpRoot = join(import.meta.dir, "../.test-tmp/build-docs-test");

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

test("buildDocsFromDisk reads fragments and writes markdown", async () => {
  const fragmentsDir = join(tmpRoot, "fragments");
  const outDir = join(tmpRoot, "out");
  await mkdir(fragmentsDir, { recursive: true });

  await Bun.write(
    join(fragmentsDir, "commands__demo--010.json"),
    JSON.stringify({
      title: "Basic demo",
      section: "commands/demo",
      order: 10,
      entries: [{ type: "prose", content: "Hello, docs." }],
    }),
  );
  await Bun.write(
    join(fragmentsDir, "commands__demo--020.json"),
    JSON.stringify({
      title: "Demo with command",
      section: "commands/demo",
      order: 20,
      entries: [{ type: "command", content: "sp demo" }],
    }),
  );

  const count = await buildDocsFromDisk(fragmentsDir, outDir);
  expect(count).toBe(1);

  const markdown = await readFile(join(outDir, "commands/demo.md"), "utf8");
  expect(markdown).toContain("# demo");
  expect(markdown).toContain("Hello, docs.");
  expect(markdown).toContain("```\nsp demo\n```");
  expect(markdown.indexOf("Hello, docs.")).toBeLessThan(markdown.indexOf("sp demo"));

  const html = await readFile(join(outDir, "commands/demo.html"), "utf8");
  expect(html).toContain("<!DOCTYPE html>");
  expect(html).toContain("Hello, docs.");
});

test("buildDocsFromDisk returns 0 when fragments dir is missing", async () => {
  const count = await buildDocsFromDisk(join(tmpRoot, "nonexistent"), join(tmpRoot, "out"));
  expect(count).toBe(0);
});

test("assembleHtml renders prose as <p> and plain output as <pre class=output>", () => {
  const fragments: DocFragment[] = [
    {
      title: "Basic sync",
      section: "commands/sync",
      order: 10,
      entries: [
        { type: "prose", content: "Run sync:" },
        { type: "command", content: "sp sync" },
        { type: "output", content: "✓ Synced" },
      ],
    },
  ];

  const result = assembleHtml(fragments);
  const html = result.get("commands/sync");
  expect(html).toBeDefined();
  expect(html).toContain("<p>Run sync:</p>");
  expect(html).toContain('class="command"');
  expect(html).toContain("sp sync");
  expect(html).toContain('class="output"');
  expect(html).toContain("✓ Synced");
});

test("assembleHtml renders ansiContent as colored spans for output", () => {
  const fragments: DocFragment[] = [
    {
      title: "Colored output",
      section: "commands/color",
      order: 10,
      entries: [
        {
          type: "output",
          content: "hello world",
          ansiContent: "\x1b[32mhello\x1b[0m world",
        },
      ],
    },
  ];

  const result = assembleHtml(fragments);
  const html = result.get("commands/color");
  expect(html).toBeDefined();
  expect(html).toContain("<span");
  expect(html).not.toContain("\x1b");
  expect(html).toContain("hello");
  expect(html).toContain("world");
});

test("assembleHtml produces valid standalone HTML structure", () => {
  const fragments: DocFragment[] = [
    {
      title: "Demo",
      section: "commands/demo",
      order: 10,
      entries: [{ type: "prose", content: "Demo command." }],
    },
  ];

  const result = assembleHtml(fragments);
  const html = result.get("commands/demo")!;
  expect(html).toContain("<!DOCTYPE html>");
  expect(html).toContain("<style>");
  expect(html).toContain("</html>");
  expect(html).toContain("Demo command.");
});

const REAL_SHA = "abc1234def5678901234567890abcdef12345678";
const REAL_SPRY = "deadbeef";

test("buildDocsFromDisk scrubs SHAs in fragment content", async () => {
  const fragmentsDir = join(tmpRoot, "fragments-sha");
  const outDir = join(tmpRoot, "out-sha");
  await mkdir(fragmentsDir, { recursive: true });

  await Bun.write(
    join(fragmentsDir, "commands__demo--010.json"),
    JSON.stringify({
      title: "SHA test",
      section: "commands/demo",
      order: 10,
      shas: [REAL_SHA],
      spryIds: [REAL_SPRY],
      entries: [
        {
          type: "output",
          content: `commit ${REAL_SHA.slice(0, 7)} (Spry-Commit-Id: ${REAL_SPRY})`,
        },
      ],
    }),
  );

  const shaMap = buildShaMap([REAL_SHA]);
  const spryMap = buildSpryMap([REAL_SPRY]);
  const fakeShaAbbrev = shaMap.get(REAL_SHA)!.slice(0, 7);
  const fakeSpry = spryMap.get(REAL_SPRY)!;

  await buildDocsFromDisk(fragmentsDir, outDir);
  const markdown = await readFile(join(outDir, "commands/demo.md"), "utf8");
  expect(markdown).not.toContain(REAL_SHA.slice(0, 7));
  expect(markdown).not.toContain(REAL_SPRY);
  expect(markdown).toContain(fakeShaAbbrev);
  expect(markdown).toContain(fakeSpry);
});

test("same SHA in two fragments gets the same fake value (global map)", async () => {
  const fragmentsDir = join(tmpRoot, "fragments-global");
  const outDir = join(tmpRoot, "out-global");
  await mkdir(fragmentsDir, { recursive: true });

  await Bun.write(
    join(fragmentsDir, "commands__demo--010.json"),
    JSON.stringify({
      title: "Fragment 1",
      section: "commands/demo",
      order: 10,
      shas: [REAL_SHA],
      entries: [{ type: "output", content: REAL_SHA.slice(0, 7) }],
    }),
  );
  await Bun.write(
    join(fragmentsDir, "commands__demo--020.json"),
    JSON.stringify({
      title: "Fragment 2",
      section: "commands/demo",
      order: 20,
      shas: [REAL_SHA],
      entries: [{ type: "output", content: REAL_SHA.slice(0, 7) }],
    }),
  );

  const shaMap = buildShaMap([REAL_SHA]);
  const fakeAbbrev = shaMap.get(REAL_SHA)!.slice(0, 7);

  await buildDocsFromDisk(fragmentsDir, outDir);
  const markdown = await readFile(join(outDir, "commands/demo.md"), "utf8");
  expect(markdown.split(fakeAbbrev).length - 1).toBe(2);
});

test("fragment without shas field passes through unchanged", async () => {
  const fragmentsDir = join(tmpRoot, "fragments-noshas");
  const outDir = join(tmpRoot, "out-noshas");
  await mkdir(fragmentsDir, { recursive: true });

  await Bun.write(
    join(fragmentsDir, "commands__demo--010.json"),
    JSON.stringify({
      title: "No shas",
      section: "commands/demo",
      order: 10,
      entries: [{ type: "prose", content: "Just plain text." }],
    }),
  );

  await buildDocsFromDisk(fragmentsDir, outDir);
  const markdown = await readFile(join(outDir, "commands/demo.md"), "utf8");
  expect(markdown).toContain("Just plain text.");
});

test("ansiContent is also scrubbed", async () => {
  const fragmentsDir = join(tmpRoot, "fragments-ansi");
  const outDir = join(tmpRoot, "out-ansi");
  await mkdir(fragmentsDir, { recursive: true });

  const abbrev = REAL_SHA.slice(0, 7);
  await Bun.write(
    join(fragmentsDir, "commands__demo--010.json"),
    JSON.stringify({
      title: "ANSI test",
      section: "commands/demo",
      order: 10,
      shas: [REAL_SHA],
      entries: [
        {
          type: "output",
          content: `commit ${abbrev}`,
          ansiContent: `\x1b[33mcommit ${abbrev}\x1b[0m`,
        },
      ],
    }),
  );

  const shaMap = buildShaMap([REAL_SHA]);
  const fakeShaAbbrev = shaMap.get(REAL_SHA)!.slice(0, 7);

  await buildDocsFromDisk(fragmentsDir, outDir);
  const html = await readFile(join(outDir, "commands/demo.html"), "utf8");
  expect(html).not.toContain(abbrev);
  expect(html).toContain(fakeShaAbbrev);
});
