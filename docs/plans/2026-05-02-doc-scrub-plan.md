# Doc-fragment scrub Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `scrub` mechanism to `DocContext` so doc tests can replace dynamic values (repo unique IDs, temp paths) before they're captured into doc fragments, eliminating churn in `docs/generated/**`.

**Architecture:** Substitutions are registered on the `DocContext` and applied at capture time inside `command`, `output`, and `screen`. `prose` is exempt. `scrub(repo)` is a shorthand that registers the repo's `path → /tmp/repo`, `originPath → /tmp/repo-origin`, and `uniqueId → ""` (in that order, so the path is replaced as a unit before the bare ID is stripped). `scrub(pattern, replacement)` registers ad-hoc string-or-regex substitutions.

**Tech Stack:** Bun test, TypeScript. Tests run via Docker per project convention (`bun run test:local:docker` for the integration test that exercises `view.doc.test.ts`; `bun run test:docker` for unit tests). Design doc: [docs/plans/2026-05-02-doc-scrub-design.md](2026-05-02-doc-scrub-design.md).

---

### Task 1: Extend `DocContext` type with `scrub` overloads

**Files:**

- Modify: `tests/lib/doc-types.ts`

**Step 1: Edit the interface**

Add `scrub` overloads to `DocContext` in `tests/lib/doc-types.ts`. Final interface:

```ts
export interface DocContext {
  prose(text: string): void;
  command(input: string): void;
  output(text: string): void;
  screen(text: string): void;
  scrub(repo: { uniqueId: string; path: string; originPath: string }): void;
  scrub(pattern: string | RegExp, replacement: string): void;
}
```

**Step 2: Verify it typechecks**

Run: `bun run tsc --noEmit` (or whatever typecheck the project uses; if unsure, run `bun test --bail tests/lib/doc.test.ts` — type errors will surface there).
Expected: existing `tests/lib/doc.ts` will fail to satisfy the interface because `scrub` isn't implemented yet. That's fine — Task 2 fixes it.

**Step 3: Do not commit yet** — interface and impl ship together.

---

### Task 2: Add failing tests for `scrub`

**Files:**

- Modify: `tests/lib/doc.test.ts`

**Step 1: Append three new tests** to `tests/lib/doc.test.ts` (at the end of the file, after the existing tests):

```ts
test("doc.scrub(pattern, replacement) replaces literal strings in output/command/screen", async () => {
  const fragmentOpts = { section: "doc/scrub/literal", order: 901 };
  const path = fragmentPath(fragmentOpts);
  await rm(path, { force: true });

  // run the docTest synchronously by reusing the helper's bun-test wrapping
  // is awkward; instead, simulate by inlining what docTest does:
  const entries: import("./doc.ts").DocEntry[] = [];
  // Build a doc context the same way docTest does. Since docTest registers a
  // bun test, the simplest path is to write a real docTest below and assert
  // on the resulting fragment.
});
```

The above sketch is wrong — `docTest` registers a `bun:test` test, so the cleanest approach is to use `docTest` to drive the assertions and then check the on-disk fragment in a follow-up `test()` (matching the pattern already used at lines 17–32 of `tests/lib/doc.test.ts`).

Replace the sketch with three real test pairs:

```ts
// --- scrub: literal pattern ---
docTest(
  "scrub replaces literal strings in captured entries",
  { section: "doc/scrub/literal", order: 901 },
  async (doc) => {
    doc.scrub("SECRET", "<redacted>");
    doc.command("echo SECRET");
    doc.output("value=SECRET");
    doc.screen("frame SECRET");
    doc.prose("prose SECRET");  // prose is exempt
  },
);

test("scrub literal: command/output/screen are scrubbed, prose is not", async () => {
  const path = fragmentPath({ section: "doc/scrub/literal", order: 901 });
  const parsed = JSON.parse(await readFile(path, "utf8"));
  expect(parsed.entries).toEqual([
    { type: "command", content: "echo <redacted>" },
    { type: "output", content: "value=<redacted>" },
    { type: "screen", content: "frame <redacted>" },
    { type: "prose", content: "prose SECRET" },
  ]);
});

// --- scrub: regex pattern ---
docTest(
  "scrub accepts regex patterns",
  { section: "doc/scrub/regex", order: 902 },
  async (doc) => {
    doc.scrub(/[0-9]+/g, "N");
    doc.output("port=8080 retries=3");
  },
);

test("scrub regex: replaces all matches", async () => {
  const path = fragmentPath({ section: "doc/scrub/regex", order: 902 });
  const parsed = JSON.parse(await readFile(path, "utf8"));
  expect(parsed.entries).toEqual([{ type: "output", content: "port=N retries=N" }]);
});

// --- scrub: repo shorthand ---
docTest(
  "scrub(repo) replaces uniqueId and paths",
  { section: "doc/scrub/repo", order: 903 },
  async (doc) => {
    const fakeRepo = {
      uniqueId: "pure-goat-vx6",
      path: "/tmp/spry-test-pure-goat-vx6",
      originPath: "/tmp/spry-test-origin-pure-goat-vx6",
    };
    doc.scrub(fakeRepo);
    doc.output(
      "branch=feature-pure-goat-vx6 cwd=/tmp/spry-test-pure-goat-vx6 origin=/tmp/spry-test-origin-pure-goat-vx6",
    );
  },
);

test("scrub(repo): paths replaced as a unit, then bare uniqueId stripped", async () => {
  const path = fragmentPath({ section: "doc/scrub/repo", order: 903 });
  const parsed = JSON.parse(await readFile(path, "utf8"));
  expect(parsed.entries).toEqual([
    {
      type: "output",
      content: "branch=feature- cwd=/tmp/repo origin=/tmp/repo-origin",
    },
  ]);
});
```

Also update the `beforeAll`/`afterAll` blocks at the top of the file to clean up the three new fragment files. Replace:

```ts
beforeAll(async () => {
  await rm(join(fragmentsDir, "doc__disk_bridge__unit--900.json"), { force: true });
});

afterAll(async () => {
  await rm(join(fragmentsDir, "doc__disk_bridge__unit--900.json"), { force: true });
});
```

with:

```ts
const cleanupPaths = [
  "doc__disk_bridge__unit--900.json",
  "doc__scrub__literal--901.json",
  "doc__scrub__regex--902.json",
  "doc__scrub__repo--903.json",
];

beforeAll(async () => {
  await Promise.all(cleanupPaths.map((p) => rm(join(fragmentsDir, p), { force: true })));
});

afterAll(async () => {
  await Promise.all(cleanupPaths.map((p) => rm(join(fragmentsDir, p), { force: true })));
});
```

**Step 2: Run the new tests, expect failure**

Run: `bun run test:docker 2>&1 | tail -40`
Expected: the three new `docTest` cases fail because `doc.scrub` is not a function. (The pattern is the existing `tests/lib/doc.test.ts` lines 25–32: docTest writes the fragment, the follow-up `test()` reads and asserts.)

**Step 3: Do not commit** — implementation comes next.

---

### Task 3: Implement `scrub` in `tests/lib/doc.ts`

**Files:**

- Modify: `tests/lib/doc.ts`

**Step 1: Replace the `docTest` body**

Update `tests/lib/doc.ts` so `docTest` maintains a `subs` array and applies them in `command`/`output`/`screen`:

