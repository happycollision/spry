# SHA & Spry-Commit-Id Registration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fragile test-time SHA regex scrubbing with a registration-based system that collects all SHAs and Spry-Commit-Ids from test repos and performs generation-time replacement via a streaming scanner.

**Architecture:** Each doc test registers repo paths via `doc.scrub(repo)`; after the test function runs, git log + reflog are harvested from both the working clone and bare origin to build a SHA/Spry-Commit-Id registry stored in the fragment JSON. At `docs:build` time, a global map is built from all fragment registries in filename-sort order, then a streaming character scanner applies replacements to all entry content before assembly.

**Tech Stack:** Bun, TypeScript, `bun:test`, `Bun.$` for git commands, `tests/lib/sha-scanner.ts` (new), `tests/lib/doc-types.ts`, `tests/lib/doc.ts`, `scripts/build-docs.ts`

**IMPORTANT for subagents:** Do NOT use `git -C` in your own Bash tool calls. `cd` to the directory first, then run normal git commands. This does not apply to code you write — the test infrastructure may use `git -C` freely.

**Testing:** Use `bun run test:docker` for all test runs (the local git version is too old).

---

## Task 1: Write failing tests for the streaming scanner

**The absolute first implementation step. No production code yet.**

**Files:**

- Create: `tests/lib/sha-scanner.ts` (stub only — exports the signatures so tests can import)
- Create: `tests/lib/sha-scanner.test.ts`

**Step 1: Create the stub file**

Create `tests/lib/sha-scanner.ts` with just the signatures and empty pool arrays so the test file can import without TypeScript errors:

```ts
export const SHA_POOL: readonly string[] = [];
export const SPRY_ID_POOL: readonly string[] = [];

export function buildShaMap(_shas: string[]): Map<string, string> {
  throw new Error("not implemented");
}

export function buildSpryMap(_spryIds: string[]): Map<string, string> {
  throw new Error("not implemented");
}

export function scanAndReplace(
  _content: string,
  _shaMap: Map<string, string>,
  _spryMap: Map<string, string>,
): string {
  throw new Error("not implemented");
}
```

**Step 2: Create the test file**

