# Scriptable `sp group` — Design

**Date:** 2026-07-21
**Status:** Approved for planning

## Problem

`sp group` is interactive-only. It launches a TUI that blocks on a TTY, so
agents and the test suite cannot drive it — a backgrounded interactive command
hangs on closed stdin (see `AGENTS.md` → "Dogfooding `sp`"). `sp sync` and
`sp land` each have a non-interactive equivalent; `group` is the one true gap.

The rebuild roadmap deliberately dropped `main`'s non-interactive helpers
(`sp group --apply <json>`, `--fix`, `dissolve`) with an explicit invitation: if
they resurface, "redesign them rebuild-native against `refs/spry/groups` — do
not port `main`'s commands blindly" (`docs/rebuild-roadmap.md`). This is that
rebuild-native redesign.

## Goals

- A non-interactive, agent- and test-runnable way to create/edit/dissolve
  groups and (optionally) reorder commits.
- A machine-readable way to _read_ the current stack so callers can build the
  input.
- No silent destruction: any action that would reissue a commit id or close an
  open PR must be explicitly acknowledged in the input document.
- Stay within the rebuild's architecture boundaries: `sp group` remains
  offline/local (never calls `gh`); `sp sync` remains the only command that
  mutates PRs on GitHub.

## Non-goals

- Giving the interactive TUI these same powers (reissue, declarative PR-close
  intent). The TUI would eventually need to _walk the user through_ these
  questions; that is future work. **The `--apply` path is intentionally more
  feature-complete than the TUI at first**, specifically so we can dogfood it.
- Commit-ref resolution by SHA or subject. Members are Spry-Commit-Ids only.
- Human shell-scripting ergonomics. Primary consumers are agents and tests.

## Consumers

Agents (dogfooding PRs) and the test suite. Not optimized for hand-typing.

---

## Architecture overview

Two coordinated surfaces sharing one nested JSON schema:

- **Read:** `sp view --json` — dumps the current stack as a nested tree
  (commits and groups, in stack order), including per-unit PR state.
- **Write:** `sp group --apply <json>` — accepts a **desired final-state**
  document (string arg or `-` for stdin), reconciles it against the _live_
  stack, and applies it. Idempotent. No TTY required. Never calls `gh`.

The document round-trips: `sp view --json | edit | sp group --apply -`.

### Why this reuses existing seams

`groupCommand` today already does everything downstream of the TUI
non-interactively: PR-adoption resolution, `rewriteCommitChain`/`finalizeRewrite`,
`saveAllGroupRecords`, `pushGroupRecords`. The TUI's only job is producing a
`GroupEditorResult` (`{newOrder, updatedRecords}`) — see
`src/tui/group-state.ts:311` `extractResult`. So `--apply` is a **second
front-end that produces an equivalent result** and rejoins the existing tail.

---

## The shared JSON schema

One ordered array. Each element is a tagged object with a `type` discriminant.
Order is expressed by array position (top-level = stack order; within a group =
member order). Grouping is expressed by nesting.

### `sp view --json` output (fully described)

```jsonc
{
  "stack": [
    { "type": "commit", "id": "a1b2c3d4", "sha": "…", "subject": "feat: x",
      "pr": { "number": 12, "state": "OPEN" } },
    {
      "type": "group",
      "id": "e5f6a7b8",              // group identity == a member id when it holds that member's PR
      "title": "My feature",         // may be null (see title fallback)
      "pr": { "number": 15, "state": "OPEN" },
      "commits": [
        { "type": "commit", "id": "e5f6a7b8", "sha": "…", "subject": "feat: y" },
        { "type": "commit", "id": "c9d0e1f2", "sha": "…", "subject": "feat: z" }
      ]
    },
    { "type": "commit", "id": "b3c4d5e6", "sha": "…", "subject": "fix: w",
      "pr": null }
  ]
}
```

- Every unit (commit or group) surfaces its current PR state (`number`/`state`
  from the PR cache / `gh` enrichment, or `null`). This is what lets a caller
  see which reissues would close a PR _before_ writing the apply doc.
