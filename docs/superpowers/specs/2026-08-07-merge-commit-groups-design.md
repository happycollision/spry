# Merge-commit groups — Design

**Status:** Draft for review. All git/GitHub mechanics below were proven against
a sandbox and the live `spry-check` repo during design (2026-08-03 → 08-07); see
"Proven mechanics" for the exact evidence.

## Problem

Today a spry group lands as either a per-commit PR or a "flat" grouped PR, and
`sp land` fast-forwards trunk directly to the raw stack tip. Trunk history is
therefore linear: a landed group leaves no trace that its commits belonged
together. Users want the option to land a group as a **merge commit**, so trunk
history tells the merge story:

```
*   Merge group: commits 8-9
|\
| * commit 9
| * commit 8
|/
* commit 7
* commit 6
*   Merge group: commits 4-5
|\
| * commit 5
| * commit 4
|/
*   Merge group: commits 1-3
|\
| * commit 3
| * commit 2
| * commit 1
|/
* base commit on trunk
```

…while keeping fast-forward as the PR-merged marker (spry never uses the GitHub
merge API — a PR is marked `MERGED` by reachability from the default branch after
an ff-push).

This must be **opt-in per merge group**. Flat groups and per-commit PRs are
unchanged.

### Two independent axes: PR groups vs. merge groups

The central model correction (2026-08-07): **a PR group and a merge group are not
the same thing.**

- A **PR group** is the unit that becomes one PR (today's `sp group`
  grouping — stored in `refs/spry/groups`).
- A **merge group** is a set of contiguous commits that materialize as a **merge
  commit** in branch history.

They relate by containment, not identity:

- A single PR group (or a single per-commit PR unit's span) can contain **zero or
  more merge groups**, freely interleaved with plain commits. E.g. one PR =
  `p1, merge(m1,m2), p3` — the merge commit is **internal to that PR's branch
  history**.
- A merge group **must be fully contained within one PR unit** — it may never
  straddle a PR boundary. Rationale: a merge lands atomically and cannot be
  half-approved, so splitting a merge across two PRs (one approvable without the
  other) is incoherent. This containment is a validation invariant, not just a
  convention.

The PR head is the PR unit's **top commit** (which may itself be a merge commit,
or a plain commit sitting above merges). The PR diff is the usual three-dot
`base..head`, so it shows the unit's cumulative change; merge commits are internal
history. Proven on `spry-check` (PR #1723): a PR branch with an internal merge
commit shows the correct cumulative diff, reports CLEAN/MERGEABLE, and marks
MERGED on the trunk ff-push.

Because a merge lives **inside** one PR, materializing a merge never introduces a
new PR and never requires base-retargeting for the merge itself. Base-retargeting
remains solely a between-stacked-PRs concern (see `sp land`).

## Goals

- A contiguous run of commits within a PR unit can be marked a **merge group**;
  those commits land under a real merge commit in trunk, producing the clean
  self-contained graph above.
- The merge commit is **materialized in the local stack** as you work — a real
  commit in `git log`, editable with plain git — not a land-time illusion.
- Fast-forward-as-MERGED-marker is preserved: every merge group's PR flips to
  `MERGED` on land.
- `sp rebase` preserves materialized merges when trunk moves.
- Both surfaces supported: the interactive `sp group` TUI and the non-interactive
  `sp group --apply <json>` (so the agent can dogfood it and doc tests can cover
  it).
- A PR whose branch contains merge commits gets body text warning readers and
  showing the commit relationships.

## Non-goals

- **No nesting.** A merge group cannot contain sub-merge-groups. `shift-→` is a
  binary merge/unmerge toggle, not a depth.
- **No GitHub merge API.** Landing stays ff-only.
- **No commit-message rewriting on unmerge.** Unmerging (`shift-←`) does not seed
  a commit subject from the merge message; it simply drops the merge commit and
  leaves the member commits' own subjects untouched.
- **No coupling to PR grouping.** Merge groups neither create nor dissolve PR
  groups; the two axes are edited independently.
- **No auto-migration.** Existing repos have zero merge groups until explicitly
  created.

## Proven mechanics (evidence base)

Every non-obvious claim here was verified, not assumed. Recorded in the
`merge-commit-groups-experiment` memory.

1. **Clean self-contained merge graph.** Re-rooting a merge group's commits onto
   the merge parent (the commit below it) and building the merge with
   `commit-tree <finalTree> -p <mergeParent> -p <reRootedTip>` yields a merge
   whose side branch contains only that group's commits — no cross-linking with
   neighbors. Proven building the exact multi-merge "tulip" graph.

2. **A PR branch with an internal merge lands MERGED on a plain ff-push.** A PR
   whose branch history contains a merge commit (interleaved with plain commits)
   shows the correct cumulative three-dot diff, reports CLEAN/MERGEABLE, and marks
   `MERGED` (mergeCommit = the PR head) when trunk ff's to that head. This is the
   load-bearing result for the nested model. Proven on `spry-check` PR #1723.

3. **Reachability keys on the head SHA, not the tree** (constrains the internal
   commits). A commit is "in" trunk only if its actual SHA is reachable; a
   tree-identical but different-SHA twin does not count (spry-check PR #1645 left
   a PR OPEN). Consequence: the re-rooted commits inside the PR branch must be the
   ones actually pushed on that branch — re-rooting is a real history rewrite of
   the branch, not a throwaway copy applied only at land.

4. **Determinism.** `git commit-tree` defaults to wall-clock dates, so an
   untouched merge would still mint a new SHA on regen. Pinning author/committer
   date + identity makes an unchanged merge regenerate to the _identical_ SHA.

5. **Rebase preserves merges via plumbing.** Extending spry's existing
   `mergeTree`-based `rebasePlumbing` reproduces `git rebase --rebase-merges`
   byte-for-byte (same trees, same SHAs given pinned dates). Trap: each
   side-branch commit must be **3-way merged** onto the new trunk line (not have
   its old tree reused), or trunk's new changes are silently dropped.

(Provenance note: an earlier draft also relied on a "retarget stacked-PR bases →
then ff-push" finding — proven on spry-check scenarios A/B — for a model where
each merge was its own PR. That model was corrected: merges are now internal to a
PR, so that retarget behavior is ordinary between-stacked-PR land/sync mechanics,
not something this feature adds.)

## Data model

Because merge groups are a **separate axis** from PR groups, they get their own
storage rather than a flag on `GroupRecord`. `GroupRecord` (the PR group) is
unchanged: `{ title, members }`.

### Merge-group records — `refs/spry/merge-groups`

A new ref, `refs/spry/merge-groups`, stores merge-group definitions as JSON,
keyed by merge-group id (a spry commit id, minted like PR-group ids). Each record
names its contiguous members in stack order:

```ts
export interface MergeGroupRecord {
  members: string[]; // Spry-Commit-Id values, contiguous, in stack order.
                     // subject/body live on the materialized merge commit itself,
                     // NOT here — the commit owns its message (edited with git).
}
export type MergeGroupRecords = Record<string, MergeGroupRecord>;
```

Modeled on the existing `refs/spry/groups` load/save/push helpers
(src/git/group-titles.ts) — a parallel `src/git/merge-groups.ts` with
`loadMergeGroupRecords` / `saveMergeGroupRecord` / `pushMergeGroupRecords` and the
same tolerant-of-unknown-fields JSON parsing. Fully backward-compatible: a repo
with no `refs/spry/merge-groups` ref has zero merge groups.

Why a separate ref and no `title` field:

- **Separate ref** keeps the two axes independent — a merge group's membership is
  not tied to any PR group's membership, and a PR group's record needs no new
  fields. It also means the merge-group data self-heals/rebuilds on its own
  cadence, exactly like the PR-cache and groups refs do.
- **No `title` in the record**: the merge commit is a real commit, so its subject
  and body live **on the commit**. The record only needs to identify which
  commits form the merge so the stack-walker and rematerializer can find it. This
  avoids a title/subject sync problem — there is one source of truth (the commit
  message), edited with plain git.

### The merge commit's message

The merge commit is a real commit. Its subject and body are whatever the user
wrote (via `$EDITOR` on the interactive path, or a placeholder on `--apply`,
amendable with git afterward). Nothing in spry's refs duplicates the message.

## Materialization: what "make this a merge group" does to the local branch

Marking a contiguous set of commits as a merge group **rewrites the local branch
now**:

1. **Re-root the merge group's commits** onto the merge parent — the commit
   immediately below the group in the stack (a plain commit, trunk, or a lower
   merge commit). Re-rooting uses the same 3-way `mergeTree` replay spry already
   uses for rebase, so it correctly carries any lower changes. The re-rooted
   commits get new SHAs.
2. **Insert a merge commit**: `commit-tree <groupFinalTree> -p <mergeParent> -p
<reRootedGroupTip> -m "<subject>\n\n<body>"`, with pinned date + identity. The
   message comes from the editor (interactive) or a placeholder (`--apply`).
3. **Re-root everything above the group** (plain commits, other merge groups)
   onto the new merge commit — again via the existing replay path, preserving any
   higher merges' structure.
4. **Move the local branch ref** to the new tip (force-with-lease semantics
   locally; this is a history rewrite of the current branch, exactly like a
   rebase — same blast radius: the merge group and everything above it).

Unmerging is the inverse: drop the merge commit, re-root the group's commits
linearly onto the merge parent, re-root everything above. Commit subjects are
untouched.

Because the merge is materialized, `git log` shows it, the agent can
`git commit --amend` / `git rebase -i` its message, and `sp land` has nothing to
synthesize — it ff-pushes what is already there.

Materializing a merge group does **not** change any PR group's membership. A merge
group is a span _within_ a PR unit; the PR unit still opens as one PR whose head
is its top commit.

### Stack-walk change (required)

`getStackCommits` (src/git/queries.ts) today runs `git log --reverse base..HEAD`,
which flattens a merge and drops parent info. It must learn merges:

- Walk **`--first-parent base..HEAD`** for the trunk line (this yields, in order:
  the outer sequence of plain commits and merge commits).
- For each first-parent commit that is a merge (2 parents), read its
  **second-parent side branch** (`<mergeParent>..<secondParent>`) as that merge
  group's member commits.
- Match each merge commit to its `MergeGroupRecord` by membership.

`parseStack` (src/parse/stack.ts) gains a notion of a merge node whose commits are
the side branch and whose "landing commit" is the merge. This is orthogonal to PR
grouping: a PR unit's span is walked as usual, and any merge nodes inside it are
recognized from the first-parent walk. `StackTree` output (`sp view --json`)
represents a merge as a nested node inside its PR unit (see below).

## Interactive TUI

> **Deferred to its own session.** The exact keybindings, movement model, and feel
> of editing merge groups in the `sp group` TUI are **not specified here** — they
> need hands-on trial-and-error, which is poorly served by a written spec written
> up front. This work is sequenced **last** (see "Implementation sequencing") and
> handed to a dedicated session via a standalone prompt
> (`docs/superpowers/specs/2026-08-07-merge-group-tui-handoff.md`). This section
> records only the **intent and invariants** that session must satisfy; it is free
> to choose whatever interaction lands best.

### What the TUI must let the user express (intent)

- **Create / grow / shrink / dissolve a merge group** over a contiguous run of
  commits, incrementally, with immediate visual feedback.
- **Move a commit through the stack** in a way that is aware of both PR-group and
  merge-group boundaries — e.g. stepwise movement that joins/exits a group as a
  commit crosses its edge, and a faster "jump to the next boundary" movement.
  (Directional intent captured from design discussion: plain up/down for
  cross-a-boundary join/exit, shift-up/down to jump a commit to a group boundary,
  arrows for membership — but the final mapping is the session's call.)
- **Edit the merge commit message** on creation (see the message editor below),
  which is the one sub-part with a fixed contract.

### Invariants the interaction must preserve (fixed)

These are load-bearing for the rest of the design and are **not** up for
rediscovery in the TUI session:

- A merge group's members are **contiguous** and lie **within a single PR unit**
  (the containment invariant). Any interaction that would straddle a PR boundary
  or break contiguity must be a no-op or auto-corrected, never persisted.
- The merge axis and PR-group axis are **independent**: a row can be in a PR
  group, a merge group, both, or neither.
- **Rendering = indentation** for the merge axis (depth 0/1, no nesting), layered
  on top of the existing PR-group letter column so both axes are legible at once.
- Single-commit merge groups are **allowed**.
- Editing is **batched**: the TUI mutates an in-memory model and commits the whole
  change set on `enter` via `extractResult`, which returns updated
  `MergeGroupRecords` alongside the existing `GroupRecords`. The
  materialize/unmerge plumbing rewrites run once, then. Nothing rewrites history
  keystroke-by-keystroke.

### The message editor

When a merge group is first created, spry opens **`$EDITOR`** (falling back to
`$GIT_EDITOR`, then `vi`) on a temp file seeded git-style:

```
<first member's subject>

# Lines starting with # are ignored. The first line is the merge commit
# subject. Everything below the blank line is the merge commit body.
```

On save: line 1 → merge commit subject; the rest → body. The message is held in
the editor model and written onto the merge commit when it materializes on
`enter`. Empty message (or an unmodified editor exit) **aborts creating the merge
group**: the rows revert to un-merged in the editor model, so nothing is
materialized. This matches git's own abort-on-empty convention. (The `--apply`
path never opens the editor; it uses the placeholder-subject rule below.)

Because the TUI owns the alternate screen buffer, launching `$EDITOR` must:
`EXIT_ALT_SCREEN` → restore cooked/echo tty mode → spawn `$EDITOR` inheriting the
tty and wait → re-enter raw mode → `ENTER_ALT_SCREEN` → full redraw. This is new
machinery (no external editor is launched anywhere today); it lives in a small
`src/tui/external-editor.ts` with the enter/exit escape sequences reused from
`src/tui/screen.ts`.

Materialization itself does not happen keystroke-by-keystroke. As today, the TUI
edits an in-memory model and commits the whole change set on `enter` via
`extractResult`; the merge/flatten rewrites run then, in one plumbing pass.

## Non-interactive `--apply`

Because a merge group is a span _inside_ a PR unit, `--apply` represents it as a
**nested `merge` node** in the commit list of a group (or of the top-level stack),
rather than a flag on the group node:

```jsonc
{
  "type": "group", "id": "...", "title": "Ship auth",
  "commits": [
    { "type": "commit", "id": "..." },
    { "type": "merge", "id": "...", "commits": [
        { "type": "commit", "id": "..." },
        { "type": "commit", "id": "..." }
    ] },
    { "type": "commit", "id": "..." }
  ]
}
```

- A `merge` node materializes its `commits` as one merge commit; its absence
  leaves those commits plain (PUT semantics, consistent with the existing apply
  model). A `merge` node's `id` follows the same identity rules as group ids
  (retained id / `id:null` to mint / `reissueId`).
- **Contiguity + containment are validated** (fatal, pre-write): a `merge` node's
  commits must be contiguous and must not cross a PR-unit boundary — structurally
  guaranteed here by nesting, but re-checked against the live stack.
- **Message on `--apply` (decision):** the merge commit is created with a
  **synthesized placeholder subject** — `Merge: <first-member-subject>` — and an
  empty body. `--apply` never opens an editor and never requires a `subject`
  field on the node. The user or agent adjusts the message afterward with plain
  git (`git commit --amend` / `git rebase -i`) — it is a real commit, so no
  spry-specific flow is needed. Keeps `--apply` and doc tests fully
  non-interactive and deterministic.

`sp view --json` emits the same nested `merge` nodes (output side), so an apply
doc can be built from a view. `StackTree` types (src/parse/types.ts) gain a
`StackTreeMerge` node: `{ type: "merge", id, commits: StackTreeCommit[] }`,
allowed inside a group's `commits` and at the top level.

## `sp land` with merge groups

**Land is essentially unchanged.** Because every merge group is contained within a
single PR unit, the merge commits are **internal to a PR branch** — landing still
fast-forwards trunk to the stack tip, and each PR marks MERGED by reachability
exactly as today. Proven on `spry-check` PR #1723 (a PR whose branch contained an
internal merge commit landed MERGED on a plain ff-push).

