import type { DocFragment, DocEntry } from "../tests/lib/doc.ts";

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
    const sectionName = section.split("/").pop()!;
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

// CLI entrypoint — run with: bun run scripts/build-docs.ts
if (import.meta.main) {
  const { getDocFragments } = await import("../tests/lib/doc.ts");
  const { mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const fragments = getDocFragments();
  if (fragments.length === 0) {
    console.log("No doc fragments collected. Run tests first.");
    process.exit(0);
  }

  const docs = assembleMarkdown(fragments);
  const outDir = join(import.meta.dir, "../docs/generated");

  for (const [section, content] of docs) {
    const filePath = join(outDir, `${section}.md`);
    await mkdir(join(filePath, ".."), { recursive: true });
    await Bun.write(filePath, content);
    console.log(`  wrote ${filePath}`);
  }

  console.log(`Generated ${docs.size} doc files.`);
}
