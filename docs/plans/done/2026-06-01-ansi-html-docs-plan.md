# ANSI HTML Docs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate standalone HTML documentation with terminal color preserved from ANSI escape codes captured during doc tests.

**Architecture:** Extend `ansi-parser.ts` to track per-cell SGR state and emit a clean `ansi` field alongside the existing `text` field on `ScreenSnapshot`. Add optional `ansiContent` to `DocEntry`. Update `doc.ts` to auto-detect ANSI in `output()` and accept `ScreenSnapshot` in `screen()`. Add `assembleHtml()` to `build-docs.ts` using `ansi-to-html`.

**Tech Stack:** TypeScript/Bun, `ansi-to-html` (to install), `strip-ansi` (already in node_modules), `kleur` (already used by spry CLI)

---

### Task 1: Extend `ansi-parser.ts` — per-cell SGR color tracking

**Files:**

- Modify: `tests/lib/ansi-parser.ts`

**Step 1: Write a failing test in `tests/lib/ansi-parser.ts`'s smoke test**

Add to `tests/lib/smoke.test.ts` after the existing Pillar 3 assertion:

```ts
// Pillar 3 extension: ANSI color tracking
const colorScreen = createScreenBuffer(20, 3);
colorScreen.write("\x1b[32mhello\x1b[0m world");
const snap = colorScreen.capture();
expect(snap.ansi).toContain("\x1b[32mhello\x1b[0m");
expect(snap.ansi).toContain(" world");
expect(snap.text).toBe("hello world");  // plain text unchanged
```

**Step 2: Run test to verify it fails**

```bash
bun run test:docker -- tests/lib/smoke.test.ts
```

Expected: FAIL — `snap.ansi` is undefined.

**Step 3: Implement — add `Cell` interface and rewrite grid**

Replace `tests/lib/ansi-parser.ts` entirely:

