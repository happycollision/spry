import { test as bunTest } from "bun:test";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import type { ScreenSnapshot } from "./ansi-parser.ts";
import type { DocContext, DocEntry, DocFragment } from "./doc-types.ts";

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

const SHA_POOL = [
  "aaa1111",
  "bbb2222",
  "ccc3333",
  "ddd4444",
  "eee5555",
  "fff6666",
  "aaa7777",
  "bbb8888",
  "ccc9999",
  "dddaaaa",
  "eeabbbb",
  "ffbcccc",
  "aacdddd",
  "bbdeeee",
  "cceffff",
  "ddf1234",
  "ee05678",
  "ff19012",
];

export function docTest(
  title: string,
  options: { section: string; order: number; timeout?: number },
  fn: (doc: DocContext) => Promise<void>,
): void {
  bunTest(
    title,
    async () => {
      const entries: DocEntry[] = [];
      const subs: Substitution[] = [];
      let scrubShas = false;
      const shaMap = new Map<string, string>();

      function applyScrub(text: string): string {
        let out = text;
        for (const { pattern, replacement } of subs) {
          if (typeof pattern === "string") {
            out = out.replaceAll(pattern, replacement);
          } else {
            out = out.replace(pattern, replacement);
          }
        }
        if (scrubShas) {
          out = out.replace(/\b[0-9a-f]{7,8}\b/g, (sha) => {
            if (!shaMap.has(sha)) {
              shaMap.set(sha, SHA_POOL[shaMap.size] ?? `sha${shaMap.size}`);
            }
            return shaMap.get(sha) ?? sha;
          });
          // Second pass: literal replacements catch SHAs inside ANSI escape
          // sequences where \b doesn't match across non-word escape characters.
          for (const [original, replacement] of shaMap) {
            out = out.replaceAll(original, replacement);
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
          const plain = stripAnsi(text);
          if (plain !== text) {
            entries.push({
              type: "output",
              content: applyScrub(plain),
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
            scrubShas = true;
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
      // Bun.write creates parent directories automatically.
      await Bun.write(fragmentPath(fragment), JSON.stringify(fragment, null, 2));
    },
    options.timeout,
  );
}
