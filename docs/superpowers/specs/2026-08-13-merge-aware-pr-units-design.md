# Merge-aware PR units (v2 — shared read model)

Fixes **spry-phl7** (`sp land` not merge-aware), **spry-w6qk** (PR-body
merge-note never wired into `sp sync`), and **spry-1574.8** (a materialized
merge nested in a PR group breaks the read path). Supersedes the v1 approach in
this file's history, which synthesized a standalone merge PR unit from the
first-parent list — the wrong layer (see "Why v1 was wrong").

## Status (branch `claude/beads-low-hanging-fruit-b29020`, as of 2026-08-14)

Where this branch stands and what remains, so work can resume cleanly.

**Shipped and merged into this branch (the merge-commit-groups feature, PRs
#46, #51–#61 — the 8 plumbing steps + TUI + idempotence fix + doc tests):**

- Storage: `MergeGroupRecord` + `refs/spry/merge-groups` (load/save/fetch/push,
  `buildCommitMergeGroupMap`).
- Merge-aware stack walk: `getStackCommits` (first-parent) captures `%P` parents;
  `getMergeMembers` / `getExpandedStackCommits` expand a merge's side branch.
- `buildStackModel` / `flattenStackModel` (merge-aware node model + flatten).
- `materialize` plumbing (re-root members onto the merge parent, pinned merge
  identity/date so an unchanged group yields the identical merge SHA).
- `sp group --apply` accepts a nested `merge` node; `sp group` TUI can create/edit
  merge groups; re-applying an unchanged materialized merge is a history no-op.
- `sp view` / `--json` render the merge (the `⑃` marker / nested merge nodes).
- `sp rebase` preserves materialized merges across a trunk move
  (`rebaseStackWithMerges`).
- `sp land --merges` **gate logic** (`evaluateMergeGate` / `mergeCommitsInRange`)
  and the PR-body **merge-note renderer** (`generateMergeNote`) both exist and are
  unit-tested — but see "Not yet wired" below.
- Doc/story tests for the two reachable human-facing surfaces (`sp group --apply`
  merge node; `sp view` merge rendering).
- Branch history was rebased onto `main` and squashed (docs commits collapsed;
  the spry-6yku shared-plumbing fixes folded into the materialize step).

**Not yet wired end-to-end (the work THIS spec covers):** three defects, one root
cause — `sp land` / `sp sync` read the stack in a way that does not model a
materialized merge as part of a PR unit. `spry-phl7` (land not merge-aware),
`spry-w6qk` (sync never passes the merge-note), and `spry-1574.8` (a merge nested
in a PR group breaks the read path with a false "non-contiguous group" error,
**reproduced live** via the real `group` command). The fix is the shared read
model below.

**In-progress implementation state (epic `spry-1574`):** Task 1 (`PRUnit`
`mergeMembers` field) and a first, WRONG-LAYER attempt at Task 2/3 landed as
commits `3d98b0d`, `c8c4095`, `4dc4b3f`, `41adadf`. The v1 approach
(`detectPRUnits` synthesizing a standalone merge PR unit from the first-parent
list) is being **reverted** — it mis-modeled a merge nested in a PR group and
duplicated the merge concept against `buildStackModel`. The kept-valid piece is
`analyzeStack` ignoring a merge commit's own missing id (still needed). This v2
spec is the corrected design; the implementation plan
(`docs/superpowers/plans/2026-08-13-merge-aware-pr-units.md`) must be rewritten to
match it before resuming.

**Two settled decisions captured in this spec (user direction):** (1) extract the
merge-aware read/validation into a **shared module** the other commands call
rather than re-implementing per command — `group` already owns validation; (2)
`sp land` must **never land partway into a merge group** — the picker offers land
points only at merge nodes, and `sp land --through <member-id>` inside a merge is
a hard reject (§E).

**One open modeling question still to settle before the plan** — see "Open
question for review" below (how a PR unit carries its internal merge(s): a
`merges?: {mergeSha, members}[]` list vs the single `mergeMembers?` field).

## Principle: materialize is `group`'s job; everyone else is merge-aware

`sp group` is the ONLY command that materializes a merge group (turns the record
in `refs/spry/merge-groups` into a real 2-parent merge commit, via
`src/git/materialize.ts`). Every other command only READS a merge that already
exists in history:

- **`view`** — renders it (the `⑃` marker). Already correct.
- **`land`** — validates it, gates on `--merges`, ff-pushes it. Never rewrites.
- **`sync`** — pushes the branch as-is, writes the PR-body merge-note. Never rewrites.
- **`rebase`** — the only other rewriter, and only to RETAIN merges across a
  trunk move (`rebaseStackWithMerges` ≈ `git rebase --rebase-merges`). Preserves,
  never creates.

The other commands must not re-implement merge/group validation. `group` already
owns it; the read model below is the shared surface they all consume.

## The problem, precisely

A materialized merge is a real merge commit on the first-parent line, with its
member commits on a second-parent side branch:

```
first-parent line:  … → A → M(merge) → D → …      (M has 2 parents)
side branch of M:            B → C                 (the members)
```

`M` carries no `Spry-Commit-Id` (a merge group is identified by its members). Two
distinct reads exist today:

- **First-parent** (`getStackCommits`): sees `[A, M, D]`. Correct tips for
  pushing (M is the branch-line commit), but M has no id and its members are
  hidden.
- **Expanded** (`getExpandedStackCommits`): replaces M with its members →
  `[A, B, C, D]`. This is what `group`/`view` read; PR-group `{A,B,C,D}` is
  contiguous here, so `parseStack` is happy.

`sp land`/`sp sync` read the **first-parent** stack through `checkSync` and hand
it to `parseStack`. Consequences:

1. **spry-1574.8 (merge in a PR group):** group record says members `{A,B,C,D}`,
   but the first-parent list is `[A, M, D]` — B,C are on the side branch. So
   `parseStack`'s split-group prescan sees group positions `{0 (A), 2 (D)}` with M
   at position 1 unattributed → **"Group has non-contiguous commits"** error,
   blocking view/land/sync. (Reproduced live via the real `group` command.)