- `view --json` prints this instead of `formatStackView`; the tree/element
  types are shared with the apply parser in `src/parse/types.ts`.

### `sp group --apply` input

The **same tree**. Callers may omit the read-only fields that only appear on
output (`sha`, `subject`, and the output-shape `pr` state object). Required
structural/identity fields (`type`, `id`, group `commits`) must always be
present — omission is an error, never a silent default (see "omission ≠ null"
below). The document describes **desired final state**, not a diff, with the
single exception of `title` (PATCH-retain on omission).

```jsonc
{
  "stack": [
    { "type": "commit", "id": "a1b2c3d4" },
    { "type": "group", "id": "e5f6a7b8", "title": "My feature",
      "commits": [ { "type": "commit", "id": "e5f6a7b8" },
                   { "type": "commit", "id": "c9d0e1f2" } ] },
    { "type": "commit", "id": "b3c4d5e6" }
  ]
}
```

### Governing principle: omission ≠ null (PUT vs PATCH)

**For every field, an omitted key is NEVER coerced to `null`.** This is the
PUT-vs-PATCH distinction:

- **`null` (or a present value)** is always _intentional_ — the caller is
  declaring a specific outcome for that field.
- **Omission** is either a mistake or a deliberate "leave alone," and its
  meaning is the field's own identity-level default — which, for fields that
  govern identity or structure, is a **hard error**, not a silent default.

Per-field behavior on `--apply` input follows directly:

| Field             | present value           | `null`                 | omitted                  |
| ----------------- | ----------------------- | ---------------------- | ------------------------ |
| `type`            | `"commit"` / `"group"`  | — (error)              | **error** (required)     |
| `id`              | keep this identity      | **reissue** (new id)   | **error** (must declare) |
| `commits` (group) | member list (non-empty) | — (error)              | **error** (required)     |
| `title` (group)   | set to string           | **wipe** (clear title) | **retain** former title  |
| `pr`              | `"CLOSE"` directive     | — (error)              | **no closure intent**    |

Notes:

- **IDs are minted only by spry — the caller can never create one.** A real
  (non-`null`) `id` in the doc is a _reference_ to an id spry already knows
  about, never a _declaration_ of a new one. Any real `id` not present in the
  live stack is a **hard error** (see "Unknown id" in the taxonomy). The **only**
  way a new id comes into existence via `--apply` is `id: null` → spry mints it.
  (Users may still create ids out-of-band via `git rebase` trailer edits — that
  is their history — but `--apply` is deliberately **not** a sanctioned tool for
  minting or asserting ids.)
- **`id` omitted is a hard error** naming the unit. Every commit and group must
  declare its identity: a real Spry-Commit-Id (keep) or explicit `null`
  (reissue). Round-tripping `view --json` always emits ids, so this only catches
  hand-written docs that forgot. There is **no** "omit == reissue" shortcut.
- **`title` is the only PATCH-retain field** — omitted means "don't touch the
  stored title." Legitimate because a group always has a prior state to retain;
  a brand-new group with omitted title simply has no title (see fallback below),
  which is well-defined, not a coercion.
- **`pr` omitted = "I am not acknowledging any closure."** This is a real,
  non-`null` meaning (not a default coercion): it is exactly what makes the
  "would-close-an-open-PR without `pr:\"CLOSE\"`" check fire.
- On input, `title: ""` is treated the same as `title: null` (wipe). `""` is
  never a valid stored title.

**The `pr` field also has two distinct shapes by direction** (intentional; do
not unify): on `view --json` **output** it is a _state object_ (`{number, state}`
or `null`) describing the current PR; on `--apply` **input** it is a _directive_
— the only accepted value is the string literal `"CLOSE"`. Any other `pr` value
on input is a schema error.

---

## Core semantics

### Identity is the single PR-preservation mechanism

There is **no `adopt` field** and **no `idCustody` field**. PR fate follows
identity, uniformly for commits and groups:

