# Doc Fragment Disk Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire `docTest()` fragments through disk so `bun run docs:build` can actually produce `docs/generated/*.md`, closing the gap left by Task 12 of the test-first rebuild.

**Architecture:** Split `tests/lib/doc.ts` into a pure-types module (`doc-types.ts`, safe to import anywhere) plus a runtime module that keeps `docTest` and writes each passing fragment to `.test-tmp/doc-fragments/<section>--<order>.json`. Rewrite `scripts/build-docs.ts` to read that directory instead of importing `getDocFragments()` in-process. Delete the in-memory collection API — the disk files are the source of truth. Deterministic filenames give overwrite-on-rerun semantics without a wipe step. Add `bun run docs:clean` as the escape hatch for stale fragments.

**Tech Stack:** Bun (`bun test`, `Bun.write`, `Bun.file`), TypeScript, `node:fs/promises` for directory listing.

**Design doc:** [docs/plans/2026-04-22-doc-fragment-disk-bridge-design.md](./2026-04-22-doc-fragment-disk-bridge-design.md)

---

## Task 1: Extract types into `doc-types.ts`

Split pure interfaces out of `doc.ts` so non-test processes (like `build-docs.ts`) can import them without pulling in `bun:test`.

**Files:**

- Create: `tests/lib/doc-types.ts`
- Modify: `tests/lib/doc.ts`

**Step 1: Create the types file**

Create `tests/lib/doc-types.ts` with exactly this content:

```ts
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
```

**Step 2: Update `doc.ts` to re-export types from `doc-types.ts`**

Remove the three `interface` blocks at the top of `tests/lib/doc.ts` and replace them with a re-export:

```ts
import { test as bunTest } from "bun:test";
import type { DocContext, DocEntry, DocFragment } from "./doc-types.ts";

export type { DocContext, DocEntry, DocFragment } from "./doc-types.ts";
```

Everything else in `doc.ts` stays as-is for now (in-memory array plus `docTest`).

**Step 3: Run full test suite to confirm nothing broke**

Run: `bun run test:docker`
Expected: all tests pass (this is a pure refactor).

**Step 4: Commit**

```bash
git add tests/lib/doc-types.ts tests/lib/doc.ts
git commit -m "refactor(test-lib): extract doc types into doc-types.ts"
```

---

## Task 2: Write failing test for disk-writing `docTest`

Add a test that asserts `docTest` writes a fragment JSON file to `.test-tmp/doc-fragments/` after its body passes. TDD red step.

**Files:**

- Modify: `tests/lib/doc.test.ts`

**Step 1: Write the failing test**

Append this test to `tests/lib/doc.test.ts`. Use a distinctive section path so the resulting file is easy to spot and clean up:

```ts
import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { docTest } from "./doc.ts";

const repoRoot = join(import.meta.dir, "../..");
const fragmentsDir = join(repoRoot, ".test-tmp/doc-fragments");

afterEach(async () => {
  await rm(join(fragmentsDir, "doc__disk_bridge__unit--900.json"), { force: true });
});

// docTest registers a bun test internally. It must run at module load time.
docTest(
  "writes fragment to disk on pass",
  { section: "doc/disk_bridge/unit", order: 900 },
  async (doc) => {
    doc.prose("unit-test fragment");
  },
);

test("docTest wrote the fragment JSON after running", async () => {
  const path = join(fragmentsDir, "doc__disk_bridge__unit--900.json");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  expect(parsed.section).toBe("doc/disk_bridge/unit");
  expect(parsed.order).toBe(900);
  expect(parsed.entries).toEqual([{ type: "prose", content: "unit-test fragment" }]);
});
```

Note: the slashes in `doc/disk_bridge/unit` become `__` and order `900` pads to `900`, so the file is `doc__disk_bridge__unit--900.json`. The fragment-written test runs _after_ the docTest registers and executes — they share a process, and bun runs tests in file order.

**Step 2: Run test to verify it fails**

Run: `bun run test:docker -- tests/lib/doc.test.ts`
Expected: FAIL on the `readFile` call with `ENOENT` — the file does not exist because nothing writes it yet.

**Step 3: Commit the failing test**

```bash
git add tests/lib/doc.test.ts
git commit -m "test(test-lib): add failing test for docTest disk write"
```

---

