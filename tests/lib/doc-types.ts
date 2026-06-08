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
  shas?: string[]; // all 40-char git SHAs seen in this test's repos
  spryIds?: string[]; // all Spry-Commit-Id trailer values (8-char hex)
}

export interface DocContext {
  prose(text: string): void;
  command(input: string): void;
  output(text: string): void;
  screen(snapshot: ScreenSnapshot): void;
  scrub(repo: { uniqueId: string; path: string; originPath: string }): void;
  scrub(pattern: string | RegExp, replacement: string): void;
}