So:

1. Acquire remote state (unchanged).
2. Readiness gate (unchanged).
3. **Merge-commit gate (new):** if any in-scope commit being landed is a merge
   commit, `sp land` **refuses unless `--merges` is passed** (see below).
4. **One ff-push** of trunk to the stack tip (unchanged mechanic; the tip and/or
   intermediate PR heads may be merge commits, which does not affect the ff).
5. Scrub landed state (unchanged): drop landed units' PR-cache and group records;
   delete remote branches iff `spry.autoDeleteOnLand`.

Base-retargeting between stacked PRs is governed by the **existing** land/sync
behavior and is _not_ changed by this feature — merges do not introduce new PRs,
so they add no retarget obligation. (This supersedes the earlier draft, which
wrongly required a retarget step for merges when it modeled merge≡PR.) Land adds
**no new `gh` calls**, so the land cassettes stay valid.

### The `--merges` gate (decision)

Merge commits land **permanently** into trunk history, and a merge group can be
created (via `shift-→` with an empty/aborted editor edge case, or a single-commit
merge, or an `--apply` synthesized subject) with a placeholder or unpolished
message. To make landing merge commits a deliberate act rather than a silent one,
`sp land` **requires an explicit `--merges` flag** when the scope it is about to
land contains one or more merge commits. Without the flag, land aborts with a
message naming the merge commit(s) and instructing the user to review/edit their
messages and re-run with `--merges` (or to unmerge them in `sp group`).

