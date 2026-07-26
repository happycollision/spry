# `sp view`: mark commits/units changed since last sync

**Bead:** spry-ywa8
**Date:** 2026-07-26
**Status:** Design approved, pending spec review

## Problem

When dogfooding `sp`, there is no at-a-glance signal in `sp view` telling you
that a unit's local state has drifted from what is on the remote — i.e. "this
unit has been amended/reordered and its PR is now stale, so a `sp sync` is
needed." `sp view` is fully offline and today shows only the stack plus cached
PR status; it records nothing about "what was last synced" to diff against.

## Goal

Surface, per unit, two **independent** drift signals in `sp view` (both the
human-readable and `--json` outputs), computed entirely offline:

- **local-ahead** — you have amended/reordered this unit since you last pushed
  it. Answers "do _I_ need to run `sp sync`?"
- **remote-ahead** — the remote-tracking ref for this unit has moved since your
  push (as of your last fetch). Answers "did something/someone else change the
  remote?"

These are orthogonal: a unit may show neither, one, or both.

## Two orthogonal signals

Each unit carries up to two markers, rendered as independent glyphs so they
compose:

| Glyph | Color  | Name         | Condition                              | Meaning                                         |
| ----- | ------ | ------------ | -------------------------------------- | ----------------------------------------------- |
| `✎`   | yellow | local-ahead  | local tip SHA ≠ cached `syncedHeadSha` | you amended/reordered since your last push      |
| `↓`   | cyan   | remote-ahead | local tip SHA ≠ remote-tracking tip    | remote moved since your push (as of last fetch) |

A unit can therefore show: (nothing) / `✎` / `↓` / `✎↓` (diverged).

### Unknown-signal handling (no false positives)

Each signal is **suppressed** (treated as `false`) whenever its reference point
is unavailable:

- **local-ahead** is unknown if the unit has no PR-cache entry, or the entry
  predates this feature and has no `syncedHeadSha`. → no `✎`.
- **remote-ahead** is unknown if the remote-tracking ref
  `refs/remotes/<remote>/<prefix>/<id>` does not exist locally. → no `↓`.

Missing data never renders a marker. Old caches self-heal: `syncedHeadSha` is
written on the next `sp sync`.

### Offline / fetch honesty

`sp view` stays **fully offline** — it never fetches. The remote-ahead signal
therefore reflects the remote-tracking refs as of the **last fetch** (performed
by `sp rebase` / `sp sync`), not live remote state. This is worded explicitly in
the legend so it is not misleading. No `--fetch` flag in this iteration.

## Data model & write path

### PR cache (`src/gh/pr-cache.ts`)

Add one optional field to `PRCacheEntry`:

```ts
export interface PRCacheEntry extends PRInfo {
  branch: string;
  cachedAt: string; // ISO 8601
  syncedHeadSha?: string; // NEW: local tip SHA that sync last pushed for this unit
}
```

Optional ⇒ backward compatible. `loadPRCache` needs no change (`JSON.parse` of
an old blob simply yields `syncedHeadSha === undefined`).

### Write path (`src/commands/sync.ts`)

When `sp sync` writes/refreshes a unit's cache entry after pushing that unit,
set `syncedHeadSha` to the unit's local tip SHA (the commit sync just pushed).
This is the only new write. Units sync did not push in this run keep whatever
`syncedHeadSha` they already had (do not clear it).

### Remote-tracking read (offline helper)

A small offline helper resolves a unit's remote-tracking tip:

- input: unit id, `config.remote`, `config.branchPrefix`
- resolves `refs/remotes/<remote>/<prefix>/<id>` via `git rev-parse --verify`
- returns the SHA, or `undefined` if the ref is absent (never throws on absent)

Placement: near the existing branch/remote helpers (`src/git/branch.ts` or
`src/git/tracked-branches.ts` — pick whichever keeps imports cleanest; do not
create a new file if an existing one fits).

## Computation & rendering

### Pure classifier

A pure function computes per-unit drift from three offline inputs:

```ts
interface DriftInputs {
  localTip: string;            // unit's current local tip SHA
  syncedHeadSha?: string;      // from PR cache entry, may be undefined
  remoteTrackingTip?: string;  // from rev-parse, may be undefined
}
interface Drift {
  localAhead: boolean;   // localTip !== syncedHeadSha, only when syncedHeadSha known
  remoteAhead: boolean;  // localTip !== remoteTrackingTip, only when remoteTrackingTip known
}
```

Unknown reference ⇒ that boolean is `false`.

### Human output (`src/ui/format.ts`, `formatStackView`)

- Append the glyph(s) to the unit's line: `✎` for local-ahead, `↓` for
  remote-ahead, `✎↓` when both. Nothing when clean.
- Emit a legend line beneath the stack **only when at least one marker is shown
  anywhere in the stack**, so clean stacks render byte-identically to today:

  ```
  ✎ local edits, run sp sync   ↓ remote moved since your push (as of last fetch)
  ```

### JSON output (`--json`, `buildStackTree` / `EnrichedUnit`)

Expose two booleans on each unit: `localAhead` and `remoteAhead`. These appear
unconditionally (both `false` on clean units) so consumers get a stable schema.

## Testing

`tests/commands/view.doc.test.ts` (stays offline; no cassettes).

### One narrative doc fragment for the feature

A single doc test walks the full lifecycle in one story and emits **one** doc
fragment that explains the feature and every state:

1. clean (synced) — no markers, no legend
2. local-ahead — amend a unit after its `syncedHeadSha` was recorded → `✎`
3. remote-ahead — unit whose remote-tracking tip diverges from local → `↓`
4. diverged — both conditions on one unit → `✎↓`
5. unknown — cache entry lacking `syncedHeadSha` and/or missing tracking ref →
   no marker

### Mechanical assertions (no doc fragment)

Separate non-doc `test()` cases may assert each state's exact markers and the
`--json` `localAhead`/`remoteAhead` booleans, for tight coverage without
emitting extra fragments.

### Expected churn in existing view docs

Only fixtures whose units are in a non-clean state (or that now render the
legend) will change. Because clean units render no marker and the legend is
suppressed on a fully-clean stack, most existing view fragments stay
byte-identical. Any changed fragment must be inspected and confirmed to show the
**correct** new marker behavior before its expectation is updated — no blind
acceptance.

## Non-goals

- No `--fetch` flag / no network in `sp view` (deferred; revisit if the
  last-fetch staleness proves confusing).
- No change to `sp sync`'s push logic beyond recording `syncedHeadSha`.
- No new remote refs or schema beyond the single optional cache field.

## Files touched

- `src/gh/pr-cache.ts` — add optional `syncedHeadSha` to `PRCacheEntry`.
- `src/commands/sync.ts` — write `syncedHeadSha` on push.
- `src/git/branch.ts` or `src/git/tracked-branches.ts` — offline
  remote-tracking-tip resolver.
- `src/commands/view.ts` — gather the three offline inputs (local tip,
  `syncedHeadSha`, remote-tracking tip), run the classifier, and thread the
  resulting `Drift` per unit into the formatter and tree builder. Drift is
  computed here (not in `enrich.ts`), since it needs git reads view already has
  the context for. `EnrichedUnit` may gain optional drift fields only if that is
  the cleanest way to thread the data to `formatStackView` / `buildStackTree`.
- `src/ui/format.ts` — glyphs + conditional legend.
- `src/parse/stack-tree.ts` — `localAhead` / `remoteAhead` in `--json`.
- `tests/commands/view.doc.test.ts` — narrative fragment + mechanical cases.