```ts
export interface ScreenSnapshot {
  lines: string[];
  cursor: { x: number; y: number };
  text: string;
  ansi: string;  // reconstructed clean ANSI — no cursor movement codes, newline-separated
}

export interface ScreenBuffer {
  write(data: string): void;
  lineAt(row: number): string;
  capture(): ScreenSnapshot;
  cursor: { x: number; y: number };
}

interface Cell {
  char: string;
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
}

const BLANK: Cell = { char: " ", fg: null, bg: null, bold: false, dim: false };

export function createScreenBuffer(cols: number, rows: number): ScreenBuffer {
  const grid: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ...BLANK })),
  );
  const cursor = { x: 0, y: 0 };
  const style: Omit<Cell, "char"> = { fg: null, bg: null, bold: false, dim: false };

  function putChar(ch: string): void {
    if (cursor.y >= 0 && cursor.y < rows && cursor.x >= 0 && cursor.x < cols) {
      grid[cursor.y]![cursor.x] = { char: ch, ...style };
    }
    cursor.x++;
    if (cursor.x >= cols) {
      cursor.x = 0;
      cursor.y++;
    }
  }

  function clearLine(row: number): void {
    if (row >= 0 && row < rows) {
      for (let i = 0; i < cols; i++) grid[row]![i] = { ...BLANK };
    }
  }

  function clearAll(): void {
    for (let r = 0; r < rows; r++) clearLine(r);
  }

  function lineAt(row: number): string {
    if (row < 0 || row >= rows) return "";
    return grid[row]!.map((c) => c.char).join("").trimEnd();
  }

  function buildAnsiLine(row: number): string {
    const cells = grid[row]!;
    // Find last non-blank cell (char or color)
    let lastCol = cols - 1;
    while (
      lastCol > 0 &&
      cells[lastCol]!.char === " " &&
      cells[lastCol]!.fg === null &&
      cells[lastCol]!.bg === null &&
      !cells[lastCol]!.bold &&
      !cells[lastCol]!.dim
    ) {
      lastCol--;
    }
    if (cells[lastCol]!.char === " " && lastCol === 0) return "";

    let out = "";
    let prev: Omit<Cell, "char"> = { fg: null, bg: null, bold: false, dim: false };
    let needsReset = false;

    for (let x = 0; x <= lastCol; x++) {
      const cell = cells[x]!;
      const changed =
        cell.fg !== prev.fg ||
        cell.bg !== prev.bg ||
        cell.bold !== prev.bold ||
        cell.dim !== prev.dim;

      if (changed) {
        const sgr: number[] = [];
        // Need a reset if turning something off
        if (
          (prev.bold && !cell.bold) ||
          (prev.dim && !cell.dim) ||
          (prev.fg !== null && cell.fg === null) ||
          (prev.bg !== null && cell.bg === null)
        ) {
          sgr.push(0);
          prev = { fg: null, bg: null, bold: false, dim: false };
        }
        if (cell.bold && !prev.bold) sgr.push(1);
        if (cell.dim && !prev.dim) sgr.push(2);
        if (cell.fg !== null && cell.fg !== prev.fg) sgr.push(cell.fg);
        if (cell.bg !== null && cell.bg !== prev.bg) sgr.push(cell.bg);

        if (sgr.length > 0) {
          out += `\x1b[${sgr.join(";")}m`;
          needsReset = true;
        }
        prev = { fg: cell.fg, bg: cell.bg, bold: cell.bold, dim: cell.dim };
      }
      out += cell.char;
    }

    if (needsReset) out += "\x1b[0m";
    return out;
  }

  function write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;

      if (ch === "\x1b") {
        i++;
        if (i >= data.length) break;
        const next = data[i]!;

        if (next === "[") {
          i++;
          let params = "";
          while (i < data.length && data[i]! >= "\x20" && data[i]! <= "\x3f") {
            params += data[i]!;
            i++;
          }
          if (i >= data.length) break;
          const finalByte = data[i]!;
          i++;
          handleCSI(params, finalByte);
        } else if (next === "7" || next === "8") {
          i++; // Save/restore cursor — no-op
        } else {
          i++;
        }
        continue;
      }

      if (ch === "\n") {
        cursor.y++;
        cursor.x = 0;
        i++;
        continue;
      }
      if (ch === "\r") {
        cursor.x = 0;
        i++;
        continue;
      }

      putChar(ch);
      i++;
    }
  }

  function handleCSI(params: string, finalByte: string): void {
    const n = params === "" ? 1 : parseInt(params, 10) || 1;

    switch (finalByte) {
      case "A":
        cursor.y = Math.max(0, cursor.y - n);
        break;
      case "B":
        cursor.y = Math.min(rows - 1, cursor.y + n);
        break;
      case "C":
        cursor.x = Math.min(cols - 1, cursor.x + n);
        break;
      case "D":
        cursor.x = Math.max(0, cursor.x - n);
        break;
      case "H":
      case "f": {
        const parts = params.split(";");
        cursor.y = Math.max(0, Math.min(rows - 1, parseInt(parts[0] || "1", 10) - 1));
        cursor.x = Math.max(0, Math.min(cols - 1, parseInt(parts[1] || "1", 10) - 1));
        break;
      }
      case "J":
        if (params === "2" || params === "3") {
          clearAll();
        } else if (params === "" || params === "0") {
          for (let x = cursor.x; x < cols; x++) grid[cursor.y]![x] = { ...BLANK };
          for (let r = cursor.y + 1; r < rows; r++) clearLine(r);
        }
        break;
      case "K":
        if (params === "2") {
          clearLine(cursor.y);
        } else if (params === "" || params === "0") {
          for (let x = cursor.x; x < cols; x++) grid[cursor.y]![x] = { ...BLANK };
        } else if (params === "1") {
          for (let x = 0; x <= cursor.x; x++) grid[cursor.y]![x] = { ...BLANK };
        }
        break;
      case "m": {
        const codes = params === "" ? [0] : params.split(";").map(Number);
        for (const code of codes) {
          if (code === 0) {
            style.fg = null; style.bg = null; style.bold = false; style.dim = false;
          } else if (code === 1) style.bold = true;
          else if (code === 2) style.dim = true;
          else if (code === 22) { style.bold = false; style.dim = false; }
          else if (code >= 30 && code <= 37) style.fg = code;
          else if (code === 39) style.fg = null;
          else if (code >= 40 && code <= 47) style.bg = code;
          else if (code === 49) style.bg = null;
          else if (code >= 90 && code <= 97) style.fg = code;
          else if (code >= 100 && code <= 107) style.bg = code;
        }
        break;
      }
      case "h":
      case "l":
        break; // Set/reset mode — ignore
    }
  }

  function capture(): ScreenSnapshot {
    const lines = Array.from({ length: rows }, (_, r) => lineAt(r));
    const ansiLines = Array.from({ length: rows }, (_, r) => buildAnsiLine(r));
    return {
      lines: [...lines],
      cursor: { ...cursor },
      text: lines.join("\n"),
      ansi: ansiLines.join("\n"),
    };
  }

  return { write, lineAt, capture, cursor };
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test:docker -- tests/lib/smoke.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/lib/ansi-parser.ts tests/lib/smoke.test.ts
git commit -m "feat(ansi-parser): track per-cell SGR color state, emit ansi field in snapshot"
```

---

### Task 2: Update `DocEntry` and `DocContext` types

**Files:**

- Modify: `tests/lib/doc-types.ts`

**Step 1: Write a failing test**

In `tests/lib/doc.test.ts`, add after the existing tests:

```ts
import type { ScreenSnapshot } from "./ansi-parser.ts";

test("doc.screen() accepts ScreenSnapshot and stores ansiContent", async () => {
  const path = fragmentPath({ section: "doc/screen_ansi/unit", order: 910 });
  await rm(path, { force: true });

  const fakeSnapshot: ScreenSnapshot = {
    lines: ["hello world", "second line", ""],
    cursor: { x: 0, y: 0 },
    text: "hello world\nsecond line\n",
    ansi: "\x1b[32mhello\x1b[0m world\nsecond line\n",
  };

  // Must run via docTest to write the fragment
  await new Promise<void>((resolve) => {
    docTest("screen ansi test", { section: "doc/screen_ansi/unit", order: 910 }, async (doc) => {
      doc.screen(fakeSnapshot);
      resolve();
    });
    // docTest registers a bun test — skip actual execution here, just verify types compile
  });
});
```

Actually the docTest helper registers a bun test internally. Instead, test the type signature compiles by importing:

```ts
import type { DocContext } from "./doc-types.ts";
import type { ScreenSnapshot } from "./ansi-parser.ts";

// Type-level check: screen() must accept ScreenSnapshot
const _check: DocContext["screen"] = (_snap: ScreenSnapshot) => {};
```

Add this as a compile-time check at the top of `doc.test.ts`.

**Step 2: Run type check to verify it fails**

```bash
bun run types
```

Expected: FAIL — `screen` still expects `string`.

**Step 3: Update `doc-types.ts`**

```ts
import type { ScreenSnapshot } from "./ansi-parser.ts";

export interface DocEntry {
  type: "prose" | "command" | "output" | "screen";
  content: string;
  ansiContent?: string;
}

export interface DocFragment {
  title: string;
  section: string;
  order: number;
  entries: DocEntry[];
}

export interface DocContext {
  prose(text: string): void;
  command(input: string): void;
  output(text: string): void;
  screen(snapshot: ScreenSnapshot): void;
  scrub(repo: { uniqueId: string; path: string; originPath: string }): void;
  scrub(pattern: string | RegExp, replacement: string): void;
}
```

**Step 4: Run type check**

```bash
bun run types
```

Expected: errors now shift to `doc.ts` (implementation) and call sites — that's correct, proceed.

**Step 5: Commit (partial — types only)**

Skip commit here; fold into Task 3's commit once the implementation is also updated.

---

### Task 3: Update `doc.ts` — implement new `screen()` and `output()`

**Files:**

- Modify: `tests/lib/doc.ts`

The `screen()` implementation trims trailing blank rows from the snapshot and stores both plain and ANSI content. The `output()` implementation auto-detects ANSI via `strip-ansi`.

**Step 1: Write failing test for `output()` ANSI auto-detection**

In `tests/lib/doc.test.ts`, add:

```ts
test("doc.output() stores ansiContent when input contains ANSI codes", async () => {
  const path = fragmentPath({ section: "doc/output_ansi/unit", order: 911 });
  await rm(path, { force: true });

  docTest(
    "output ansi detect",
    { section: "doc/output_ansi/unit", order: 911 },
    async (doc) => {
      doc.output("\x1b[32mhello\x1b[0m world\n");
    },
  );

  // Note: docTest registers a bun test but runs asynchronously.
  // Check via the written fragment in a follow-up test.
});

test("output_ansi fragment has ansiContent and stripped content", async () => {
  const path = fragmentPath({ section: "doc/output_ansi/unit", order: 911 });
  const parsed = JSON.parse(await readFile(path, "utf8"));
  expect(parsed.entries[0].content).toBe("hello world\n");
  expect(parsed.entries[0].ansiContent).toBe("\x1b[32mhello\x1b[0m world\n");
});
```

Add cleanup for `doc__output_ansi__unit--911.json` to `cleanupPaths` and `beforeAll`/`afterAll`.

**Step 2: Run test to verify it fails**

```bash
bun run test:docker -- tests/lib/doc.test.ts
```

Expected: FAIL — `ansiContent` is undefined, `content` is still the raw ANSI string.

**Step 3: Implement**

Replace `tests/lib/doc.ts`:

```ts
import { test as bunTest } from "bun:test";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import type { DocContext, DocEntry, DocFragment } from "./doc-types.ts";
import type { ScreenSnapshot } from "./ansi-parser.ts";

export type { DocContext, DocEntry, DocFragment } from "./doc-types.ts";

const FRAGMENTS_DIR = join(import.meta.dir, "../../.test-tmp/doc-fragments");

export function fragmentPath(fragment: Pick<DocFragment, "section" | "order">): string {
  const section = fragment.section.replaceAll("/", "__");
  const order = String(fragment.order).padStart(3, "0");
  return join(FRAGMENTS_DIR, `${section}--${order}.json`);
}

interface Substitution {
  pattern: string | RegExp;
  replacement: string;
}

function isRepoLike(
  value: unknown,
): value is { uniqueId: string; path: string; originPath: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { uniqueId?: unknown }).uniqueId === "string" &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { originPath?: unknown }).originPath === "string"
  );
}

function hasAnsi(text: string): boolean {
  return stripAnsi(text) !== text;
}

export function docTest(
  title: string,
  options: { section: string; order: number },
  fn: (doc: DocContext) => Promise<void>,
): void {
  bunTest(title, async () => {
    const entries: DocEntry[] = [];
    const subs: Substitution[] = [];

    function applyScrub(text: string): string {
      let out = text;
      for (const { pattern, replacement } of subs) {
        if (typeof pattern === "string") {
          out = out.replaceAll(pattern, replacement);
        } else {
          out = out.replace(pattern, replacement);
        }
      }
      return out;
    }

    const doc: DocContext = {
      prose(text) {
        entries.push({ type: "prose", content: text });
      },
      command(input) {
        entries.push({ type: "command", content: applyScrub(input) });
      },
      output(text) {
        if (hasAnsi(text)) {
          entries.push({
            type: "output",
            content: applyScrub(stripAnsi(text)),
            ansiContent: applyScrub(text),
          });
        } else {
          entries.push({ type: "output", content: applyScrub(text) });
        }
      },
      screen(snapshot: ScreenSnapshot) {
        const lastRow = snapshot.lines.findLastIndex((l) => l.trim() !== "");
        const trimmedLines = snapshot.lines.slice(0, lastRow + 1);
        const ansiLines = snapshot.ansi.split("\n").slice(0, lastRow + 1);
        entries.push({
          type: "screen",
          content: applyScrub(trimmedLines.join("\n") + "\n"),
          ansiContent: applyScrub(ansiLines.join("\n") + "\n"),
        });
      },
      scrub(arg: unknown, replacement?: string) {
        if (isRepoLike(arg)) {
          subs.push({ pattern: arg.path, replacement: "/tmp/repo" });
          subs.push({ pattern: arg.originPath, replacement: "/tmp/repo-origin" });
          subs.push({ pattern: `-${arg.uniqueId}`, replacement: "" });
          subs.push({ pattern: arg.uniqueId, replacement: "" });
        } else if (typeof arg === "string" || arg instanceof RegExp) {
          subs.push({ pattern: arg, replacement: replacement ?? "" });
        } else {
          throw new TypeError("doc.scrub: expected a repo, a string, or a RegExp");
        }
      },
    };

    await fn(doc);

    const fragment: DocFragment = {
      title,
      section: options.section,
      order: options.order,
      entries,
    };
    await Bun.write(fragmentPath(fragment), JSON.stringify(fragment, null, 2));
  });
}
```

**Step 4: Run tests**

```bash
bun run test:docker -- tests/lib/doc.test.ts
```

Expected: existing tests PASS (content field unchanged for plain text), new test PASS.

**Step 5: Commit**

```bash
git add tests/lib/doc-types.ts tests/lib/doc.ts tests/lib/doc.test.ts tests/lib/smoke.test.ts
git commit -m "feat(doc): add ansiContent to DocEntry; screen() accepts ScreenSnapshot, output() auto-detects ANSI"
```

---

### Task 4: Force color in subprocess and in-process invocations

**Files:**

- Modify: `tests/lib/run.ts`

**Step 1: Write a failing test**

In `tests/lib/run.ts`, there's no test file. Add a minimal check in a new `tests/lib/run.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createRunner } from "./run.ts";
import { join } from "node:path";

// This test verifies FORCE_COLOR is passed by running a tiny script that echoes kleur output
test("createRunner passes FORCE_COLOR=1 to subprocess", async () => {
  // Create a tiny script that uses kleur and outputs colored text
  const scriptPath = join(import.meta.dir, "../../.test-tmp/color-check.ts");
  await Bun.write(scriptPath, `
    import kleur from "kleur";
    console.log(kleur.green("ok"));
  `);

  const run = createRunner(scriptPath);
  // We can't use createRunner directly (it prefixes "sp <command>"),
  // so just verify FORCE_COLOR is set in the env by checking run.ts source
  expect(true).toBe(true); // compile-time check only
});
```

Actually, testing env vars in subprocess is complex. Instead, verify by inspection — just update `run.ts` and check that the existing doc tests produce ANSI output when run.

Skip writing a separate test for this. Instead, verify with the integration test (Task 6).

**Step 2: Update `tests/lib/run.ts`**

Add `FORCE_COLOR: "1"` to the subprocess environment:

```ts
import { $ } from "bun";
import type { CommandResult } from "./context.ts";

export interface RunResult {
  command: string;
  result: CommandResult;
}

export type SpryRunner = (
  cwd: string,
  command: string,
  args?: string[],
) => Promise<RunResult>;

export function createRunner(cliPath: string): SpryRunner {
  return async (cwd, command, args = []) => {
    let proc = $`SPRY_NO_TTY=1 FORCE_COLOR=1 bun run ${cliPath} ${command} ${args}`
      .nothrow()
      .quiet();
    proc = proc.cwd(cwd);
    const result = await proc;

    const commandStr = args.length > 0
      ? `sp ${command} ${args.join(" ")}`
      : `sp ${command}`;

    return {
      command: commandStr,
      result: {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      },
    };
  };
}
```

**Step 3: Commit**

```bash
git add tests/lib/run.ts
git commit -m "feat(run): add FORCE_COLOR=1 to subprocess env for colored doc output"
```

---

### Task 5: Update call sites in doc tests

**Files:**

- Modify: `tests/commands/sync.doc.test.ts`
- Modify: `tests/commands/view.doc.test.ts` (if it has `screen()` calls)

The only `doc.screen()` call is in `sync.doc.test.ts` at line 291. Change it from string to snapshot.

**Step 1: Find all `doc.screen()` calls**

```bash
grep -rn "doc\.screen" tests/commands/
```

Expected: only `tests/commands/sync.doc.test.ts:291`.

**Step 2: Update the call site**

Current code (lines ~287-291):

```ts
const menuLines = driver.capture().lines;
const lastMenuRow = menuLines.findLastIndex((l) => l.trim() !== "");
doc.screen(menuLines.slice(0, lastMenuRow + 1).join("\n") + "\n");
```

Replace with:

```ts
doc.screen(driver.capture());
```

The trimming of trailing blank rows is now handled inside `doc.ts`'s `screen()` implementation.

**Step 3: Run type check**

```bash
bun run types
```

Expected: PASS — no more type errors.

**Step 4: Run sync doc tests to verify**

```bash
bun run test:docker -- tests/commands/sync.doc.test.ts
```

Expected: PASS — same behavior as before, but now also writes `ansiContent` to fragments.

**Step 5: Verify fragment has ansiContent**

After the doc tests run, check a fragment:

```bash
cat .test-tmp/doc-fragments/commands__sync--025.json | grep -c ansiContent
```

Expected: output `> 0` (at least one entry has `ansiContent`).

**Step 6: Commit**

```bash
git add tests/commands/sync.doc.test.ts
git commit -m "feat(sync.doc): pass ScreenSnapshot directly to doc.screen()"
```

---

### Task 6: Install `ansi-to-html` and add `assembleHtml()` to `build-docs.ts`

**Files:**

- Modify: `scripts/build-docs.ts`
- Modify: `scripts/build-docs.test.ts`
- Modify: `package.json`

**Step 1: Install `ansi-to-html`**

```bash
bun add ansi-to-html
```

**Step 2: Write failing test for `assembleHtml()`**

In `scripts/build-docs.test.ts`, add:

```ts
import { assembleHtml } from "./build-docs.ts";

test("assembleHtml renders prose as <p> and plain output as <pre>", () => {
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
      section: "commands/sync",
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
  const html = result.get("commands/sync");
  expect(html).toContain("<span");   // ansi-to-html emits spans
  expect(html).not.toContain("\x1b"); // no raw escape codes in HTML
});

test("assembleHtml produces valid standalone HTML", () => {
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
});
```

**Step 3: Run tests to verify they fail**

```bash
bun run test:docker -- scripts/build-docs.test.ts
```

Expected: FAIL — `assembleHtml` is not exported.

**Step 4: Implement `assembleHtml()` in `build-docs.ts`**

Add to `scripts/build-docs.ts`:

```ts
import AnsiToHtml from "ansi-to-html";
import type { DocFragment, DocEntry } from "../tests/lib/doc-types.ts";

const converter = new AnsiToHtml({ escapeXML: true, newline: false });

const HTML_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; max-width: 860px; color: #e8e8e8; background: #1a1a1a; }
  h1 { font-size: 1.4rem; margin-bottom: 1.5rem; color: #fff; }
  p { margin-bottom: 1rem; }
  pre { font-family: ui-monospace, 'Cascadia Code', monospace; font-size: 0.85rem; padding: 1rem; border-radius: 6px; overflow-x: auto; margin-bottom: 1rem; white-space: pre; }
  pre.command { background: #0d1117; color: #c9d1d9; border-left: 3px solid #58a6ff; }
  pre.command::before { content: "$ "; color: #58a6ff; }
  pre.output { background: #0d1117; color: #c9d1d9; }
  pre.screen { background: #0d1117; color: #c9d1d9; }
  /* ansi-to-html color classes — standard 16 colors */
  .ansi-black { color: #000; } .ansi-red { color: #c0392b; } .ansi-green { color: #27ae60; }
  .ansi-yellow { color: #f39c12; } .ansi-blue { color: #2980b9; } .ansi-magenta { color: #8e44ad; }
  .ansi-cyan { color: #16a085; } .ansi-white { color: #bdc3c7; }
  .ansi-bright-black { color: #7f8c8d; } .ansi-bright-red { color: #e74c3c; } .ansi-bright-green { color: #2ecc71; }
  .ansi-bright-yellow { color: #f1c40f; } .ansi-bright-blue { color: #3498db; } .ansi-bright-magenta { color: #9b59b6; }
  .ansi-bright-cyan { color: #1abc9c; } .ansi-bright-white { color: #ecf0f1; }
  .ansi-bold { font-weight: bold; }
`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderEntryHtml(entry: DocEntry): string {
  switch (entry.type) {
    case "prose":
      return `<p>${escapeHtml(entry.content)}</p>`;
    case "command":
      return `<pre class="command">${escapeHtml(entry.content.trim())}</pre>`;
    case "output":
    case "screen": {
      const cls = entry.type;
      const inner = entry.ansiContent
        ? converter.toHtml(entry.ansiContent.trimEnd())
        : escapeHtml(entry.content.trimEnd());
      return `<pre class="${cls}">${inner}</pre>`;
    }
  }
}

export function assembleHtml(fragments: DocFragment[]): Map<string, string> {
  const sections = new Map<string, DocFragment[]>();
  for (const fragment of fragments) {
    const existing = sections.get(fragment.section) ?? [];
    existing.push(fragment);
    sections.set(fragment.section, existing);
  }

  const result = new Map<string, string>();
  for (const [section, frags] of sections) {
    frags.sort((a, b) => a.order - b.order);
    const sectionName = section.split("/").pop() ?? section;

    const bodyParts: string[] = [];
    for (const frag of frags) {
      for (const entry of frag.entries) {
        bodyParts.push(renderEntryHtml(entry));
      }
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>sp ${escapeHtml(sectionName)}</title>
  <style>${HTML_CSS}</style>
</head>
<body>
  <h1>sp ${escapeHtml(sectionName)}</h1>
  ${bodyParts.join("\n  ")}
</body>
</html>`;

    result.set(section, html);
  }

  return result;
}
```

Also add `buildDocsFromDisk` HTML output — update the existing function to also write `.html` files:

```ts
export async function buildDocsFromDisk(fragmentsDir: string, outDir: string): Promise<number> {
  // ... existing fragment loading code ...

  const markdownDocs = assembleMarkdown(fragments);
  const htmlDocs = assembleHtml(fragments);

  for (const [section, content] of markdownDocs) {
    const filePath = join(outDir, `${section}.md`);
    await mkdir(join(filePath, ".."), { recursive: true });
    await Bun.write(filePath, content);
  }

  for (const [section, content] of htmlDocs) {
    const filePath = join(outDir, `${section}.html`);
    await mkdir(join(filePath, ".."), { recursive: true });
    await Bun.write(filePath, content);
  }

  return markdownDocs.size;
}
```

**Step 5: Run tests**

```bash
bun run test:docker -- scripts/build-docs.test.ts
```

Expected: PASS

**Step 6: Also add disk-write test for HTML**

In `build-docs.test.ts`, add to the existing `buildDocsFromDisk` test:

```ts
  const html = await readFile(join(outDir, "commands/demo.html"), "utf8");
  expect(html).toContain("<!DOCTYPE html>");
  expect(html).toContain("Hello, docs.");
```

Re-run to confirm PASS.

**Step 7: Commit**

```bash
git add scripts/build-docs.ts scripts/build-docs.test.ts bun.lock package.json
git commit -m "feat(build-docs): add assembleHtml() with ansi-to-html, generate .html alongside .md"
```

---

### Task 7: Add `docs:build:html` script and verify end-to-end

**Files:**

- Modify: `package.json`

**Step 1: Add script**

In `package.json` scripts, add alongside `docs:build`:

```json
"docs:build:html": "bun run scripts/build-docs.ts --html",
```

Wait — `build-docs.ts` currently always writes both `.md` and `.html` from `buildDocsFromDisk`. The script entry point doesn't need a flag — HTML is always co-generated. The existing `docs:build` script already does it.

Instead, just verify the end-to-end works:

**Step 1: Run the full doc test suite + build**

```bash
bun run test:docker -- tests/commands/sync.doc.test.ts && bun run docs:build
```

Expected: `docs/generated/commands/sync.md` and `docs/generated/commands/sync.html` both written.

**Step 2: Spot-check the HTML**

```bash
grep -c "<span" docs/generated/commands/sync.html
```

Expected: a number > 0, indicating color spans were emitted.

**Step 3: Open the HTML in a browser (manual)**

```bash
open docs/generated/commands/sync.html
```

Verify the TUI menu frame and sync output lines have terminal colors.

**Step 4: Run the full test suite to check for regressions**

```bash
bun run test:docker
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add docs/generated/
git commit -m "docs: regenerate with ANSI HTML output"
```

---

## Summary of Files Changed

| File                              | Change                                                               |
| --------------------------------- | -------------------------------------------------------------------- |
| `tests/lib/ansi-parser.ts`        | Grid becomes `Cell[][]`, SGR tracking, `ansi` field on snapshot      |
| `tests/lib/smoke.test.ts`         | Add ANSI capture assertion to Pillar 3                               |
| `tests/lib/doc-types.ts`          | `DocEntry.ansiContent?: string`, `DocContext.screen(ScreenSnapshot)` |
| `tests/lib/doc.ts`                | New `screen()` and `output()` implementations                        |
| `tests/lib/doc.test.ts`           | Tests for new `output()` ANSI detection                              |
| `tests/lib/run.ts`                | Add `FORCE_COLOR=1` to subprocess env                                |
| `tests/commands/sync.doc.test.ts` | `doc.screen(driver.capture())` — snapshot instead of string          |
| `scripts/build-docs.ts`           | Add `assembleHtml()`, write `.html` in `buildDocsFromDisk`           |
| `scripts/build-docs.test.ts`      | Tests for `assembleHtml()`                                           |
| `package.json` / `bun.lock`       | Add `ansi-to-html` dependency                                        |