- **Keep identity (`id: "<existing>"`)** → same id → same branch
  (`<prefix>/<id>`) → the open PR follows the unit. (inherit)
- **Reissue (`id: null`)** → spry mints a fresh id → new branch → the old
  identity's open PR becomes closeable. (reissue) — `null` only; an **omitted**
  `id` is a hard error, never a silent reissue (see "omission ≠ null" above).

A **group preserves a member's PR by setting the group's `id` to that member's
id** — the group then publishes on that member's branch and holds its PR. A
group id that equals one of _its own_ members' ids is therefore **legal and
expected**, not a duplicate-id collision.

### Reissue rewrites history (in scope, safe)

Reissuing an id (`id: null`) rewrites that commit's `Spry-Commit-Id` trailer — a
commit rewrite, like `injectMissingIds`. So a doc containing any `id: null`
triggers a chain rewrite **even with no reordering**. This is expected and safe;
the Phase 1 engine work (below) makes chain rewrites content-preserving.

### PR closure is acknowledged here, executed by `sp sync`

`sp group --apply` **never calls `gh`.** When an apply _would_ eventually close
an open PR (because a unit is reissued or its PR branch is otherwise
abandoned), the doc **must** carry `"pr": "CLOSE"` on that unit to acknowledge
the intent. `--apply` validates and persists that intent into local state
(`refs/spry/groups` + reissued ids); the **actual PR closure happens later on
`sp sync`**, which reconciles local state against the remote. This preserves
the bright line: `group` is offline/local, `sync` is the only PR mutator. It
also keeps the `--apply` core fully offline-testable (no cassettes).

### Group title: the PATCH-retain field

Under the governing "omission ≠ null" principle, `title` is the field whose
**omission means retain** (all others error or carry a specific meaning — see the
table above):

- **omitted** → **retain** the group's currently stored title (from
  `refs/spry/groups`). "Don't touch."
- **`null` or `""`** → **wipe** the stored title (clear it).
- **`"some title"`** → set it.

So the parser **must distinguish "key absent" from "key present with a
null/empty value"** — `parseApplyDoc` cannot model `title` as a plain optional
that defaults; it must track field _presence_ (e.g. a discriminated
`{ set: true, value } | { set: false }`). (This presence-tracking discipline is
required by the governing principle for _every_ field, not just `title` — it is
just most visible here because `title` has three live outcomes.)

When a group ends up with **no** stored title (wiped, or never set),
**PR-open time (in `sp sync`) falls back to the last member commit's title.**
The fallback lives in the sync/PR-open path that reads the group record;
`--apply` only stores (or clears) the title.

### Reorder is conflict-gated, never lossy, never dirty-guarded

The applied array's flattened commit order is the desired order. If it differs
from live, spry reorders via the **Phase 1 corrected engine** (diff-replay).
Reorder proceeds whenever the rewrite plan is **conflict-free**; it bails
(all-or-nothing, before any ref write) on conflict. There is **no dirty
-working-tree guard** — the rewrite is pure plumbing and a conflict-free
reorder's `finalizeRewrite` is a no-op on the working tree.

---

## Validation & error taxonomy (all fatal, checked before any write)

`--apply` is all-or-nothing: every check runs against the _live_ stack (via
`getStackCommits`) and the PR cache **before** any ref/record write or chain
rewrite.

### Schema / well-formedness (pure, no live state)

- Malformed JSON, unknown `type` → error.
- **Omitted required field is an error, distinct from a present `null`**
  (omission ≠ null): a missing `type`, a missing `id` on any unit, or a `group`
  with no `commits` key → error naming the unit. An omitted `id` is **never**
  coerced to reissue — reissue requires an explicit `id: null`.
- Empty group (`commits: []`) → error. (Dissolution is expressed by listing
  former members as ungrouped commits, never as an empty shell.)
- Duplicate **commit id** across two stack positions → error.
- Two **groups** with the same `id` → error.
- Group `id` equal to a commit id that is **not one of its own members**
  → error (foreign identity claim).
