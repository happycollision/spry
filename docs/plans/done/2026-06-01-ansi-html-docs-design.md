# ANSI HTML Docs Design

**Date:** 2026-06-01  
**Goal:** Generate standalone HTML documentation with perfectly represented ANSI color shell sessions.

## Problem

The current doc pipeline captures plain text — `ansi-parser.ts` strips ANSI escape codes before `DocEntry` stores them, and `build-docs.ts` emits plain markdown with ``` code blocks. The resulting docs lose all terminal color information.

## Approach

Two-phase pipeline: tests capture both plain and ANSI-annotated content; build renders either markdown (existing) or styled standalone HTML (new).

## Section 1: Data Model

Add optional `ansiContent` to `DocEntry` in `doc-types.ts`:

```ts
export interface DocEntry {
  type: "prose" | "command" | "output" | "screen";
  content: string;        // plain text (always present)
  ansiContent?: string;   // ANSI-escaped string (present when color available)
}
```

Plain `content` is unchanged — markdown output continues to work. `ansiContent` is a human-readable ANSI string in JSON fragments, not pre-rendered HTML.

## Section 2: `ansi-parser.ts` Extension

Change the per-cell grid from `string[][]` to `Cell[][]`:

```ts
interface Cell {
  char: string;
  fg: number | null;   // ANSI color (30-37, 90-97, or 256/RGB)
  bg: number | null;
  bold: boolean;
  dim: boolean;
  // extended only as needed for what spry actually emits
}
```

`write()` already parses CSI sequences — add an SGR handler updating a "current style" cursor. Each `putChar()` stamps the current style onto the cell.

`capture()` reconstructs a clean `ansi` string: walk the grid row by row, emit SGR codes only on style change, write the char, reset at end of each line. No cursor movement codes.

```ts
export interface ScreenSnapshot {
  lines: string[];
  cursor: { x: number; y: number };
  text: string;
  ansi: string;   // reconstructed clean ANSI, newline-separated
}
```

## Section 3: `DocContext` API

**`screen`**: Accept `ScreenSnapshot` instead of a plain string. Extracts `text` → `content` and `ansi` → `ansiContent`:

```ts
// Before
screen(text: string): void;
// After
screen(snapshot: ScreenSnapshot): void;
```

Call sites change from `doc.screen(snapshot.text)` to `doc.screen(snapshot)` — mechanical update.

**`output`**: Auto-detect ANSI codes in the string. Strip them for `content`, keep original for `ansiContent`. No API change at call sites.

To ensure `result.stdout` carries ANSI, add `FORCE_COLOR: "1"` to the subprocess env in the test harness. Chalk and Node's `util.inspect` both honor this flag even when stdout is a pipe.

## Section 4: `build-docs.ts` HTML Generation

Add `assembleHtml()` alongside `assembleMarkdown()`. Uses `ansi-to-html` npm package.

| Entry type | Has `ansiContent`?   | Rendered as                             |
| ---------- | -------------------- | --------------------------------------- |
| `prose`    | never                | `<p>`                                   |
| `command`  | never                | `<pre class="command">` plain text      |
| `output`   | when CLI emits color | `<pre class="output">` with color spans |
| `screen`   | always               | `<pre class="screen">` with color spans |

Falls back to plain `content` when `ansiContent` is absent — pipeline degrades gracefully.

New script: `docs:build:html` writes `.html` files alongside `.md` files in `docs/generated/`.

## Section 5: Standalone HTML Structure

Single self-contained `.html` per doc section — no external assets, no JS.

```
docs/generated/
  commands/
    sync.md       (existing)
    sync.html     (new)
```

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>sp {command}</title>
  <style>
    /* reset + base typography */
    /* .terminal: dark bg, monospace, padding */
    /* .command: distinct bg to distinguish input from output */
    /* ANSI color classes (from ansi-to-html in class mode) */
  </style>
</head>
<body>
  <h1>sp {command}</h1>
  <!-- prose as <p>, command/output/screen as <pre class="terminal"> -->
</body>
</html>
```

All CSS inlined in `<style>`. `ansi-to-html` configured to emit CSS classes (not inline `style` attributes) so the color palette lives in one place and is easy to theme.
