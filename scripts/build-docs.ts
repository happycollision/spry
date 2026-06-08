import type { DocFragment, DocEntry } from "../tests/lib/doc-types.ts";
import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import AnsiToHtml from "ansi-to-html";
import { buildShaMap, buildSpryMap, scanAndReplace } from "../tests/lib/sha-scanner.ts";

/** Assemble doc fragments into markdown strings grouped by section. */
export function assembleMarkdown(fragments: DocFragment[]): Map<string, string> {
  // Group by section
  const sections = new Map<string, DocFragment[]>();
  for (const fragment of fragments) {
    const existing = sections.get(fragment.section) ?? [];
    existing.push(fragment);
    sections.set(fragment.section, existing);
  }

  // Sort within each section by order
  const result = new Map<string, string>();
  for (const [section, frags] of sections) {
    frags.sort((a, b) => a.order - b.order);

    // Section title from last segment of section path
    const sectionName = section.split("/").pop() ?? section;
    const lines: string[] = [`# ${sectionName}`, ""];

    for (const frag of frags) {
      for (const entry of frag.entries) {
        lines.push(renderEntry(entry));
        lines.push("");
      }
    }

    result.set(section, lines.join("\n"));
  }

  return result;
}

function renderEntry(entry: DocEntry): string {
  switch (entry.type) {
    case "prose":
      return entry.content;
    case "command":
      return `\`\`\`\n${entry.content}\n\`\`\``;
    case "output":
      return `\`\`\`\n${entry.content}\n\`\`\``;
    case "screen":
      return `\`\`\`\n${entry.content}\n\`\`\``;
  }
}

const converter = new AnsiToHtml({ escapeXML: true, newline: false });

const HTML_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; max-width: 860px; color: #e8e8e8; background: #1a1a1a; }
  h1 { font-size: 1.4rem; margin-bottom: 1.5rem; color: #fff; }
  p { margin-bottom: 1rem; }
  pre { font-family: ui-monospace, 'Cascadia Code', monospace; font-size: 0.85rem; padding: 1rem; border-radius: 6px; overflow-x: auto; margin-bottom: 1rem; white-space: pre; }
  pre.command { background: #0d1117; color: #c9d1d9; border-left: 3px solid #58a6ff; }
  pre.output { background: #0d1117; color: #c9d1d9; }
  pre.screen { background: #0d1117; color: #c9d1d9; }
  .ansi-black { color: #000; } .ansi-red { color: #c0392b; } .ansi-green { color: #27ae60; }
  .ansi-yellow { color: #f39c12; } .ansi-blue { color: #2980b9; } .ansi-magenta { color: #8e44ad; }
  .ansi-cyan { color: #16a085; } .ansi-white { color: #bdc3c7; }
  .ansi-bright-black { color: #7f8c8d; } .ansi-bright-red { color: #e74c3c; } .ansi-bright-green { color: #2ecc71; }
  .ansi-bright-yellow { color: #f1c40f; } .ansi-bright-blue { color: #3498db; } .ansi-bright-magenta { color: #9b59b6; }
  .ansi-bright-cyan { color: #1abc9c; } .ansi-bright-white { color: #ecf0f1; }
  .ansi-bold { font-weight: bold; }
`.trim();

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

    result.set(
      section,
      `<!DOCTYPE html>
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
</html>`,
    );
  }

  return result;
}

function scrubFragments(fragments: DocFragment[]): DocFragment[] {
  const allShas: string[] = [];
  const allSpryIds: string[] = [];

  for (const frag of fragments) {
    if (frag.shas) {
      for (const sha of frag.shas) {
        if (!allShas.includes(sha)) allShas.push(sha);
      }
    }
    if (frag.spryIds) {
      for (const id of frag.spryIds) {
        if (!allSpryIds.includes(id)) allSpryIds.push(id);
      }
    }
  }

  if (allShas.length === 0 && allSpryIds.length === 0) return fragments;

  const shaMap = buildShaMap(allShas);
  const spryMap = buildSpryMap(allSpryIds);

  return fragments.map((frag) => ({
    ...frag,
    entries: frag.entries.map((entry) => ({
      ...entry,
      content: scanAndReplace(entry.content, shaMap, spryMap),
      ...(entry.ansiContent !== undefined && {
        ansiContent: scanAndReplace(entry.ansiContent, shaMap, spryMap),
      }),
    })),
  }));
}

export async function buildDocsFromDisk(fragmentsDir: string, outDir: string): Promise<number> {
  let files: string[];
  try {
    files = await readdir(fragmentsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      files = [];
    } else {
      throw err;
    }
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
  if (jsonFiles.length === 0) return 0;

  const fragments: DocFragment[] = await Promise.all(
    jsonFiles.map(async (f) => JSON.parse(await Bun.file(join(fragmentsDir, f)).text())),
  );
  const scrubbedFragments = scrubFragments(fragments);
  const docs = assembleMarkdown(scrubbedFragments);
  for (const [section, content] of docs) {
    const filePath = join(outDir, `${section}.md`);
    await mkdir(join(filePath, ".."), { recursive: true });
    await Bun.write(filePath, content);
  }

  const htmlDocs = assembleHtml(scrubbedFragments);
  for (const [section, content] of htmlDocs) {
    const filePath = join(outDir, `${section}.html`);
    await mkdir(join(filePath, ".."), { recursive: true });
    await Bun.write(filePath, content);
  }

  return docs.size;
}

if (import.meta.main) {
  const fragmentsDir = join(import.meta.dir, "../.test-tmp/doc-fragments");
  const outDir = join(import.meta.dir, "../docs/generated");
  const count = await buildDocsFromDisk(fragmentsDir, outDir);
  if (count === 0) {
    console.log("No doc fragments collected. Run `bun test` first.");
    process.exit(0);
  }
  console.log(`Generated ${count} doc files.`);
}
