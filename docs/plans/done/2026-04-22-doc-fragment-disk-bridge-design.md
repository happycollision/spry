---
name: Doc fragment disk bridge
description: Persist docTest fragments to disk so bun run docs:build can actually read them
---

# Doc fragment disk bridge

> **Post-merge note:** This design treats `docs/generated/` as a gitignored build artifact. That policy was reversed in commit `8028525` — `docs/generated/` is now committed so PRs surface diffs in user-facing docs. `.test-tmp/` remains gitignored. README is the canonical source for current policy.

## Problem

`docTest()` in [tests/lib/doc.ts](../../tests/lib/doc.ts) collects fragments into a module-level in-memory array. [scripts/build-docs.ts](../../scripts/build-docs.ts) expects to read them back by importing `getDocFragments()` from the same module — but runs in a separate Bun process, so the array is always empty. Worse, `doc.ts` imports `bun:test` at module top level, so any non-test process that tries to import it crashes with `Run "bun test" to run a test`. The result: doc tests pass, their fragments evaporate when the test process exits, and `bun run docs:build` cannot produce output.

The gap was inherited from Task 12 of the test-first rebuild plan, which specified the in-process `getDocFragments()` approach despite the rebuild design explicitly calling for fragments to be "written to tmp during test, consumed by `bun run docs:build`". This design closes that gap.

## Decision

Split doc.ts into pure types plus runtime, have `docTest` write each passing fragment to a JSON file on disk, and rewrite `build-docs.ts` to read that directory. Use deterministic filenames so re-running a single test overwrites its own fragment without disturbing others (option B of the cleanup question). Add a `docs:clean` script as the escape hatch for stale fragments.

## Module layout

```
tests/lib/doc-types.ts      NEW. Type definitions only. No runtime imports.
tests/lib/doc.ts            Modified. Keeps docTest, writes to disk post-pass.
                            Drops collectFragment / getDocFragments / clearDocFragments.
scripts/build-docs.ts       Modified. Imports types from doc-types.ts.
                            Reads fragment JSONs from disk; no runtime import of tests/lib/.
```

`doc-types.ts` holds `DocEntry`, `DocFragment`, `DocContext`. No `bun:test` import, safe to pull into any tool or script.

## On-disk layout

```
.test-tmp/doc-fragments/
├── commands__view--010.json
├── commands__view--020.json
└── meta__smoke--001.json
```

- **Directory:** `.test-tmp/doc-fragments/` — matches the existing `.test-tmp/` convention (cassettes live in `.test-tmp/cassettes`). Already covered by `.gitignore`.
- **Filename:** `{section-with-slashes-escaped}--{order-zero-padded-to-3}.json`. Slashes in section paths become `__`. Zero-padded order so lexical sort equals numeric sort.
- **Payload:** full `DocFragment` JSON (`title`, `section`, `order`, `entries`).

Deterministic filenames give option-B semantics for free: re-running a test overwrites its own file; other tests' files persist.

## Write path

Inside `docTest`, after `fn(doc)` returns without throwing:

```ts
await Bun.write(fragmentPath(fragment), JSON.stringify(fragment, null, 2));
```

`fragmentPath` computes `.test-tmp/doc-fragments/<escaped-section>--<padded-order>.json` relative to the repo root. `mkdir -p` is called once per test run (idempotent, cheap). If the test throws, the write line never executes, preserving the "only passing tests produce docs" guarantee.

## Read path

`build-docs.ts` drops `import("../tests/lib/doc.ts")`. Replacement:

```ts
import { readdir } from "node:fs/promises";
import type { DocFragment } from "../tests/lib/doc-types.ts";

const files = await readdir(fragmentsDir);
const fragments: DocFragment[] = await Promise.all(
  files
    .filter((f) => f.endsWith(".json"))
    .map(async (f) => JSON.parse(await Bun.file(join(fragmentsDir, f)).text())),
);
```

Pass those into the existing `assembleMarkdown()`, which already works correctly and is unit-tested. `assembleMarkdown` is unchanged.

Empty-directory case: keep the existing `"No doc fragments collected. Run tests first."` message, updated to mention `bun test` explicitly.

## New `docs:clean` script

```json
"docs:clean": "rm -rf .test-tmp/doc-fragments docs/generated"
```

Escape hatch for stale fragments after renaming or deleting a doc test. Expected companion to option-B cleanup semantics.

## Migrating existing tests

- [tests/lib/doc.test.ts](../../tests/lib/doc.test.ts) currently asserts on the in-memory `collectFragment` / `getDocFragments` / `clearDocFragments` API. Rewrite to assert on disk-writing behavior: run a `docTest`, expect a specific JSON file at the expected path with expected contents. Uses a tmp fragments dir per test for isolation.
- [tests/lib/smoke.test.ts](../../tests/lib/smoke.test.ts) Pillar-4 assertion (`expect(getDocFragments()).toHaveLength(1)`) becomes an on-disk assertion.
- [tests/lib/index.ts](../../tests/lib/index.ts) removes the `collectFragment`, `getDocFragments`, `clearDocFragments` exports. `docTest` and types stay.

## Testing the disk bridge

[scripts/build-docs.test.ts](../../scripts/build-docs.test.ts) gains a test for the CLI entry point: given a fragments dir on disk populated with N JSON files, the script reads them, calls `assembleMarkdown`, and writes markdown to the expected output dir. Uses tmp input + output dirs.

## README update

Add a subsection under `## Development` titled **"Documentation tests"** that covers:

- What `docTest` is: tests that double as the source of user-facing docs.
- How to write one (brief, with a link to `tests/commands/view.doc.test.ts` as the canonical example).
- The pipeline: `bun test` populates `.test-tmp/doc-fragments/`, `bun run docs:build` assembles `docs/generated/*.md`, `bun run docs:clean` wipes both.
- That doc tests must pass to produce docs — a failing test writes no fragment.
- That `docs/generated/` and `.test-tmp/` are gitignored build artifacts, not sources of truth.

## Scope boundaries

Out of scope for this change:

- **No automatic `bun test && docs:build` chain.** Option B was chosen; the fast inner loop is the priority.
- **No fragment format versioning.** Path forward if needed: a `version` field in the JSON. YAGNI for now.
- **No concurrency guard** for two tests writing the same filename. Same-`{section, order}` pairs are already a semantic collision in the in-memory version (later overwrites earlier). Disk inherits the same behavior. Add detection later if it bites.
- `assembleMarkdown` and its existing unit test are not touched.