## Task 3: Implement disk writing in `docTest`

Make the test from Task 2 pass. Add a `fragmentPath` helper and a `Bun.write` inside `docTest` after the body succeeds. Keep the in-memory array in place for now — it will be removed in Task 6 after `build-docs.ts` has been migrated off of it.

**Files:**

- Modify: `tests/lib/doc.ts`

**Step 1: Implement the disk-write path**

Replace the body of `tests/lib/doc.ts` with:

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

// In-memory collection stays in place until Task 6 finishes migrating consumers.
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
      prose(text) { entries.push({ type: "prose", content: text }); },
      command(input) { entries.push({ type: "command", content: input }); },
      output(text) { entries.push({ type: "output", content: text }); },
      screen(text) { entries.push({ type: "screen", content: text }); },
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
```

**Step 2: Run the Task 2 test**

Run: `bun run test:docker -- tests/lib/doc.test.ts`
Expected: PASS. The fragment file now exists on disk after the docTest body runs.

**Step 3: Run the full suite**

Run: `bun run test:docker`
Expected: all tests pass.

**Step 4: Commit**

```bash
git add tests/lib/doc.ts
git commit -m "feat(test-lib): write docTest fragments to .test-tmp/doc-fragments"
```

---

## Task 4: Write failing test for disk-reading `build-docs.ts`

TDD red step for the consumer side. Add a test that sets up a tmp fragments dir, seeds it with two JSON files, invokes the CLI entry of `build-docs.ts`, and asserts markdown files appear in a tmp output dir.

**Files:**

- Modify: `scripts/build-docs.test.ts`

**Step 1: Refactor `build-docs.ts` CLI entry into a callable function**

(Prerequisite for testing without running the script's top-level `import.meta.main` block.)

Update `scripts/build-docs.ts` to export a named function that drives the directory read + write, and have the `import.meta.main` block just call it:

```ts
// ... keep assembleMarkdown and renderEntry unchanged ...

import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DocFragment } from "../tests/lib/doc-types.ts";

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
```

At this step, also remove the old `import("../tests/lib/doc.ts")` and `getDocFragments()` lines.

**Step 2: Write the failing integration test**

Append to `scripts/build-docs.test.ts`:

````ts
import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, readFile } from "node:fs/promises";
import { buildDocsFromDisk } from "./build-docs.ts";

const tmpRoot = join(import.meta.dir, "../.test-tmp/build-docs-test");

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

test("buildDocsFromDisk reads fragments and writes markdown", async () => {
  const fragmentsDir = join(tmpRoot, "fragments");
  const outDir = join(tmpRoot, "out");
  await mkdir(fragmentsDir, { recursive: true });

  await Bun.write(
    join(fragmentsDir, "commands__demo--010.json"),
    JSON.stringify({
      title: "Basic demo",
      section: "commands/demo",
      order: 10,
      entries: [{ type: "prose", content: "Hello, docs." }],
    }),
  );
  await Bun.write(
    join(fragmentsDir, "commands__demo--020.json"),
    JSON.stringify({
      title: "Demo with command",
      section: "commands/demo",
      order: 20,
      entries: [{ type: "command", content: "sp demo" }],
    }),
  );

  const count = await buildDocsFromDisk(fragmentsDir, outDir);
  expect(count).toBe(1);

  const markdown = await readFile(join(outDir, "commands/demo.md"), "utf8");
  expect(markdown).toContain("# demo");
  expect(markdown).toContain("Hello, docs.");
  expect(markdown).toContain("```\nsp demo\n```");
  expect(markdown.indexOf("Hello, docs.")).toBeLessThan(markdown.indexOf("sp demo"));
});

test("buildDocsFromDisk returns 0 when fragments dir is missing", async () => {
  const count = await buildDocsFromDisk(join(tmpRoot, "nonexistent"), join(tmpRoot, "out"));
  expect(count).toBe(0);
});
````

**Step 3: Run the tests**

Run: `bun run test:docker -- scripts/build-docs.test.ts`
Expected: the new tests PASS (the refactor in Step 1 already implements the behavior). Confirm the existing `assembleMarkdown` unit tests still pass.

If everything passes, continue to Step 4. If anything fails, fix the refactor before committing.

**Step 4: Run the full suite**

Run: `bun run test:docker`
Expected: all tests pass.

**Step 5: Commit**

```bash
git add scripts/build-docs.ts scripts/build-docs.test.ts
git commit -m "feat(docs-build): read fragments from disk instead of in-process array"
```

---

## Task 5: Remove in-memory fragment API

The disk bridge is live. Delete `collectFragment`, `getDocFragments`, `clearDocFragments` and the `fragments[]` array. Update the two existing tests that assert on the in-memory API to assert on disk instead.

**Files:**

- Modify: `tests/lib/doc.ts`
- Modify: `tests/lib/doc.test.ts`
- Modify: `tests/lib/smoke.test.ts`
- Modify: `tests/lib/index.ts`

**Step 1: Delete the in-memory API from `doc.ts`**

Edit `tests/lib/doc.ts`:

- Delete `let fragments: DocFragment[] = [];`
- Delete `getDocFragments`, `clearDocFragments`, `collectFragment`.
- In `docTest`, replace `collectFragment(fragment)` with just the `Bun.write(...)` call.

**Step 2: Update `tests/lib/doc.test.ts`**

Replace the entire file contents with tests that only exercise the disk path. Keep the Task 2 test. Remove anything that imports or calls `collectFragment` / `getDocFragments` / `clearDocFragments`. The final shape:

```ts
import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { docTest, fragmentPath } from "./doc.ts";

