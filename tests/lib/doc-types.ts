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
