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

## Interactive TUI: shift-arrow toggle + message editor

`sp group` today: `←/→` join/leave PR groups, `space` grab-to-move, `r` rename,
`enter`/`esc`. The merge axis is a **separate dimension** shown alongside the PR
grouping. Add:

- **`shift-→` (merge):** fold the cursor's row into a merge group. If the row is
  adjacent to an existing merge group, it joins it; otherwise it starts a new
  single-member merge group at the cursor (which the user extends by pressing
  `shift-→` on adjacent rows, the same incremental way `→` builds PR groups
  today). On first creation of a merge group, open the message editor (below).
- **`shift-←` (unmerge):** remove the cursor's row from its merge group. Removing
  the last member dissolves the merge group. No editor.

Constraints enforced live in the editor model:

- A merge group's members must be **contiguous** and must lie **within a single
  PR unit** (the containment invariant). `shift-→` is a no-op if it would make a
  merge group straddle a PR boundary or become non-contiguous.
- The merge axis and PR-group axis are independent: a row can be in a PR group, a
  merge group, both, or neither.

`GroupEditorState` gains a `mergeGroups` structure (row-index spans + a minted id
each), parallel to the existing PR-group letters. `EditorEvent` gains
`{ type: "shift-arrow-right" } | { type: "shift-arrow-left" }`; the key reader
(src/tui/index.ts / screen input) maps the CSI sequences for Shift+Arrow
(`ESC [ 1 ; 2 C` / `ESC [ 1 ; 2 D`). `group-render.ts` shows merge-group spans
distinctly (e.g. a bracket/`⑃` glyph in a dedicated column) so both axes are
visible at once. `extractResult` returns updated `MergeGroupRecords` alongside the
existing `GroupRecords`.

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
- **Message on `--apply`:** the merge commit is created with a **placeholder
  subject** (see open question 3) and an empty body. `--apply` never opens an
  editor. For a richer message, the caller amends the materialized merge commit
  with plain git afterward — it is a real commit, so no spry-specific flow is
  needed. Keeps `--apply` and doc tests fully non-interactive and deterministic.

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
3. **One ff-push** of trunk to the stack tip (unchanged mechanic; the tip and/or
   intermediate PR heads may be merge commits, which does not affect the ff).
4. Scrub landed state (unchanged): drop landed units' PR-cache and group records;
   delete remote branches iff `spry.autoDeleteOnLand`.

Base-retargeting between stacked PRs is governed by the **existing** land/sync
behavior and is _not_ changed by this feature — merges do not introduce new PRs,
so they add no retarget obligation. (This supersedes the earlier draft, which
wrongly required a retarget step for merges when it modeled merge≡PR.) Land adds
**no new `gh` calls**, so the land cassettes stay valid.

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

## Testing

- **Unit:** `group-state` shift-arrow transitions (merge create/extend/dissolve,
  contiguity + containment no-ops); `MergeGroupRecords` round-trip on
  `refs/spry/merge-groups`; stack-walk over a materialized merge (first-parent +
  side-branch extraction) including a merge _interleaved with_ plain commits in
  one PR span; merge-aware `rebasePlumbing` producing the proven trees;
  `generateMergeNote` + splice; `--apply` contiguity/containment validation
  (fatal-error taxonomy).
- **Doc tests (`--apply` path):** materialize a merge via an apply doc; `sp view`
  / `sp view --json` show the nested `merge` node; `sp land` marks the containing
  PR MERGED (cassette, mirroring the proven #1723 flow). Deterministic because
  `--apply` seeds a placeholder subject with no editor.
- **Cassettes:** land issues **no new `gh` calls**, so existing land cassettes
  stay valid; add a merge-in-PR land scenario cassette. Follow the pre-merge
  record+playback gate in AGENTS.md.
- **The `$EDITOR` flow is interactive-only** and thus not doc-tested; cover the
  temp-file seed/parse (subject/body split, empty-abort) as a pure unit test on
  the seed/parse functions, with the spawn itself thin and manually verified.

## Open questions for review

1. **Merge-group rendering in the TUI.** How should a merge-group span render in
   `group-render.ts` — a bracket in a dedicated column, a glyph, indentation,
   color? It must be legible _simultaneously_ with the existing PR-group letters,
   since the two axes coexist on the same rows.
2. **Placeholder subject on `--apply`.** A materialized merge needs a subject, but
   `--apply` supplies none. Synthesize `Merge: <first-member-subject>`, or require
   an explicit `subject` field on the `merge` node (rejecting it if absent)? The
   spec currently assumes a synthesized placeholder that the caller amends with
   git.
3. **Single-commit merge groups.** Should a merge group of exactly one commit be
   allowed (a merge with a one-commit side branch)? Harmless mechanically and
   simplifies incremental `shift-→` building, but arguably pointless. Allow, or
   require ≥2 members?