const repoRoot = join(import.meta.dir, "../..");
const fragmentsDir = join(repoRoot, ".test-tmp/doc-fragments");

afterEach(async () => {
  await rm(join(fragmentsDir, "doc__disk_bridge__unit--900.json"), { force: true });
});

docTest(
  "writes fragment to disk on pass",
  { section: "doc/disk_bridge/unit", order: 900 },
  async (doc) => {
    doc.prose("unit-test fragment");
  },
);

test("docTest wrote the fragment JSON after running", async () => {
  const path = fragmentPath({ section: "doc/disk_bridge/unit", order: 900 });
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  expect(parsed.section).toBe("doc/disk_bridge/unit");
  expect(parsed.order).toBe(900);
  expect(parsed.entries).toEqual([{ type: "prose", content: "unit-test fragment" }]);
});

test("fragmentPath escapes slashes and pads order", () => {
  const path = fragmentPath({ section: "commands/view", order: 10 });
  expect(path.endsWith("/commands__view--010.json")).toBe(true);
});
```

**Step 3: Update `tests/lib/smoke.test.ts`**

Find the Pillar 4 block (the one that calls `collectFragment` and `getDocFragments`). Replace it with a disk assertion — either exercise `docTest` directly or write a fragment file via `Bun.write` and assert it exists. The simplest rewrite:

```ts
// Pillar 4: DocEmitter (disk write)
// Using Bun.write directly to avoid registering a bun test inside a bun test.
const smokeFragment = {
  title: "Smoke test",
  section: "meta/smoke",
  order: 1,
  entries: [{ type: "prose", content: "All four pillars verified." }],
};
const smokePath = fragmentPath(smokeFragment);
await Bun.write(smokePath, JSON.stringify(smokeFragment));
expect(await Bun.file(smokePath).exists()).toBe(true);
```

Update the imports in `smoke.test.ts` accordingly:

- Remove `collectFragment`, `getDocFragments`, `clearDocFragments` from the import list.
- Add `fragmentPath` to the import list (from `./index.ts`).
- Remove the `clearDocFragments()` call in `afterEach`; instead, `rm` the smoke fragment file.

Final smoke afterEach:

```ts
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await rm(fragmentPath({ section: "meta/smoke", order: 1 }), { force: true });
});
```

**Step 4: Update `tests/lib/index.ts`**

In `tests/lib/index.ts`:

- Remove `getDocFragments`, `clearDocFragments`, `collectFragment` from the `export { ... } from "./doc.ts"` line.
- Add `fragmentPath` to that same line.

**Step 5: Run the full suite**

Run: `bun run test:docker`
Expected: all tests pass. There should be no references to the deleted symbols anywhere.

**Step 6: Verify no stragglers**

Run: `grep -rn "collectFragment\|getDocFragments\|clearDocFragments" src tests scripts`
Expected: no output (zero matches).

**Step 7: Commit**

```bash
git add tests/lib/doc.ts tests/lib/doc.test.ts tests/lib/smoke.test.ts tests/lib/index.ts
git commit -m "refactor(test-lib): drop in-memory doc fragment API"
```

---

## Task 6: Add `docs:clean` script

Minor package.json edit. The escape hatch for stale fragments after renaming or deleting a doc test.

**Files:**

- Modify: `package.json`

**Step 1: Add the script**

In `package.json`, inside `"scripts"`, add one line after `docs:build`:

```json
"docs:clean": "rm -rf .test-tmp/doc-fragments docs/generated",
```

**Step 2: Smoke-test the script**

Run: `bun run docs:clean`
Expected: exit code 0, no output (or no error). `.test-tmp/doc-fragments/` and `docs/generated/` should be gone after it.

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add docs:clean script for stale doc fragments"
```