- Detection is local and free: the readiness walk already sees the stack; a merge
  commit is any in-scope first-parent commit with two parents. No `gh` calls.
- The gate keys on the **presence of merge commits in scope**, not on message
  quality — spry does not judge whether a message is "good enough"; the flag is
  the user's acknowledgment.
- **Single-commit merge groups are allowed** (decision 3): a merge group may have
  exactly one member. It is mechanically harmless and lets `shift-→` build a merge
  incrementally from one row. Like any merge, landing it requires `--merges`.
- Flag wiring: add `--merges` to the `land` command in `src/cli/index.ts`
  (commander), threaded into `landCommand` options next to `--through`.

## `sp rebase` with merge groups

`rebasePlumbing` (src/git/plumbing.ts) currently walks a linear commit list,
always creating single-parent commits. Extend it to a merge-aware walk driven by
the same first-parent + side-branch structure the stack-walker uses:

- Plain commit: replay onto the current rebased tip via `mergeTree` (today's path,
  unchanged).
- Merge commit: replay each side-branch commit onto the rebased trunk line via
  `mergeTree`; rebuild the merge as `commit-tree <groupFinalTree> -p <trunkLine>
-p <replayedSideTip>` with pinned date/identity; continue the trunk line from
  the rebuilt merge.

Proven byte-identical to `git rebase --rebase-merges`. The dry-run conflict
predict (already a dry `rebasePlumbing`) works unchanged since it rides the same
`mergeTree` calls. **Trap encoded in the implementation:** never reuse a merge
group's old trees verbatim; always 3-way merge, or trunk's new changes vanish.