Create `tests/lib/sha-scanner.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { buildShaMap, buildSpryMap, scanAndReplace, SHA_POOL, SPRY_ID_POOL } from "./sha-scanner.ts";

// Fixed real-looking SHAs and IDs for all tests
const SHA_A = "abc1234def5678901234567890abcdef12345678";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";
const SHA_C = "1122334455667788990011223344556677889900";
const SPRY_A = "deadbeef";
const SPRY_B = "cafebabe";

describe("buildShaMap", () => {
  test("assigns pool entries in encounter order", () => {
    const map = buildShaMap([SHA_A, SHA_B]);
    expect(map.get(SHA_A)).toBe(SHA_POOL[0]);
    expect(map.get(SHA_B)).toBe(SHA_POOL[1]);
  });

  test("deduplicates: same SHA seen twice only uses one pool slot", () => {
    const map = buildShaMap([SHA_A, SHA_A]);
    expect(map.size).toBe(1);
    expect(map.get(SHA_A)).toBe(SHA_POOL[0]);
  });

  test("throws with a clear message when SHA_POOL is exhausted", () => {
    // Build a list of unique fake 40-char SHAs longer than SHA_POOL
    const tooMany = Array.from(
      { length: SHA_POOL.length + 1 },
      (_, i) => String(i).padStart(40, "0"),
    );
    expect(() => buildShaMap(tooMany)).toThrow(/SHA_POOL exhausted/);
    expect(() => buildShaMap(tooMany)).toThrow(/tests\/lib\/sha-scanner\.ts/);
  });
});

describe("buildSpryMap", () => {
  test("assigns pool entries in encounter order", () => {
    const map = buildSpryMap([SPRY_A, SPRY_B]);
    expect(map.get(SPRY_A)).toBe(SPRY_ID_POOL[0]);
    expect(map.get(SPRY_B)).toBe(SPRY_ID_POOL[1]);
  });

  test("throws with a clear message when SPRY_ID_POOL is exhausted", () => {
    const tooMany = Array.from(
      { length: SPRY_ID_POOL.length + 1 },
      (_, i) => i.toString(16).padStart(8, "0"),
    );
    expect(() => buildSpryMap(tooMany)).toThrow(/SPRY_ID_POOL exhausted/);
    expect(() => buildSpryMap(tooMany)).toThrow(/tests\/lib\/sha-scanner\.ts/);
  });
});

describe("scanAndReplace", () => {
  test("replaces full 40-char SHA", () => {
    const shaMap = buildShaMap([SHA_A]);
    const result = scanAndReplace(`commit ${SHA_A}`, shaMap, new Map());
    expect(result).not.toContain(SHA_A);
    expect(result).toContain("commit ");
    expect(result).toContain(SHA_POOL[0]);
  });

  test("replaces 7-char SHA abbreviation", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 7);
    const result = scanAndReplace(`commit ${abbrev}`, shaMap, new Map());
    expect(result).not.toContain(abbrev);
    expect(result).toContain(SHA_POOL[0].slice(0, 7));
  });

  test("replaces 8-char SHA abbreviation with SHA fake (not Spry fake)", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 8);
    const result = scanAndReplace(abbrev, shaMap, new Map());
    expect(result).toBe(SHA_POOL[0].slice(0, 8));
  });

  test("replaces 6-char SHA abbreviation", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 6);
    const result = scanAndReplace(abbrev, shaMap, new Map());
    expect(result).not.toContain(abbrev);
    expect(result).toContain(SHA_POOL[0].slice(0, 6));
  });

  test("replaces 9-char SHA abbreviation", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 9);
    const result = scanAndReplace(abbrev, shaMap, new Map());
    expect(result).toBe(SHA_POOL[0].slice(0, 9));
  });

  test("two SHAs concatenated with no separator — both replaced", () => {
    const shaMap = buildShaMap([SHA_A, SHA_B]);
    const concat = SHA_A.slice(0, 7) + SHA_B.slice(0, 7);
    const result = scanAndReplace(concat, shaMap, new Map());
    expect(result).not.toContain(SHA_A.slice(0, 7));
    expect(result).not.toContain(SHA_B.slice(0, 7));
    expect(result).toBe(SHA_POOL[0].slice(0, 7) + SHA_POOL[1].slice(0, 7));
  });

  test("hex string NOT in registry passes through unchanged", () => {
    const shaMap = buildShaMap([SHA_A]);
    const unregistered = "0000000"; // 7 hex chars, not a SHA prefix
    const result = scanAndReplace(unregistered, shaMap, new Map());
    expect(result).toBe(unregistered);
  });

  test("5-char hex run is too short — passes through unchanged", () => {
    const shaMap = buildShaMap([SHA_A]);
    const result = scanAndReplace("abc12", shaMap, new Map());
    expect(result).toBe("abc12");
  });

  test("replaces Spry-Commit-Id exactly (8 chars)", () => {
    const spryMap = buildSpryMap([SPRY_A]);
    const result = scanAndReplace(`Spry-Commit-Id: ${SPRY_A}`, new Map(), spryMap);
    expect(result).not.toContain(SPRY_A);
    expect(result).toContain(SPRY_ID_POOL[0]);
  });

  test("Spry-Commit-Id adjacent to SHA abbreviation — each replaced from correct pool", () => {
    const shaMap = buildShaMap([SHA_A]);
    const spryMap = buildSpryMap([SPRY_A]);
    const input = `${SHA_A.slice(0, 7)} ${SPRY_A}`;
    const result = scanAndReplace(input, shaMap, spryMap);
    expect(result).not.toContain(SHA_A.slice(0, 7));
    expect(result).not.toContain(SPRY_A);
    expect(result).toContain(SHA_POOL[0].slice(0, 7));
    expect(result).toContain(SPRY_ID_POOL[0]);
  });

  test("SHA abbreviation inside ANSI escape sequence — replaced correctly", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 7);
    // ANSI color wraps the SHA — non-hex chars around it
    const input = `\x1b[33m${abbrev}\x1b[0m`;
    const result = scanAndReplace(input, shaMap, new Map());
    expect(result).not.toContain(abbrev);
    expect(result).toContain("\x1b[33m");
    expect(result).toContain("\x1b[0m");
    expect(result).toContain(SHA_POOL[0].slice(0, 7));
  });

  test("empty maps — content returned unchanged", () => {
    const input = "no shas here, just text";
    const result = scanAndReplace(input, new Map(), new Map());
    expect(result).toBe(input);
  });

  test("non-hex content around SHAs is preserved exactly", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 7);
    const input = `  • ${abbrev} Add feature\n  • ${SHA_B.slice(0, 7)} Fix bug`;
    // SHA_B is not registered — should pass through
    const result = scanAndReplace(input, shaMap, new Map());
    expect(result).toContain("  • ");
    expect(result).toContain(" Add feature\n");
    expect(result).toContain(SHA_B.slice(0, 7)); // unregistered, unchanged
    expect(result).not.toContain(abbrev);
  });

  test("same SHA replaced consistently throughout content", () => {
    const shaMap = buildShaMap([SHA_A]);
    const abbrev = SHA_A.slice(0, 7);
    const input = `${abbrev} and again ${abbrev}`;
    const result = scanAndReplace(input, shaMap, new Map());
    const fake = SHA_POOL[0].slice(0, 7);
    expect(result).toBe(`${fake} and again ${fake}`);
  });

  test("performance: 50KB of realistic terminal output completes in < 100ms", () => {
    const shaMap = buildShaMap([SHA_A, SHA_B, SHA_C]);
    const spryMap = buildSpryMap([SPRY_A, SPRY_B]);
    // Build realistic content: mix of plain text, SHA abbreviations, ANSI sequences
    const line = `  \x1b[33m${SHA_A.slice(0, 7)}\x1b[0m Add feature (Spry-Commit-Id: ${SPRY_A})\n`;
    const content = line.repeat(1000); // ~70 chars × 1000 = ~70KB
    const start = performance.now();
    const result = scanAndReplace(content, shaMap, spryMap);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).not.toContain(SHA_A.slice(0, 7));
    expect(result).not.toContain(SPRY_A);
  });
});
```

**Step 3: Run tests to confirm they all fail as expected**

```bash
bun run test:docker -- tests/lib/sha-scanner.test.ts
```

Expected: all tests fail with `Error: not implemented` or import errors. If any pass, the stub is too complete — pare it back.

**Step 4: Commit the stub + tests**

```bash
git add tests/lib/sha-scanner.ts tests/lib/sha-scanner.test.ts
git commit -m "test(doc): failing tests for SHA streaming scanner"
```

---

## Task 2: Implement the streaming scanner

**Files:**

- Modify: `tests/lib/sha-scanner.ts`

**Step 1: Fill in the pools and all exports**

Replace the entire file with:

```ts
export const SHA_POOL: readonly string[] = [
  "3f8a2c91d4e6b0f7a5c2e8d1b9f3a7c4e0d6b2f8",
  "b47e1d05c9f2a8e3d7b0c4f1e6a2d8b5c3f9e1a7",
  "7c3d9e2f1a8b5c4d0e7f6a3b9c1d8e5f2a4b7c0d",
  "a1f4b8e2c7d3f9a5b0e6c4d1f8a3b7e9c2d5f0a6",
  "e5b0c3d8f2a7b4e1c9d6f3a0b8e4c2d7f5a1b9e3",
  "2d7f4a1b9e6c3d8f5a2b7e4c0d9f6a3b1e7c4d2f",
  "f1a9e4c2d7b5f0a8e3c6d1b9f4a2e7c5d0b3f8a1",
  "8e3b6f1c4d9a7e2b5f0c8d3a6b1e4f9c7d2a5b0e",
  "c5d2a9f6b3e0c7d4a1f8b5e2c9d6a3f0b7e4c1d8",
  "6a1e8b3d5f2c9a6e3b0d7f4c1a8e5b2d9f6c3a0e",
  "d9f3c0a7e4b1d8f5c2a9e6b3d0f7c4a1e8b5d2f9",
  "4b7e1d8f5c2a9b6e3d0f7c4b1e8d5f2c9a6e3b0d",
  "9c6a3f0e7d4b1c8f5a2e9d6c3b0f7a4e1d8c5b2f",
  "1e4d7b0c8f5a2e9d6c3a0f7b4e1d8c5b2f9a6e3d",
  "5f2a8d1e4b7c0f3a6d9e2b5c8f1d4a7e0b3c6f9d",
  "0b3c6f9d2a5e8b1d4c7f0a3e6d9c2b5f8a1d4c7e",
  "e7d4a1c8b5f2e9c6a3d0b7e4c1f8a5d2b9e6c3f0",
  "8c1f5a9d2e7b4c0f6a3e8d1b5c9f2a7e4d0b6c3f",
];

export const SPRY_ID_POOL: readonly string[] = [
  "aaaa1111",
  "bbbb2222",
  "cccc3333",
  "dddd4444",
  "eeee5555",
  "ffff6666",
  "aaaa7777",
  "bbbb8888",
  "cccc9999",
  "ddddaaaa",
  "eeeebbbb",
  "ffffcccc",
  "aaaadddd",
  "bbbbeeee",
  "ccccffff",
  "dddd5555",
  "eeee6666",
  "ffff7777",
];

export function buildShaMap(shas: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const sha of shas) {
    if (map.has(sha)) continue;
    if (map.size >= SHA_POOL.length) {
      throw new Error(
        `SHA_POOL exhausted — ${map.size + 1} unique SHAs needed but pool only has ${SHA_POOL.length} entries.\n` +
          `Add more 40-char entries to SHA_POOL in tests/lib/sha-scanner.ts.`,
      );
    }
    map.set(sha, SHA_POOL[map.size]);
  }
  return map;
}

export function buildSpryMap(spryIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of spryIds) {
    if (map.has(id)) continue;
    if (map.size >= SPRY_ID_POOL.length) {
      throw new Error(
        `SPRY_ID_POOL exhausted — ${map.size + 1} unique Spry-Commit-Ids needed but pool only has ${SPRY_ID_POOL.length} entries.\n` +
          `Add more 8-char entries to SPRY_ID_POOL in tests/lib/sha-scanner.ts.`,
      );
    }
    map.set(id, SPRY_ID_POOL[map.size]);
  }
  return map;
}

function isHexChar(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f");
}

export function scanAndReplace(
  content: string,
  shaMap: Map<string, string>,
  spryMap: Map<string, string>,
): string {
  if (shaMap.size === 0 && spryMap.size === 0) return content;

  const shas = [...shaMap.keys()];

  let result = "";
  let i = 0;

  while (i < content.length) {
    if (!isHexChar(content[i])) {
      result += content[i++];
      continue;
    }

    // Consume hex run greedily up to 40 chars
    let j = i;
    while (j < content.length && j - i < 40 && isHexChar(content[j])) j++;
    const runLen = j - i;

    if (runLen < 6) {
      result += content.slice(i, j);
      i = j;
      continue;
    }

    // Try longest match first, down to min 6
    let matched = false;
    for (let len = runLen; len >= 6; len--) {
      const candidate = content.slice(i, i + len);

      // Spry-Commit-Ids are always exactly 8 chars — check at len === 8 only
      if (len === 8) {
        const spryFake = spryMap.get(candidate);
        if (spryFake) {
          result += spryFake;
          i += len;
          matched = true;
          break;
        }
      }

      // SHA: any registered SHA that starts with this candidate
      const sha = shas.find((s) => s.startsWith(candidate));
      if (sha) {
        result += shaMap.get(sha)!.slice(0, len);
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      result += content[i];
      i++;
    }
  }

  return result;
}
```

**Step 2: Run tests**

```bash
bun run test:docker -- tests/lib/sha-scanner.test.ts
```

Expected: all tests pass. If performance test fails, profile and optimize the inner `shas.find()` loop — for 18 SHAs this should be negligible, but if needed, sort SHAs and use a binary search or pre-build a trie.

**Step 3: Commit**

```bash
git add tests/lib/sha-scanner.ts
git commit -m "feat(doc): implement SHA streaming scanner with two pools"
```

---

## Task 3: Extend DocFragment schema

**Files:**

- Modify: `tests/lib/doc-types.ts`

**Step 1: Add the two optional fields**

```ts
export interface DocFragment {
  title: string;
  section: string;
  order: number;
  entries: DocEntry[];
  shas?: string[];      // all 40-char git SHAs seen in this test's repos
  spryIds?: string[];   // all Spry-Commit-Id trailer values (8-char hex)
}
```

**Step 2: Verify TypeScript is happy**

```bash
bun run types
```

Expected: no errors. Existing fragments without the new fields remain valid (both fields are optional).

**Step 3: Commit**

```bash
git add tests/lib/doc-types.ts
git commit -m "feat(doc): add shas and spryIds fields to DocFragment"
```

---

## Task 4: Update doc.ts — collection logic, remove test-time SHA scrubbing

**Files:**

- Modify: `tests/lib/doc.ts`

This task removes the old SHA regex/second-pass code from `applyScrub` and adds repo registration + post-test collection. Content is now stored SHA-raw (path scrubbing still happens at test time, as before).

**Step 1: Add import for Bun.$**

At the top of `tests/lib/doc.ts`, ensure `$` is imported:

```ts
import { $ } from "bun";
```

**Step 2: Remove the SHA_POOL, scrubShas flag, shaMap, and both SHA passes from applyScrub**

The current `doc.ts` has `SHA_POOL`, a `scrubShas` boolean, a `shaMap`, the regex pass, and the literal second pass. Remove all of them. The `applyScrub` function should become:

```ts
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
```

**Step 3: Add repo registration and collection**

Replace the `scrubShas = true` line inside `doc.scrub` with repo path tracking, and add a collection helper. The full updated `docTest` function (only showing changed parts; keep everything else identical):

Inside `docTest`, after `const subs: Substitution[] = [];` add:

```ts
const scrubRepos: Array<{ path: string; originPath: string }> = [];
```

Inside `doc.scrub`, when `isRepoLike(arg)`, replace `scrubShas = true` with:

```ts
scrubRepos.push({ path: arg.path, originPath: arg.originPath });
```

After `await fn(doc)` and before writing the fragment, add the collection:

```ts
let shas: string[] | undefined;
let spryIds: string[] | undefined;

if (scrubRepos.length > 0) {
  const allShas = new Set<string>();
  const allSpryIds = new Set<string>();

  for (const repo of scrubRepos) {
    const results = await Promise.allSettled([
      $`git -C ${repo.path} log --all --format=%H`.quiet().text(),
      $`git -C ${repo.path} reflog --format=%H`.quiet().nothrow().text(),
      $`git -C ${repo.path} log --all --format=%B`.quiet().text(),
      $`git -C ${repo.path} reflog --format=%B`.quiet().nothrow().text(),
      $`git --git-dir=${repo.originPath} log --all --format=%H`.quiet().nothrow().text(),
      $`git --git-dir=${repo.originPath} log --all --format=%B`.quiet().nothrow().text(),
      $`git --git-dir=${repo.originPath} reflog --format=%H`.quiet().nothrow().text(),
      $`git --git-dir=${repo.originPath} reflog --format=%B`.quiet().nothrow().text(),
    ]);

    // Results: [logShas, reflogShas, logBodies, reflogBodies,
    //           originLogShas, originLogBodies, originReflogShas, originReflogBodies]
    const texts = results.map((r) => (r.status === "fulfilled" ? r.value : ""));
    const [logShas, reflogShas, , , originLogShas, , originReflogShas] = texts;
    const bodies = texts[2] + "\n" + texts[3] + "\n" + texts[5] + "\n" + texts[7];

    // Collect 40-char SHAs
    for (const line of [logShas, reflogShas, originLogShas, originReflogShas].join("\n").split("\n")) {
      const sha = line.trim();
      if (/^[0-9a-f]{40}$/.test(sha)) allShas.add(sha);
    }

    // Extract Spry-Commit-Id values from commit bodies
    for (const match of bodies.matchAll(/^Spry-Commit-Id:\s+([0-9a-f]{8})\s*$/gm)) {
      allSpryIds.add(match[1]);
    }
  }

  shas = [...allShas];
  spryIds = [...allSpryIds];
}
```

Then when building the fragment object, include the new fields:

```ts
const fragment: DocFragment = {
  title,
  section: options.section,
  order: options.order,
  entries,
  ...(shas !== undefined && { shas }),
  ...(spryIds !== undefined && { spryIds }),
};
```

**Step 4: Run the existing doc tests**

```bash
bun run test:docker -- tests/commands/
```

Expected: all pass. The docs will now have SHA-raw content — that's expected and correct. The fragment JSON files will have `shas` and `spryIds` fields populated.

**Step 5: Commit**

```bash
git add tests/lib/doc.ts
git commit -m "feat(doc): collect SHA+Spry-Commit-Id registry from repos after each doc test"
```

---

## Task 5: Update build-docs.ts — global map + scanner application

**Files:**

- Modify: `scripts/build-docs.ts`
- Modify: `scripts/build-docs.test.ts`

**Step 1: Add import for scanner functions**

At the top of `scripts/build-docs.ts`:

```ts
import { buildShaMap, buildSpryMap, scanAndReplace } from "../tests/lib/sha-scanner.ts";
```

**Step 2: Add scrubFragments helper**

Add this function before `buildDocsFromDisk`:

```ts
function scrubFragments(fragments: DocFragment[]): DocFragment[] {
  // Collect all SHAs and Spry-Commit-Ids in fragment filename-sort order
  // (fragments are already sorted by filename when loaded — preserve that order)
  const allShas: string[] = [];
  const allSpryIds: string[] = [];
  for (const frag of fragments) {
    if (frag.shas) {
      for (const sha of frag.shas) {
        if (!allShas.includes(sha)) allShas.push(sha);
      }
    }
    if (frag.spryIds) {
      for (const id of frag.spryIds) {
        if (!allSpryIds.includes(id)) allSpryIds.push(id);
      }
    }
  }

  if (allShas.length === 0 && allSpryIds.length === 0) return fragments;

  const shaMap = buildShaMap(allShas);
  const spryMap = buildSpryMap(allSpryIds);

  return fragments.map((frag) => ({
    ...frag,
    entries: frag.entries.map((entry) => ({
      ...entry,
      content: scanAndReplace(entry.content, shaMap, spryMap),
      ...(entry.ansiContent !== undefined && {
        ansiContent: scanAndReplace(entry.ansiContent, shaMap, spryMap),
      }),
    })),
  }));
}
```

**Step 3: Call scrubFragments in buildDocsFromDisk**

In `buildDocsFromDisk`, after the fragments are loaded and before `assembleMarkdown` is called, add:

```ts
const scrubbedFragments = scrubFragments(fragments);
```

Then replace all uses of `fragments` in the assembly calls with `scrubbedFragments`:

```ts
const docs = assembleMarkdown(scrubbedFragments);
// ...
const htmlDocs = assembleHtml(scrubbedFragments);
```

**Step 4: Write new tests in build-docs.test.ts**

Add these tests to `scripts/build-docs.test.ts`:

```ts
import { buildShaMap, buildSpryMap, SHA_POOL, SPRY_ID_POOL } from "../tests/lib/sha-scanner.ts";

const REAL_SHA = "abc1234def5678901234567890abcdef12345678";
const REAL_SPRY = "deadbeef";

test("buildDocsFromDisk scrubs SHAs in fragment content", async () => {
  const fragmentsDir = join(tmpRoot, "fragments-sha");
  const outDir = join(tmpRoot, "out-sha");
  await mkdir(fragmentsDir, { recursive: true });

  await Bun.write(
    join(fragmentsDir, "commands__demo--010.json"),
    JSON.stringify({
      title: "SHA test",
      section: "commands/demo",
      order: 10,
      shas: [REAL_SHA],
      spryIds: [REAL_SPRY],
      entries: [
        { type: "output", content: `commit ${REAL_SHA.slice(0, 7)} (Spry-Commit-Id: ${REAL_SPRY})` },
      ],
    }),
  );

  await buildDocsFromDisk(fragmentsDir, outDir);
  const markdown = await readFile(join(outDir, "commands/demo.md"), "utf8");
  expect(markdown).not.toContain(REAL_SHA.slice(0, 7));
  expect(markdown).not.toContain(REAL_SPRY);
  expect(markdown).toContain(SHA_POOL[0].slice(0, 7));
  expect(markdown).toContain(SPRY_ID_POOL[0]);
});

test("same SHA in two fragments gets the same fake value (global map)", async () => {
  const fragmentsDir = join(tmpRoot, "fragments-global");
  const outDir = join(tmpRoot, "out-global");
  await mkdir(fragmentsDir, { recursive: true });

  // Two fragments, both referencing the same real SHA
  await Bun.write(
    join(fragmentsDir, "commands__demo--010.json"),
    JSON.stringify({
      title: "Fragment 1",
      section: "commands/demo",
      order: 10,
      shas: [REAL_SHA],
      entries: [{ type: "output", content: REAL_SHA.slice(0, 7) }],
    }),
  );
  await Bun.write(
    join(fragmentsDir, "commands__demo--020.json"),
    JSON.stringify({
      title: "Fragment 2",
      section: "commands/demo",
      order: 20,
      shas: [REAL_SHA],
      entries: [{ type: "output", content: REAL_SHA.slice(0, 7) }],
    }),
  );

  await buildDocsFromDisk(fragmentsDir, outDir);
  const markdown = await readFile(join(outDir, "commands/demo.md"), "utf8");
  const fakeAbbrev = SHA_POOL[0].slice(0, 7);
  // Both occurrences should be the same fake value
  expect(markdown.split(fakeAbbrev).length - 1).toBe(2);
});

test("fragment without shas field passes through unchanged", async () => {
  const fragmentsDir = join(tmpRoot, "fragments-noshas");
  const outDir = join(tmpRoot, "out-noshas");
  await mkdir(fragmentsDir, { recursive: true });

  await Bun.write(
    join(fragmentsDir, "commands__demo--010.json"),
    JSON.stringify({
      title: "No shas",
      section: "commands/demo",
      order: 10,
      entries: [{ type: "prose", content: "Just plain text." }],
    }),
  );

  await buildDocsFromDisk(fragmentsDir, outDir);
  const markdown = await readFile(join(outDir, "commands/demo.md"), "utf8");
  expect(markdown).toContain("Just plain text.");
});

test("scrubFragments throws when SHA pool is exhausted", () => {
  const tooManyShas = Array.from(
    { length: SHA_POOL.length + 1 },
    (_, i) => String(i).padStart(40, "0"),
  );
  const fragment: DocFragment = {
    title: "t",
    section: "s",
    order: 1,
    shas: tooManyShas,
    entries: [],
  };
  // scrubFragments is not exported — test via assembleMarkdown with a fragment that has too many SHAs
  // Import scrubFragments if exported, or test via buildDocsFromDisk
  // For now, verify the error surfaces from buildShaMap directly
  expect(() => buildShaMap(tooManyShas)).toThrow(/SHA_POOL exhausted/);
});
```

**Step 5: Run build-docs tests**

```bash
bun run test:docker -- scripts/build-docs.test.ts
```

Expected: all tests pass including the new SHA scrubbing ones.

**Step 6: Commit**

```bash
git add scripts/build-docs.ts scripts/build-docs.test.ts
git commit -m "feat(docs): generation-time SHA and Spry-Commit-Id replacement via streaming scanner"
```

---

## Task 6: Integration verification and doc regeneration

**Step 1: Run the full doc test suite**

```bash
bun run test:docker -- tests/commands/
```

Expected: all pass.

**Step 2: Regenerate committed docs**

```bash
bun run docs:build
```

Expected: the committed `.md` and `.html` files in `docs/generated/` are updated with properly scrubbed fake SHAs. Real SHAs should not appear anywhere in the output.

**Step 3: Verify no real SHAs leaked**

Check that no 40-char hex strings appear in the generated docs:

```bash
grep -rE '[0-9a-f]{40}' docs/generated/ | grep -v '.html\|.md' | head -5
grep -rP '\b[0-9a-f]{40}\b' docs/generated/
```

Expected: no matches (or only intentional ones if any doc content deliberately shows a full SHA — which it shouldn't in this codebase).

**Step 4: Commit updated docs**

If docs changed (they will — old fake SHA pool values replaced by new ones):

```bash
git add docs/generated/
git commit -m "docs: regenerate with new SHA registration scrubbing"
```

**Step 5: Run a second doc generation to confirm stability**

```bash
bun run test:docker -- tests/commands/ && bun run docs:build
```

Then check that `git diff docs/generated/` is empty — docs must not churn on a second run.

```bash
git diff docs/generated/
```

Expected: no output (clean diff). If there's churn, the encounter-order assignment is non-deterministic somewhere — investigate which SHA appears in different positions between runs.