- Group `id` equal to **one of its own members' ids** → **legal**
  (PR preservation).
- `"pr": "CLOSE"` present on a unit where nothing would actually close → error.

### Reconciliation (doc vs. live stack)

- **Missing id** (a live stack commit the doc omits) → error listing the
  unaccounted ids. Strict completeness: the doc must account for every live
  commit. (Round-tripping `view --json` satisfies this naturally.)
- **Unknown id** — any real (non-`null`) `id` in the doc (commit id, member id,
  or group id) that is **not present in the live stack** → error naming the id.
  This is unconditional: it does not matter _why_ the id isn't live (dropped,
  squashed, typo, or a hand-authored value) — **the caller may never assert an
  id spry didn't mint.** New ids come only from `id: null` → spry mints. A group
  `id` that is a real value must be one of its own live members' ids
  (PR-preservation); otherwise it is either a foreign-identity error (a live but
  non-member id) or an unknown-id error (not live at all).
- **Split group** → structurally impossible under the nested schema (members
  are contiguous by construction; any live split is resolved by the reorder).
- **Reorder conflict** → bail, name the conflicting commit (from
  `rebasePlumbing` `ok:false`).
- **Would close an open PR without `"pr": "CLOSE"`** → error naming the unit
  and the PR that would close.

---

## Phase 1 (standalone, full TDD) — fix the reorder engine

**This is safety-critical, history-rewriting code and MUST land first, on its
own, with full red→green→refactor TDD.** Everything else depends on a correct
reorder.

### The bug (confirmed by code read)

`rewriteCommitChain` (`src/git/plumbing.ts:168-200`) reorders by reusing each
commit's **original snapshot tree** (`getTree(commit)`, line 178) while
re-parenting onto the reordered predecessor (lines 182-193). A git tree is a
whole-filesystem snapshot, not a diff. Reordering A→B→C to A→C→B yields a tip
whose tree = the moved commit's _original_ snapshot, **silently dropping other
commits' content** from the branch end-state, even though the commits still
exist in the chain.

The existing advisory `checkReorderConflicts` (`src/git/conflict.ts`) does **not**
protect against this — it returns "clean" for disjoint-file reorders, which is
exactly the guaranteed-loss case, and it does not gate the reorder anyway.

### The fix

Route `sp group`'s reorder through the **already-correct** diff-replay engine
`rebasePlumbing` (`src/git/plumbing.ts:208-243`), which replays each commit's
diff via `mergeTree` (three-way merge with the commit's original first-parent as
base). Concretely, at `src/commands/group.ts:120`, replace

```ts
rewriteCommitChain(ctx.git, result.newOrder, new Map(), { cwd, base: mergeBase })
```

with

```ts
rebasePlumbing(ctx.git, mergeBase, result.newOrder, { cwd })
```

branch on `result.ok` (bail with `conflictInfo` on false, mirroring
`src/commands/rebase.ts:76-100`), and call `finalizeRewrite` only on success.
This **eliminates the content-loss class entirely** — the tip is built from
diffs, so loss cannot be produced — and makes every remaining failure a genuine
merge conflict, reported before any ref is written.

### Detectability guarantee

The whole rewrite is a pure object-DB plan (`commit-tree`/`merge-tree`, no
ref/index/worktree writes) until `finalizeRewrite` is called separately by the
command. So a conflict is 100% detectable and bails before any ref write. This
is the property that lets `--apply` be all-or-nothing.

### Behavioral deltas to accept

1. Reorders that previously "succeeded" while silently corrupting will now
   correctly **fail as conflicts** when commits are genuinely interdependent.
   (This is a fix, not a regression.)
2. `rebasePlumbing` takes no `rewrites` message map; the reorder caller passes
   `new Map()` today, so it is feature-equivalent. (If message rewrite during
   reorder is ever needed, add a `rewrites` param to `rebasePlumbing`.)

### Tests (TDD)

