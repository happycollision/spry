# SHA & Spry-Commit-Id Registration Design

## Problem

Doc tests currently scrub commit SHAs at test time using a regex (`\b[0-9a-f]{7,8}\b`) and a
literal second pass for ANSI content. This has several failure modes:

- The second literal pass hits substrings inside longer strings (e.g. partial replacement of
  full 40-char SHAs)
- The `{7,8}` range misses git abbreviations of 9+ chars
- False matches on incidental 7–8 char hex strings in output
- ANSI-wrapped SHAs only caught if they appeared in plain text first (word-boundary mismatch)
- Mapping is order-dependent: encounter order during the test, not stable across runs

## Decision

**Move all SHA and Spry-Commit-Id replacement to build time.**

At test time: collect every SHA and Spry-Commit-Id from the test repos and store them in the
fragment JSON alongside the doc entries. Content is stored path-scrubbed but SHA-raw.

At build time: build a complete global mapping before touching any content, then apply it with
a streaming scanner that handles all abbreviation lengths correctly.

## Data Schema

`DocFragment` grows two optional fields:

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

Both fields are optional — fragments from tests that never call `doc.scrub(repo)` remain
valid without migration.

### Fake value pools

Two separate pools with visually distinct formats so abbreviated SHAs (7–8 chars) are never
confused with Spry-Commit-Ids (always 8 chars):

```ts
// Full 40-char fake SHAs — random-looking hex, no padding needed
const SHA_POOL = [
  "3f8a2c91d4e6b0f7a5c2e8d1b9f3a7c4e0d6b2f8",
  "b47e1d05c9f2a8e3d7b0c4f1e6a2d8b5c3f9e1a7",
  // ... 18 total
];

// 8-char fake Spry-Commit-Ids — obviously patterned, clearly not git SHAs
const SPRY_ID_POOL = [
  "aaaa1111", "bbbb2222", "cccc3333", "dddd4444",
  "eeee5555", "ffff6666", "aaaa7777", "bbbb8888",
  // ... 18 total
];
```

Abbreviated fake SHAs are prefixes of the pool entry: `SHA_POOL[0].slice(0, 7)` → `"3f8a2c9"`.
No build-time padding or seeding needed.

**Pool exhaustion throws** — no silent fallback:

```
Error: SHA_POOL exhausted — 19 unique SHAs registered but pool only has 18 entries.
Add more 40-char entries to SHA_POOL in tests/lib/doc.ts.
```

## Collection Logic (test time)

After `await fn(doc)` resolves, for each repo registered via `doc.scrub(repo)`, run in
parallel:

```
git log --all --format=%H          # all reachable SHAs, working clone
git reflog --format=%H             # dropped/rebased SHAs, working clone
git log --all --format=%B          # commit bodies for trailer extraction
git reflog --format=%B             # reflog bodies for trailer extraction
```

And for the bare origin (`repo.originPath`) using `--git-dir=<originPath>`:

```
git --git-dir=<originPath> log --all --format=%H
git --git-dir=<originPath> log --all --format=%B
git --git-dir=<originPath> reflog --format=%H   # no-op if bare has no reflog
git --git-dir=<originPath> reflog --format=%B
```

Bodies are scanned for `Spry-Commit-Id: <value>` with a simple regex — no shell-out to
`git interpret-trailers` needed since we're extracting a known-format trailer.

Results are deduplicated. Order is preserved as collected (log newest-first, then reflog).
This encounter order determines pool assignment at build time.

**Git command failures throw immediately** with the repo path and git error — no silent empty
lists that let real SHAs leak into docs.

The `scrub()` API stays synchronous. Collection runs inside `docTest`'s async wrapper after
`fn(doc)` completes, before the fragment is written. No API change for test authors.

## Build-time Replacement

`buildDocsFromDisk` gains a new phase before assembly.

### Phase 1 — Global map

Fragments are processed in filename sort order (section + order → deterministic). For each
fragment, walk its `shas` array then its `spryIds` array. First encounter of a value assigns
the next pool slot. Throw on exhaustion.

```ts
const shaMap = new Map<string, string>();   // real 40-char → fake 40-char
const spryMap = new Map<string, string>();  // real 8-char → fake 8-char
```

### Phase 2 — Streaming scanner

No regex alternation. No prefix map. A streaming character scanner:

1. Walk the content one char at a time
2. On a hex char, consume forward greedily up to 40 chars
3. For runs of ≥ 6 chars: check each registered SHA (longest match first, down to 6) —
   does any registered SHA start with this candidate?
4. On match: emit `fakeSha.slice(0, matchLen)`, advance by `matchLen`
5. On no match: emit the character, advance by 1

Same approach for Spry-Commit-Ids but exact-length (always 8 chars).

This correctly handles:

- Any abbreviation length (6–40)
- Consecutive SHAs with no separator
- ANSI escape sequences (scanner ignores non-hex chars — no word-boundary issues)
- Hex strings that are not registered SHAs (pass through unchanged)

### Phase 3 — Apply

Both scanners applied to every `content` and `ansiContent` in every entry, across all
fragments, before `assembleMarkdown` / `assembleHtml`.

The current two-pass ANSI hack in `applyScrub` is removed.

## Error Handling

| Situation                      | Behaviour                                                   |
| ------------------------------ | ----------------------------------------------------------- |
| Pool exhausted                 | Throw with count needed vs pool size and which file to edit |
| `git log` / `git reflog` fails | Throw with repo path and git stderr                         |
| Fragment has no `shas` field   | Skip SHA scrubbing for that fragment silently               |

## Testing Strategy

**The absolute first implementation step is writing unit tests for the streaming scanner**
(`tests/lib/sha-scanner.test.ts`) — before any collection or build-docs code is written.

Cases to cover:

- Correct replacement at every abbreviation length (6, 7, 8, 40)
- Multiple SHAs in one string with no separator
- Hex strings not in the registry pass through unchanged
- Spry-Commit-Id adjacent to a git SHA — each replaced from the right pool
- ANSI escape sequences wrapping a SHA
- Pool exhaustion throws with the right message
- Performance: multi-KB realistic terminal output (simulated TUI screen with many SHAs)

**Build-docs tests** (`scripts/build-docs.test.ts`):

- Fragment with `shas`/`spryIds` gets content scrubbed correctly
- Same SHA in two fragments gets the same fake value
- Fragment without `shas` passes through unchanged

**Integration**: `bun run test:docker` produces non-churning committed docs across runs.
