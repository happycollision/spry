import { test as bunTest } from "bun:test";
import { join } from "node:path";
import type { DocContext, DocEntry, DocFragment } from "./doc-types.ts";

export type { DocContext, DocEntry, DocFragment } from "./doc-types.ts";

const FRAGMENTS_DIR = join(import.meta.dir, "../../.test-tmp/doc-fragments");

export function fragmentPath(fragment: Pick<DocFragment, "section" | "order">): string {
  const section = fragment.section.replaceAll("/", "__");
  const order = String(fragment.order).padStart(3, "0");
  return join(FRAGMENTS_DIR, `${section}--${order}.json`);
}

// In-memory collection stays in place until Task 5 finishes migrating consumers.
let fragments: DocFragment[] = [];

export function getDocFragments(): DocFragment[] {
  return fragments;
}

export function clearDocFragments(): void {
  fragments = [];
}

export function collectFragment(fragment: DocFragment): void {
  fragments.push(fragment);
}

export function docTest(
  title: string,
  options: { section: string; order: number },
  fn: (doc: DocContext) => Promise<void>,
): void {
  bunTest(title, async () => {
    const entries: DocEntry[] = [];

    const doc: DocContext = {
      prose(text) {
        entries.push({ type: "prose", content: text });
      },
      command(input) {
        entries.push({ type: "command", content: input });
      },
      output(text) {
        entries.push({ type: "output", content: text });
      },
      screen(text) {
        entries.push({ type: "screen", content: text });
      },
    };

    await fn(doc);

    const fragment: DocFragment = {
      title,
      section: options.section,
      order: options.order,
      entries,
    };
    collectFragment(fragment);
    // Bun.write creates parent directories automatically.
    await Bun.write(fragmentPath(fragment), JSON.stringify(fragment, null, 2));
  });
}