## PR body when a PR contains merge groups

A PR whose branch contains one or more internal merge commits gets an added
`spry:merge-note` region in its body (src/gh/pr-body.ts), spliced like the other
spry regions (own begin/end markers, user edits outside preserved). The PR is
still an ordinary PR — this region is additive context, not a replacement for the
normal body. Content:

- **Warning:** a callout that this PR's branch contains **N merge commit(s)**;
  each merge folds a set of commits that should be reviewed as a unit and land
  together atomically.
- **Relationship block(s):** one fenced code block per contained merge, sketching
  the shape from the merge's ordered member subjects:

  ````
  ```
  Merge: <merge subject>
  |\
  | * <subject of member M>
  | * <subject of member 1>
  |/
  * <merge parent>
  ```
  ````

The region is emitted only when the PR unit's span contains ≥1 merge node;
per-commit and merge-free grouped PRs never get it. `generateBodyContent` is
unchanged for the normal body; a new `generateMergeNote(mergeNodes)` produces the
region, wired into `buildInitialBody` / `spliceBody` alongside the existing
regions. `BETA_WARNING`'s "Do not manually merge stacked PRs" line stays.

## Per-commit-PR / grouping policy interaction (dogfooding)

Our AGENTS.md policy is "every commit gets its own PR," relaxed to "coherent
groups get one PR." Merge groups are **orthogonal** to that policy: a merge group
is a shape _within_ a PR unit, not a PR boundary. A per-commit PR can contain a
merge; a grouped PR can contain several. Dogfooding guidance: choose PR boundaries
exactly as today, and independently mark any contiguous run of commits within a PR
as a merge group when you want that run to land as one merge commit. No policy
change is needed.

