import { $ } from "bun";
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

/**
 * The scrub engine behind {@link docTest}'s `doc.scrub`/entry rendering,
 * extracted so unit tests (e.g. `doc-repo.test.ts`) can exercise the exact
 * registration-order + substitution semantics the doc pipeline uses.
 * Substitutions are applied in registration order, so an earlier scrub can
 * shadow a later one — that ordering is load-bearing (see `setupDocRepo`).
 */
export interface DocScrubber {
  scrub: DocContext["scrub"];
  apply(this: void, text: string): string;
  /** Repos registered via `scrub(repo)`, in order — used for SHA scanning. */
  repos: Array<{ path: string; originPath: string }>;
}

export function createDocScrubber(): DocScrubber {
  const subs: Substitution[] = [];
  const repos: Array<{ path: string; originPath: string }> = [];

  function apply(text: string): string {
    let out = text;
    for (const { pattern, replacement } of subs) {
      if (typeof pattern === "string") {
        out = out.replaceAll(pattern, replacement);
      } else {
        out = out.replace(pattern, replacement);
      }
    }
    return out;
  }

  function scrub(arg: unknown, replacement?: string): void {
    if (isRepoLike(arg)) {
      subs.push({ pattern: arg.path, replacement: "/tmp/repo" });
      subs.push({ pattern: arg.originPath, replacement: "/tmp/repo-origin" });
      subs.push({ pattern: `-${arg.uniqueId}`, replacement: "" });
      subs.push({ pattern: arg.uniqueId, replacement: "" });
      repos.push({ path: arg.path, originPath: arg.originPath });
    } else if (typeof arg === "string" || arg instanceof RegExp) {
      subs.push({ pattern: arg, replacement: replacement ?? "" });
    } else {
      throw new TypeError("doc.scrub: expected a repo, a string, or a RegExp");
    }
  }

  return { scrub, apply, repos };
}

export function docTest(
  title: string,
  options: { section: string; order: number; timeout?: number },
  fn: (doc: DocContext) => Promise<void>,
): void {
  bunTest(
    title,
    async () => {
      const entries: DocEntry[] = [];
      const scrubber = createDocScrubber();
      const scrubRepos = scrubber.repos;
      const applyScrub = scrubber.apply;

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
        scrub: scrubber.scrub,
      };

      await fn(doc);

      let shas: string[] | undefined;
      let spryIds: string[] | undefined;

      if (scrubRepos.length > 0) {
        const allShas = new Set<string>();
        const allSpryIds = new Set<string>();

        for (const repo of scrubRepos) {
          // Scope the scan to THIS test's own work before walking (spry-4zs6):
          // drop the clone's remote-tracking refs AND their reflogs in one
          // stroke. Under concurrent record the origin is the shared
          // spry-check repo, and `sp sync`'s fetch pulls every in-flight
          // sibling's branches into refs/remotes/* — the `--all --reflog`
          // walk below would sweep those foreign commits, making SHA
          // discovery count and order racy across runs (`--exclude` cannot
          // fix it: the remote-tracking REFLOGS still feed `--reflog`).
          // Nothing this test created is lost: its commits stay reachable
          // from local branches, the HEAD/refs-heads reflogs (fetch never
          // writes those), and the origin-side walk. The scan runs after the
          // test body and the repo is torn down right after, so the mutation
          // is invisible to the test. Replay discovery is unchanged: a local
          // bare origin only ever contains this test's own pushes, so its
          // remote-tracking refs were redundant with the other walks
          // (acceptance bar: docs/generated stays byte-identical).
          await $`git -C ${repo.path} remote remove origin`.quiet().nothrow();

          // `--all --reflog` walks every ref AND every reflog entry, following
          // each back through its ancestors. This matters when a doc test
          // captures a screen showing pre-rewrite hashes (e.g. the MOVE-MODE
          // preview in `sp group`) and then saves, which rewrites the stack with
          // fresh commits and orphans the displayed ones. Such a commit is gone
          // from `log --all` (no ref reaches it) and is not itself a `git reflog`
          // entry (it was an interior commit, never a ref tip) — but it is still
          // an ancestor of the old ref tip, which the reflog kept. Walking the
          // reflog's history therefore recovers it, so its hash gets scrubbed
          // instead of leaking raw into the docs.
          const results = await Promise.allSettled([
            $`git -C ${repo.path} log --all --reflog --format=%H`.quiet().nothrow().text(),
            $`git -C ${repo.path} log --all --reflog --format=%B`.quiet().nothrow().text(),
            $`git --git-dir=${repo.originPath} log --all --reflog --format=%H`
              .quiet()
              .nothrow()
              .text(),
            $`git --git-dir=${repo.originPath} log --all --reflog --format=%B`
              .quiet()
              .nothrow()
              .text(),
          ]);

          const texts = results.map((r) => (r.status === "fulfilled" ? r.value : ""));
          const shaText = [texts[0], texts[2]].join("\n");
          const bodies = [texts[1], texts[3]].join("\n");

          for (const line of shaText.split("\n")) {
            const sha = line.trim();
            if (/^[0-9a-f]{40}$/.test(sha)) allShas.add(sha);
          }

          for (const match of bodies.matchAll(/^Spry-Commit-Id:\s+([0-9a-f]{8})\s*$/gm)) {
            if (match[1]) allSpryIds.add(match[1]);
          }
        }

        shas = [...allShas];
        spryIds = [...allSpryIds];
      }

      const fragment: DocFragment = {
        title,
        section: options.section,
        order: options.order,
        entries,
        ...(shas !== undefined && { shas }),
        ...(spryIds !== undefined && { spryIds }),
      };
      // Bun.write creates parent directories automatically.
      await Bun.write(fragmentPath(fragment), JSON.stringify(fragment, null, 2));
    },
    options.timeout,
  );
}
