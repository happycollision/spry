# Merge-aware PR units

Fixes **spry-phl7** (`sp land` readiness path not merge-aware) and **spry-w6qk**
(PR-body merge-note never wired into `sp sync`). Both are the deferred
end-to-end wiring for the merge-commit-groups feature; they share one root cause.

## Problem

A materialized merge group is a real merge commit in branch history that carries
**no `Spry-Commit-Id`** (a merge group is identified by its members, per
`MergeGroupRecord`) and has 2+ parents. When `sp land` / `sp sync` read the stack
via `getStackCommits` (the first-parent walk) and hand it to `detectPRUnits`
(`src/parse/stack.ts`), the merge commit falls into the plain `else` branch and
becomes a **degenerate PR unit**:

```
{ type: "single", id: mergeSha.slice(0,8), commitIds: [], commits: [mergeSha], subjects: [merge.subject] }
```

- **spry-phl7:** `commitIds: []` makes land's readiness check
  (`landBlockers` / `analyzeStack`) treat the unit as not-ready, so
  `sp land --through <merge-unit>` fails with
  `✗ Cannot land: the following units are not ready:` **before** ever reaching
  the `--merges` gate (`evaluateMergeGate`, step 3c of `performLand`). The gate
  can never be exercised end-to-end.
- **spry-w6qk:** the unit has no member context, and `sp sync` never passes a
  `mergeNote` to `buildInitialBody` (`sync.ts:614`) / `spliceBody`
  (`sync.ts:922`) anyway — so the `spry:merge-note` PR-body region (built and
  unit-tested in `src/gh/pr-body.ts`) never appears on a real PR.

The gate **logic** and the merge-note **rendering** are both correct and
unit-tested. What is missing is that the shared unit-detection does not model a
merge commit as a first-class landable/publishable PR unit.

## Fix

One modeling change, two payoffs.

### 1. `detectPRUnits` recognizes a merge commit

A commit with `parents.length >= 2` (or `mergeMembers` populated) becomes a
proper PR unit instead of a degenerate single:

| field          | value                                                                              |
| -------------- | ---------------------------------------------------------------------------------- |
| `type`         | `"single"` — a merge is exactly one PR (see decision below)                        |
| `id`           | its resolved **merge-group id** (stable ⇒ stable branch `<prefix>/<mgid>`)         |
| `commits`      | `[mergeSha]` — PR head = the merge commit; sync pushes the merge SHA               |
| `commitIds`    | the **member** ids (from the merge's members) — non-empty ⇒ land readiness passes  |
| `subjects`     | `[merge.subject]`                                                                  |
| `mergeMembers` | the member `CommitInfo`s — **present ⇒ this is a merge unit** (new optional field) |

`type` stays `"single"`: a merge is one PR, so every existing `unit.type`
consumer (land, sync, view) keeps treating it as a normal single unit. The only
new signal is `mergeMembers` being present, which only sync's merge-note pass
reads. (Decision: keep `single` + `mergeMembers` rather than a new
`type: "merge"` — no functional gain from a new variant, and a new variant would
force every `unit.type` switch across the codebase to grow a case.)

**Unrecorded merge fallback:** when a merge commit exists in history but no
`MergeGroupRecord` matches its members (hand-made merge, or records not yet
written), `id = mergeSha.slice(0,8)` (today's degenerate value) **but now with
member `commitIds`**, so it is still landable/publishable. It self-heals to the
stable merge-group id on the next `sp group`. Never blocks land/sync.

### 2. Thread merge context into unit detection

`detectPRUnits` is pure and operates on its input commit list + maps. Two inputs
must reach it:

- **Member commits.** `getStackCommits` populates `parents` but **not**
  `mergeMembers`. So `checkSync` (and the `--all` / branch variants) enrich each
  merge commit by calling `getMergeMembers` after `getStackCommits`, populating
  `mergeMembers` on the `CommitWithTrailers` before `parseStack`.
- **Merge-group map.** `checkSync` currently loads only group (PR) records. It
  additionally loads merge-group records (`loadMergeGroupRecords` →
  `buildCommitMergeGroupMap`) and passes the resulting `CommitMergeGroupMap` into
  `parseStack` → `detectPRUnits` so the merge-group id can be resolved from the
  members. `parseStack` gains an optional `mergeGroups` parameter (default `{}`),
  keeping every existing caller unchanged.

### 3. `sp sync` passes the merge-note

Where sync builds/splices a body and `unit.mergeMembers` is present, assemble
`MergeNote[]` (merge subject, member subjects newest-first, merge-parent subject)
and pass `mergeNote: generateMergeNote(...)` into `buildInitialBody`
(`sync.ts:614`) and `spliceBody` (`sync.ts:922`). For merge-free units
(`mergeMembers` absent) nothing changes — no note is passed, existing bodies stay
byte-identical, and the doc gate stays green.

## Non-goals (YAGNI)

- **No `view` change.** `sp view` already renders merges correctly via
  `getExpandedStackCommits`; its unit detection is unaffected because a merge-free
  stack hits none of the new branches.
- **No new `PRUnit.type`.** A merge is one PR; `mergeMembers` presence is the
  only signal needed.
- **No `parseStack` split-group change.** Merge members are contiguous by
  construction, so split-group detection is untouched.

## Testing (TDD)

- **`tests/parse/stack.test.ts`** — `detectPRUnits` over a first-parent list with
  a merge commit (members + merge-group map supplied) builds a unit with:
  `id === mergeGroupId`, `commits === [mergeSha]`, `commitIds === [memberIds]`,
  `mergeMembers` populated. Plus a regression: a **merge-free** stack's units are
  byte-identical to before (the new branch is inert).
- **`tests/commands/land.test.ts`** — end-to-end offline: a stack with a
  materialized merge in scope, pushed. Without `--merges` → the **gate** refusal
  (naming the merge + `--merges`), NOT "not ready". With `--merges` →
  `origin/main` fast-forwards to the merge tip.
- **`tests/commands/sync.test.ts`** — a merge unit's PR body contains the
  `spry:merge-note` region; a merge-free unit's body does not (byte-unchanged).
- **Doc tests (unblocks spry-jxqg.1):** `land.doc.test.ts` — the `--merges`
  story (refusal + acknowledged land); a sync doc test showing a rendered
  merge-note PR body.

## Risk

`detectPRUnits` is shared by `sp view`'s offline path and by land/sync. The new
merge branch is only reached when a commit has 2+ parents, which never happens in
today's (merge-free) linear stacks — so the change is inert for every existing
stack. The byte-identical regression assertion pins that.