## Implementation sequencing

The interactive `sp group` TUI is built **last**, as its own session, because its
interaction model is trial-and-error work (see "Interactive TUI"). Everything
before it is deterministic, testable via `--apply`, and can be fully built and
merged without ever opening the TUI:

1. **Data model** — `MergeGroupRecord` + `refs/spry/merge-groups`
   load/save/push (`src/git/merge-groups.ts`).
2. **Stack-walk** — first-parent + side-branch recognition of materialized merges
   (`getStackCommits`/`parseStack`), `StackTreeMerge` node.
3. **Materialize / unmerge plumbing** — re-root + two-parent `commit-tree`, and
   the inverse, with pinned date/identity.
4. **`sp group --apply`** — nested `merge` node parse, contiguity/containment
   validation, driving (1)–(3). This is the non-interactive entry point that makes
   everything below testable and agent-dogfoodable.
5. **`sp view` / `--json`** — render/emit nested merge nodes.
6. **`sp rebase`** — merge-aware `rebasePlumbing`.
7. **`sp land --merges`** gate.
8. **PR body** — `spry:merge-note` region.
9. **Interactive TUI** — deferred to the handoff session; depends only on the
   in-memory model + `extractResult` contract from (1)/(4), so it slots on top of
   finished, tested plumbing.

The handoff prompt for step 9 lives at
`docs/superpowers/specs/2026-08-07-merge-group-tui-handoff.md` and is written to
be self-contained (no dependency on this conversation's context).

## Testing

- **Unit:** `group-state` merge-group transitions (create/grow/shrink/dissolve,
  contiguity + containment no-ops, independence from PR-group edits) — owned by the
  deferred TUI session; `MergeGroupRecords` round-trip on
  `refs/spry/merge-groups`; stack-walk over a materialized merge (first-parent +
  side-branch extraction) including a merge _interleaved with_ plain commits in
  one PR span; merge-aware `rebasePlumbing` producing the proven trees;
  `generateMergeNote` + splice; `--apply` contiguity/containment validation
  (fatal-error taxonomy).
- **Doc tests (`--apply` path):** materialize a merge via an apply doc; `sp view`
  / `sp view --json` show the nested `merge` node; `sp land` marks the containing
  PR MERGED (cassette, mirroring the proven #1723 flow). Deterministic because
  `--apply` seeds a placeholder subject with no editor.
- **`--merges` gate:** unit-test that a scope containing a merge commit aborts
  without `--merges` (naming the merge) and proceeds with it; single-commit merge
  group still trips the gate.
- **Cassettes:** land issues **no new `gh` calls**, so existing land cassettes
  stay valid; add a merge-in-PR land scenario cassette (run with `--merges`).
  Follow the pre-merge record+playback gate in AGENTS.md.
- **The `$EDITOR` flow is interactive-only** and thus not doc-tested; cover the
  temp-file seed/parse (subject/body split, empty-abort) as a pure unit test on
  the seed/parse functions, with the spawn itself thin and manually verified.

## Resolved decisions

These were open during design and are now settled (folded into the sections
above):

1. **TUI rendering = indentation.** A merge group's member rows are indented
   (depth 0/1), layered on top of the existing PR-group letter column so both
   axes stay legible. Matches the indent/outdent mental model.
2. **`--apply` synthesizes the subject.** Merge nodes need no `subject` field;
   the merge commit is created as `Merge: <first-member-subject>`, and the user or
   agent adjusts it later with plain git.
3. **Single-commit merge groups allowed**, but landing any merge commit requires
   the explicit **`sp land --merges`** gate.
