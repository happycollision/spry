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
  scrub(repo: { uniqueId: string; path: string; originPath: string }): void;
  scrub(pattern: string | RegExp, replacement: string): void;
}