---

## Task 7: Update README

Document how the doc pipeline works under the existing Development section.

**Files:**

- Modify: `README.md`

**Step 1: Add the "Documentation tests" subsection**

Find the `## Development` section in `README.md`. After the existing development commands (`bun test`, `bunx tsc`, etc.), add a new subsection:

````markdown
### Documentation tests

Some tests double as the source of user-facing documentation. They're written with `docTest` (see `tests/commands/view.doc.test.ts` for an example). When a doc test passes, it writes a JSON fragment to `.test-tmp/doc-fragments/`. The `docs:build` script assembles those fragments into markdown under `docs/generated/`.

```bash
# Full pipeline: run tests, then assemble docs
bun test
bun run docs:build

# Wipe generated docs and fragment cache (e.g. after renaming a doc test)
bun run docs:clean
````

Notes:

- A doc test that fails writes no fragment. Broken tests ⇒ broken or missing docs.
- `.test-tmp/` and `docs/generated/` are gitignored build artifacts. Do not commit them.
- Re-running a single doc test overwrites only its own fragment file. Other tests' fragments stay put until `docs:clean` or another test overwrites them.

````

**Step 2: Verify the Markdown renders sensibly**

Run: `grep -n "Documentation tests" README.md`
Expected: one match, at the new subsection location.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document doc-test pipeline in README"
````

---

## Task 8: End-to-end smoke test

Exercise the pipeline from a clean state to prove the `sp view` doc tests actually produce `docs/generated/commands/view.md`.

**Files:**

- None modified unless a regression surfaces.

**Step 1: Wipe prior state**

Run: `bun run docs:clean`
Expected: exit 0. `.test-tmp/doc-fragments/` and `docs/generated/` gone.

**Step 2: Run the full test suite**

Run: `bun run test:docker`
Expected: all tests pass. After the run, confirm fragments exist:

Run: `ls .test-tmp/doc-fragments/`
Expected: includes `commands__view--010.json` and `commands__view--020.json` (from `tests/commands/view.doc.test.ts`).

**Step 3: Build the docs**

Run: `bun run docs:build`
Expected: prints `Generated N doc files.` with N >= 1. `docs/generated/commands/view.md` now exists.

**Step 4: Inspect the output**

Run: `cat docs/generated/commands/view.md`
Expected: starts with `# view`, contains the prose from both view doc tests (`"View the current stack..."` and `"When you're on a branch with no commits..."`), and the captured command + output blocks.

If the file is missing content, or fragments didn't make it to disk, debug and fix before declaring the task done. Do not proceed until the pipeline produces real docs.

**Step 5: Final commit (only if fixes were needed)**

If Step 4 surfaced a bug and it got fixed, commit the fix:

```bash
git add <fixed files>
git commit -m "fix(docs-build): <describe the fix>"
```

Otherwise skip — the prior commits already stand on their own.

---

## Summary

After Tasks 1-8 the doc pipeline is live end-to-end:

- `tests/lib/doc-types.ts` holds pure types, importable from anywhere.
- `docTest()` writes each passing fragment to `.test-tmp/doc-fragments/<section>--<order>.json`.
- `scripts/build-docs.ts` reads that directory and calls the existing `assembleMarkdown()` to produce `docs/generated/<section>.md`.
- The in-memory fragment API is deleted; disk is the single source of truth.
- `bun run docs:clean` wipes both the fragment cache and generated docs.
- README documents the pipeline for future contributors.
- `sp view` produces real documentation, unblocking every subsequent doc test in Phase 2 feature ports.