```ts
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

interface Substitution {
  pattern: string | RegExp;
  replacement: string;
}

function isRepoLike(value: unknown): value is { uniqueId: string; path: string; originPath: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { uniqueId?: unknown }).uniqueId === "string" &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { originPath?: unknown }).originPath === "string"
  );
}

export function docTest(
  title: string,
  options: { section: string; order: number },
  fn: (doc: DocContext) => Promise<void>,
): void {
  bunTest(title, async () => {
    const entries: DocEntry[] = [];
    const subs: Substitution[] = [];

    function applyScrub(text: string): string {
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

    const doc: DocContext = {
      prose(text) {
        entries.push({ type: "prose", content: text });
      },
      command(input) {
        entries.push({ type: "command", content: applyScrub(input) });
      },
      output(text) {
        entries.push({ type: "output", content: applyScrub(text) });
      },
      screen(text) {
        entries.push({ type: "screen", content: applyScrub(text) });
      },
      scrub(arg: unknown, replacement?: string) {
        if (isRepoLike(arg)) {
          subs.push({ pattern: arg.path, replacement: "/tmp/repo" });
          subs.push({ pattern: arg.originPath, replacement: "/tmp/repo-origin" });
          subs.push({ pattern: arg.uniqueId, replacement: "" });
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
    await Bun.write(fragmentPath(fragment), JSON.stringify(fragment, null, 2));
  });
}
```

Key invariants:

- `applyScrub` runs subs in registration order, so `scrub(repo)` registers paths _before_ `uniqueId` so paths are replaced as a unit.
- `string` patterns use `replaceAll` (literal, all occurrences). `RegExp` patterns use a single `replace` (caller controls `g` flag).
- `prose` is intentionally not scrubbed.

**Step 2: Run the doc tests**

Run: `bun run test:docker 2>&1 | tail -40`
Expected: all `tests/lib/doc.test.ts` cases pass, including the new ones from Task 2.

**Step 3: Commit**

```bash
git add tests/lib/doc-types.ts tests/lib/doc.ts tests/lib/doc.test.ts
git commit -m "feat(doc-test): add scrub() to prevent dynamic-value churn in doc fragments"
```

---

### Task 4: Apply `doc.scrub(repo)` in the view doc tests

**Files:**

- Modify: `tests/commands/view.doc.test.ts`

**Step 1: Add `doc.scrub(repo)` immediately after the repo is created**

In `tests/commands/view.doc.test.ts`, in both `docTest` callbacks (the simple-stack test at line 17 and the empty-stack test at line 52), insert `doc.scrub(repo);` on the line right after `repos.push(repo);`. Final shape of each test starts:

```ts
const repo = await createRepo();
repos.push(repo);
doc.scrub(repo);
const git = createRealGitRunner();
```

**Step 2: Run the view doc tests**

Run: `bun run test:local:docker 2>&1 | tail -30`
Expected: both tests pass (`view.doc.test.ts` exercises real `sp` commands; per CLAUDE.md it lives behind the local-integration suite).

**Step 3: Regenerate docs**

Run: `bun run docs:build`
Expected: prints `Generated N doc files.`

**Step 4: Verify churn is gone**

Run: `git diff docs/generated/commands/view.md`
Expected: the only diffs vs. the previous committed version are deterministic — `feature-<id>` collapsed to `feature-`, no random adjective-noun-suffix anywhere. Re-run `bun run test:local:docker && bun run docs:build && git diff docs/generated/commands/view.md` a second time:
Expected: **empty diff** between the two consecutive runs.

**Step 5: Update the changelog**

Per CLAUDE.md's per-commit changelog rule, add an entry under the `Unreleased` section of `CHANGELOG.md` (or whatever the existing convention is — check the file first):

```markdown
- Doc fragments now support a `doc.scrub(repo | pattern, replacement?)` helper so generated docs stay deterministic across test runs.
```

**Step 6: Commit**

```bash
git add tests/commands/view.doc.test.ts docs/generated/commands/view.md CHANGELOG.md
git commit -m "feat(doc-test): scrub repo identifiers from view doc fragments"
```

---

## Done criteria

- [ ] `bun run test:docker` passes (unit tests, including new `tests/lib/doc.test.ts` cases).
- [ ] `bun run test:local:docker` passes (`view.doc.test.ts`).
- [ ] Two back-to-back runs of `bun run test:local:docker && bun run docs:build` produce **zero** `git diff` on `docs/generated/commands/view.md`.
- [ ] `CHANGELOG.md` updated.
- [ ] Two commits on the branch: feature commit (Task 3) and use-site commit (Task 4).