2. **spry-phl7 (land a top-level merge):** M becomes a degenerate unit
   (`commitIds: []`, id = M's SHA prefix); land's readiness rejects it before the
   `--merges` gate.
3. **spry-w6qk:** even if a merge unit formed, sync never passes a `mergeNote`.

## Why v1 was wrong

v1 made `detectPRUnits` synthesize a standalone merge PR unit from the
first-parent list. That mis-modeled a merge nested in a PR group (the merge is
INTERNAL to the group's one PR, not its own unit) and forced a second
representation of "a merge" alongside the existing `buildStackModel` node model.
Reverted (was commits `c8c4095` + `4dc4b3f`).

## Fix: one shared merge-aware unit builder, on the first-parent list

Keep land/sync reading the **first-parent** stack (so push tips are the real
branch-line commits). Make the shared parse layer merge-group-aware so a merge
commit carries its members' PR-group membership:

### A. A merge commit is attributed to its members' PR group

New shared helper (pure, in `src/parse/stack.ts`):

```
mergeCommitPRGroup(mergeCommit, commitGroups): string | undefined
  = the PR-group id that the merge's members agree on (via each member's
    Spry-Commit-Id → commitGroups), or undefined if the members are ungrouped.
```

The merge's members come from `mergeCommit.mergeMembers` (populated by the caller
— see §D). This is the single source of "which PR group, if any, a merge belongs
to," used by both the split-group prescan and unit detection.

### B. `parseStack` split-group prescan counts a merge as its group's member

In the prescan that records per-group positions on the first-parent list, a merge
commit at position `i` whose `mergeCommitPRGroup` is `g` contributes position `i`
to group `g`. So `[A, M, D]` with group `{A,B,C,D}` yields positions `{0,1,2}` —
contiguous. No false split-group error. (A plain interrupting commit still
splits, exactly as before.)

### C. `detectPRUnits` builds ONE unit per PR, merge absorbed

Walking the first-parent list with the merge-group map:

- **Merge in a PR group** → absorbed into that group's unit. The group unit's
  `commits` includes the merge SHA in first-parent order (`[A, M, D]`); its
  `commitIds` are the group's real commit ids from `refs/spry/groups`
  (`[A,B,C,D]`); a new `mergeMembers?` on the unit (or a per-unit merge list —
  see open question) records which of its commits are merges and their members,
  for the note + gate. One PR, merge internal.
- **Top-level (ungrouped) merge** → its own `type: "single"` unit: `commits:
[M]`, `commitIds` = member ids, id = merge-group id (from
  `refs/spry/merge-groups`, stable) or M's SHA prefix if unrecorded,
  `mergeMembers` set. This is the case spry-phl7's `sp land --merges` exercises.

A merge-free stack hits none of these branches → byte-identical to today.

### D. `checkSync` supplies the inputs (like `view` already does)

`checkSync` (and the `--all`/branch variants) must, before `parseStack`:

1. Preserve `parents`/`mergeMembers` through `parseCommitTrailers` (it currently
   drops them — a required precursor fix).
2. Enrich each first-parent merge commit with its members via `getMergeMembers`.
3. Load `refs/spry/merge-groups` → `buildCommitMergeGroupMap` and pass the map to
   `parseStack` (the same `loadMergeGroupRecords`/`buildCommitMergeGroupMap`
   `view`/`group` already call).

### E. `sp land` never lands partway into a merge (user requirement)

- **Picker:** the bare/interactive land picker offers land points only at merge
  NODES and plain commits — never a commit that is a member INSIDE a merge group.
  A merge's interior members are not selectable land targets.
- **By-id reject:** `sp land --through <id>` where `<id>` resolves to a commit
  inside a merge group is a hard error naming the merge (e.g. `✗ <id> is inside
merge group <mg>; land the whole merge or choose another land point`). A merge
  lands atomically. This check uses the shared merge model (§A), so land does not
  re-derive membership.

### F. `sp land --merges` gate + `sp sync` merge-note

- The `--merges` gate (`evaluateMergeGate` + `mergeCommitsInRange`) already
  exists and is correct; with §C making a merge a real, landable unit, land now
  reaches it. `analyzeStack`'s missing-id check must ignore a merge commit's own
  SHA (a merge carries no id) — a merge SHA in a unit's `commits` is not "missing
  an id." (This is the kept, still-valid piece of the old Task 3.)
- `sp sync` builds `MergeNote[]` from a unit's merge members and passes
  `mergeNote: generateMergeNote(...)` into `buildInitialBody`/`spliceBody`.
  Omitted (byte-unchanged) when a unit has no merges.

## Shared module

Extract the merge-aware read model into a shared home under `src/parse/` (it is
pure). It exposes: `mergeCommitPRGroup`, the merge-aware `detectPRUnits`/
`parseStack` (already in `src/parse/stack.ts`), and a boundary predicate land
uses — e.g. `isInsideMergeGroup(commitId, mergeGroups): boolean` and
`landPointsFor(units/model)` returning the selectable land targets (merge nodes +
plain commits, never merge interiors). `group`, `view`, `land`, `sync` all import
these; none re-implements validation. `buildStackModel`/`flattenStackModel`
(existing) remain the merge-node primitives.

## Open question for review

**How does a group unit carry its internal merges for the note/gate?** Two
options: (1) reuse `PRUnit.mergeMembers` but make it a _list of merges_ (a unit
can contain more than one merge), i.e. `merges?: { mergeSha: string; members:
CommitInfo[] }[]`; or (2) keep `mergeMembers?: CommitInfo[]` for the top-level
single-merge unit and add a separate `merges?` list for the group case. (1) is
more uniform. Flagged for the plan.

## Testing (TDD)

- `tests/parse/stack.test.ts` — `mergeCommitPRGroup`; split-group prescan treats a
  grouped merge as contiguous; `detectPRUnits` absorbs a grouped merge into one
  unit and forms a top-level merge unit; merge-free stack byte-identical.
- `tests/commands/land.test.ts` — merge in scope, no `--merges` → gate refusal
  (not "not ready"); with `--merges` → `origin/main` advances to the merge tip;
  `--through <member-id>` inside a merge → hard reject; picker excludes merge
  interiors.
- `tests/commands/sync.test.ts` — a unit containing a merge gets the merge-note
  region; merge-free unit byte-unchanged.
- End-to-end via the real `group` command: materialize a merge (top-level AND
  nested in a PR group), then `view`/`land`/`sync` all succeed.
- Doc tests (unblocks spry-jxqg.1): `land --merges` story; sync merge-note body.

## Risk

The merge-aware branches only fire when a commit has 2+ parents / members, which
never happens in today's linear stacks — inert for every existing stack, pinned
by a byte-identical regression test. The split-group prescan change is guarded by
`mergeCommitPRGroup` returning undefined for non-merge / ungrouped commits, so a
plain interrupting commit still splits.