- **Red:** a test that reorders a stack of commits touching disjoint files and
  asserts the final tree still contains **all** commits' content — fails against
  the current `rewriteCommitChain`-based reorder (proving the loss).
- **Green:** the same test passes once reorder routes through `rebasePlumbing`.
- Conflict case: reordering genuinely interdependent commits returns a conflict
  and writes **no** ref (branch tip unchanged; all-or-nothing).
- No-op reorder (order unchanged) leaves everything untouched.
- Refactor: keep the reorder helper small and single-purpose; ensure the
  interactive `sp group` reorder path uses the corrected engine too.

This phase repairs the interactive `sp group` reorder as a bonus, independent of
`--apply`.

---

## Phase 2 — shared schema + `sp view --json`

- Define the nested element/tree types in `src/parse/types.ts`
  (`commit` / `group` elements; `pr` info sub-shape).
- Add `--json` to the `view` command (`src/cli/index.ts`, `commander`) and a
  `--json` branch in `viewCommand` (`src/commands/view.ts`) that serializes the
  parsed + PR-cache-enriched stack into the tree and prints it instead of
  `formatStackView`.
- Tests: `tests/commands/view.doc.test.ts` covers `--json` output shape
  (offline; PR state comes from the cache).

---

## Phase 3 — `sp group --apply`

New pure module `src/parse/apply-doc.ts` (no git, fully unit-testable):

- `parseApplyDoc(json)` → schema validation → structured doc or typed schema
  error (all Schema/well-formedness errors above).
- `reconcile(doc, liveCommits, prCache, config)` → validates against the live
  stack + PR state (all Reconciliation errors above), resolves reissues and
  PR-close intents, and returns either a `GroupEditorResult`-equivalent
  (`updatedRecords` + optional `newOrder`) plus the set of ids to reissue and
  PRs to close, or a typed error.

`groupCommand` gains an `apply?: string` option:

- If set: read JSON (string, or `-` for stdin), run parse + reconcile; on error
  print + `process.exit(1)`; on success **skip the TUI and the interactive
  PR-adoption prompt** and feed the result into the existing reorder → save →
  push tail (using the Phase 1 corrected reorder). No TTY required. No `gh`
  calls.
- If unset: today's interactive path, untouched.

CLI: add `--apply <json>` to the `group` command in `src/cli/index.ts`.

### Tests

- Unit tests for `parseApplyDoc` + `reconcile` covering **every** error in the
  taxonomy (pure, offline).
- `tests/commands/group.doc.test.ts` (extend/add) drives the **real `sp`
  binary** non-interactively via stdin JSON (no TTY → agent-runnable):
  create group, dissolve (members ungrouped), reissue (`id: null`), reorder,
  group-holds-member-PR (id identity), and the `pr: "CLOSE"` acknowledgment
  path (verifying the intent is persisted locally; actual closure is a sync
  concern).
- Pure grouping/reorder/reissue stays fully offline (no cassettes). Any path
  that reads PR state uses the existing cache; `--apply` adds no `gh` calls, so
  no new cassettes are required for the core.

---

## Roadmap update

Amend `docs/rebuild-roadmap.md` → "`sp group` helper capabilities — dropped":
`--apply` is being **redesigned rebuild-native** — a declarative, nested
final-state document reconciled against `refs/spry/groups` and the live stack,
with identity-based PR preservation and explicit reissue/PR-close
acknowledgment — exactly as that section invited. `--fix` and explicit
`dissolve` remain dropped (dissolution is expressed declaratively by
ungrouping).

## Out-of-band discoveries (file as beads issues)

Captured in scratchpad `discoveries.md` (blocked on nook link in this worktree):

1. **`rebaseOntoTrunk` (`src/git/rebase.ts:155`) appears to be dead code**
   (chore, p3) — no production callers; `sp rebase` duplicates the logic inline.
2. **The reorder content-loss bug** (p1) — resolved by Phase 1 of this work;
   file for tracking/visibility.
