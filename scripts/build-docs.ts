import type { DocFragment, DocEntry } from "../tests/lib/doc-types.ts";
import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";

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
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  if (jsonFiles.length === 0) return 0;

  const fragments: DocFragment[] = await Promise.all(
    jsonFiles.map(async (f) => JSON.parse(await Bun.file(join(fragmentsDir, f)).text())),
  );
  const docs = assembleMarkdown(fragments);
  for (const [section, content] of docs) {
    const filePath = join(outDir, `${section}.md`);
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
