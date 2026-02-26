import { test as bunTest } from "bun:test";

export interface DocEntry {
  type: "prose" | "command" | "output" | "screen";
  content: string;
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
  screen(text: string): void;
}

// Global fragment collection
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
      prose(text: string) {
        entries.push({ type: "prose", content: text });
      },
      command(input: string) {
        entries.push({ type: "command", content: input });
      },
      output(text: string) {
        entries.push({ type: "output", content: text });
      },
      screen(text: string) {
        entries.push({ type: "screen", content: text });
      },
    };

    await fn(doc);

    // Only collect fragment if test passes (if fn throws, we never get here)
    collectFragment({
      title,
      section: options.section,
      order: options.order,
      entries,
    });
  });
}
