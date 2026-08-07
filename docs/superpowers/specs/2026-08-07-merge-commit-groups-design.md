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

This must be **opt-in per group**. Flat groups and per-commit PRs are unchanged.

## Goals

- A group can be marked a **merge commit**; its commits land under a real merge
  commit in trunk, producing the clean self-contained graph above.
- The merge commit is **materialized in the local stack** as you work — a real
  commit in `git log`, editable with plain git — not a land-time illusion.
- Fast-forward-as-MERGED-marker is preserved: every merge group's PR flips to
  `MERGED` on land.
- `sp rebase` preserves materialized merges when trunk moves.
- Both surfaces supported: the interactive `sp group` TUI and the non-interactive
  `sp group --apply <json>` (so the agent can dogfood it and doc tests can cover
  it).
- Merge-group PR bodies warn readers that the PR contains a merge commit and show
  the commit relationships.

## Non-goals

- **No nesting.** A merge group cannot contain sub-merge-groups. "Indent" is a
  binary merge-vs-flat toggle, not a depth.
- **No GitHub merge API.** Landing stays ff-only.
- **No commit-message rewriting on the title axis.** Flattening a merge group
  (shift-left) does not seed a commit subject from the title; it simply drops the
  merge (see "Title ↔ subject").
- **No auto-migration.** Existing flat groups stay flat until explicitly toggled.

## Proven mechanics (evidence base)

Every non-obvious claim here was verified, not assumed. Recorded in the
`merge-commit-groups-experiment` memory.

1. **Clean graph + MERGED both achievable.** Re-root each merge group's commits
   onto that group's merge parent (previous merge commit / previous plain commit),
   and **push those re-rooted commits as the PR head branches**. Side branches
   then contain only their own group's commits (no cross-linking), and because the
   pushed PR head SHA equals the merge commit's second-parent SHA, GitHub marks
   the PR `MERGED` and attributes `mergeCommit` to the synthesized merge commit.
   Proven end-to-end on `spry-check` (PRs #1646/#1647 → both MERGED, clean graph).

2. **Head SHA must match, not just tree.** A merge whose second parent is a
   _tree-identical but different-SHA_ replay leaves the PR **OPEN** (spry-check PR
   #1645). GitHub's merged-by-reachability keys on the actual head SHA. So the
   re-rooted commits are not throwaway — they **are** the pushed PR heads.

3. **Order of operations on land: retarget bases → then ff-push.** A stacked PR
   whose base is still a lower group's branch does NOT flip to MERGED on ff-push;
   deleting its base branch afterward makes it CLOSED, not MERGED. Retargeting
   every in-scope PR's base to trunk _before_ the ff-push (while commits still
   differ, so GitHub accepts the retarget) makes all PRs MERGED. Proven with
   scenarios A (fail) and B (pass) on spry-check.

4. **Determinism.** `git commit-tree` defaults to wall-clock dates, so an
   untouched group would still mint a new SHA on regen. Pinning author/committer
   date + identity makes an unchanged group regenerate to the _identical_ SHA.

5. **Rebase preserves merges via plumbing.** Extending spry's existing
   `mergeTree`-based `rebasePlumbing` reproduces `git rebase --rebase-merges`
   byte-for-byte (same trees, same SHAs given pinned dates). Trap: each
   side-branch commit must be **3-way merged** onto the new trunk line (not have
   its old tree reused), or trunk's new changes are silently dropped.

## Data model

### `GroupRecord.merge`

`refs/spry/groups` stores `GroupRecord` as JSON. Add one optional field:

```ts
export interface GroupRecord {
  title: string;
  members: string[];      // Spry-Commit-Id values, in order
  merge?: boolean;        // NEW. absent | false = flat group (today's behavior).
                          // true = materialized merge commit.
}
```

Backward-compatible: every existing record parses as `merge: undefined` → flat.
`merge` is the single source of truth for a group's kind. `loadGroupRecords` /
`saveGroupRecord` (src/git/group-titles.ts) carry the field through verbatim;
the malformed-blob `catch` already tolerates unknown fields.

### The merge commit's message

The merge commit is a real commit. Its **subject line is the group title**; its
body is whatever the user writes. There is no separate "merge body" field in the
GroupRecord — the message lives on the commit, edited with git. The title in the
GroupRecord and the merge commit's subject are kept in sync (see below), so the
record stays the human-readable index even though the commit owns the full text.

## Materialization: what "make this a merge" does to the local branch

Toggling a group to `merge: true` **rewrites the local branch now**:

1. **Re-root the group's commits** onto the group's merge parent — the previous
   group's merge commit, or the previous plain commit, or trunk for the bottom
   group. Re-rooting uses the same 3-way `mergeTree` replay spry already uses for
   rebase, so it correctly carries any lower changes. The re-rooted commits get
   new SHAs.
2. **Insert a merge commit**: `commit-tree <groupFinalTree> -p <mergeParent> -p
<reRootedGroupTip> -m "<title>\n\n<body>"`, with pinned date + identity.
3. **Re-root everything above the group** (higher groups, plain commits, higher
   merges) onto the new merge commit — again via the existing replay path,
   preserving any higher merges' structure.
4. **Move the local branch ref** to the new tip (force-with-lease semantics
   locally; this is a history rewrite of the current branch, exactly like a
   rebase — same blast radius: the toggled group and everything above it).

Flattening (`merge: false`) is the inverse: drop the merge commit, re-root the
group's commits linearly onto the merge parent, re-root everything above. Commit
subjects are untouched.

Because the merge is materialized, `git log` shows it, the agent can
`git commit --amend` / `git rebase -i` its message, and `sp land` has nothing to
synthesize — it ff-pushes what is already there.

### Stack-walk change (required)

`getStackCommits` (src/git/queries.ts) today runs `git log --reverse base..HEAD`,
which flattens a merge and drops parent info. It must learn merges:

- Walk **`--first-parent base..HEAD`** for the trunk line (this yields, in order:
  bottom plain commits, merge commits, higher plain commits).
- For each first-parent commit that is a merge (2 parents), read its
  **second-parent side branch** (`<mergeParent>..<secondParent>`) as that group's
  member commits.
- Map each merge commit to its `GroupRecord` via `merge: true` + membership.

`parseStack` (src/parse/stack.ts) gains a notion of a merge unit whose commits are
the side branch and whose "landing commit" is the merge. `StackTreeGroup` gains a
`merge?: boolean` output field mirroring the record.

## Interactive TUI: shift-arrow toggle + message editor

`sp group` today: `←/→` join/leave groups, `space` grab-to-move, `r` rename,
`enter`/`esc`. Add:

- **`shift-→` (indent):** mark the cursor's group `merge: true`. Requires the
  cursor to be on a grouped row; no-op on ungrouped rows. On toggle-on, open the
  message editor (below).
- **`shift-←` (outdent):** mark the group `merge: false` (flatten). No editor.

`GroupEntry` (src/tui/group-state.ts) gains `merge: boolean`. `EditorEvent` gains
`{ type: "shift-arrow-right" } | { type: "shift-arrow-left" }`; the key reader
(src/tui/index.ts / screen input) maps the CSI sequences for Shift+Arrow
(`ESC [ 1 ; 2 C` / `ESC [ 1 ; 2 D`). `group-render.ts` shows a merge group
distinctly (e.g. a `⑃`/merge glyph or an indent marker) so the state is visible.

### The message editor

When a group becomes a merge, spry opens **`$EDITOR`** (falling back to
`$GIT_EDITOR`, then `vi`) on a temp file seeded git-style:

```
<current group title>

# Lines starting with # are ignored. The first line is the merge commit
# subject and becomes the group title. Everything below the blank line is
# the merge commit body.
```

On save: line 1 → group title (and thus the merge subject); the rest → body.
Empty message (or an unmodified editor exit) **aborts the in-memory toggle**: the
group reverts to flat in the editor model, so nothing is materialized on `enter`.
This is coherent with batched materialization — the abort happens before any
rewrite, matching git's own abort-on-empty convention. (The `--apply` path never
opens the editor and so never hits this; it uses the placeholder-subject rule
below, governed by open question 3.)

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

`sp group --apply <json>` gains `merge` on group nodes:

```jsonc
{ "type": "group", "id": "...", "title": "Ship auth", "merge": true,
  "commits": [ ... ] }
```

- `merge: true` on a group node materializes it as a merge commit; `false`/absent
  flattens/leaves flat (PUT semantics, consistent with the existing apply model).
- **Message on `--apply`:** the merge commit is created with a **placeholder
  subject = the group title** and an empty body. `--apply` never opens an editor.
  If a richer message is wanted, the caller edits the materialized merge commit
  with plain git afterward (`git commit --amend`, `git rebase -i`) — the merge is
  a real commit, so no spry-specific flow is needed. This keeps `--apply` and doc
  tests fully non-interactive and deterministic.

`sp view --json` reports `merge` on group nodes (output side), so an apply doc can
be built from a view.

## `sp land` with merge groups

Land today: acquire remote state → readiness gate → **one ff-push to the stack
tip** → scrub landed state. No base retargeting (a deliberate rebuild decision,
because retargeting-then-moving-trunk once corrupted PR diffs).

Merge groups require the retarget step back — but **only as a MERGED marker, and
only because the merge commit carries the reachability**, which is exactly why the
old diff-corruption problem does not recur (each PR keeps its own scoped base diff;
the merge commit, not a moved base, is what marks it merged). Concretely:

1. Acquire remote state (unchanged).
2. Readiness gate (unchanged).
3. **For each in-scope PR whose unit is (or is under) a merge group, retarget its
   base to trunk** — via `gh pr edit --base <trunk>` — _before_ the ff-push, while
   the head still differs from trunk so GitHub accepts the retarget. Flat/per-commit
   PRs are retargeted the same way only if they sit above a merge group and their
   base branch is about to become unreachable; otherwise unchanged. (Exact
   predicate: any PR whose current base is a branch that will not be an ancestor of
   trunk's new position must be retargeted to trunk first.)
4. **One ff-push** of trunk to the stack tip (unchanged mechanic; the tip is now a
   merge commit or sits above one).
5. Scrub landed state (unchanged): drop landed units' PR-cache entries and group
   records; delete remote branches iff `spry.autoDeleteOnLand`.

This adds `gh` calls (the retargets) to land's previously gh-free push path — a
cassette/doc-test consideration, not a correctness one.

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
`mergeTree` calls. **Trap encoded in the implementation:** never reuse a group's
old trees verbatim; always 3-way merge, or trunk's new changes vanish.

## PR body for merge groups

A merge-group PR's body (src/gh/pr-body.ts) gains a warning region and a
relationship block, spliced like the existing spry regions (its own
begin/end markers, user edits outside preserved). Content:

- **Warning:** a callout that this PR lands as a **merge commit**, and that its
  N commits represent the whole group and land together as one merge — reviewers
  should read it as a unit.
- **Relationship block:** a fenced code block sketching the merge shape, e.g.

  ````
  ```
  Merge group: <title>
  |\
  | * <subject of commit N>
  | * <subject of commit 1>
  |/
  * <merge parent>
  ```
  ````

  built from the group's ordered member subjects. This is generated content in a
  new `spry:merge-note` region; flat/per-commit PRs never get it.

`generateBodyContent` branches on the unit being a merge group to emit the
warning + relationship block instead of (or in addition to) today's bulleted
subject list. `BETA_WARNING`'s existing "Do not manually merge stacked PRs" line
stays.

## Per-commit-PR policy interaction (dogfooding)

Our AGENTS.md policy is "every commit gets its own PR." A merge group is
inherently **one PR for N commits** — that is the point of the feature, and it is
already true of today's flat groups. No policy change: a merge group is a single
unit with a single PR, grouped precisely because those commits belong together.
When dogfooding this feature's own commits, group the ones that form a coherent
merge and open the group's single PR, exactly as the existing grouping guidance
already directs.

## Testing

- **Unit:** `group-state` shift-arrow transitions (merge on/off, no-op on
  ungrouped, dissolve interaction); `GroupRecord` round-trip with `merge`;
  stack-walk over a materialized merge (first-parent + side-branch extraction);
  merge-aware `rebasePlumbing` producing the proven trees; PR-body merge-note
  splicing.
- **Doc tests (`--apply` path):** materialize a merge via an apply doc, `sp view`
  shows the merge group; `sp land` marks the group's PR MERGED (cassette). Because
  `--apply` seeds a placeholder subject with no editor, these stay deterministic.
- **Cassettes:** land now issues `gh pr edit --base` retargets — re-record the
  land cassettes for merge-group scenarios. Follow the pre-merge record+playback
  gate in AGENTS.md.
- **The `$EDITOR` flow is interactive-only** and thus not doc-tested; cover the
  temp-file seed/parse (title↔subject split, empty-abort) as a pure unit test on
  the seed/parse functions, with the spawn itself thin and manually verified.

## Open questions for review

1. **Retarget predicate scope.** The spec retargets any PR whose base will become
   unreachable. Is retargeting _only_ merge-group PRs (and leaving a
   flat-above-merge PR to be healed by the next `sp sync`) acceptable instead, to
   minimize land's new `gh` calls? Trade-off: fewer calls vs. a transient
   wrong-base PR until next sync.
2. **Merge glyph in the TUI.** Any preference for how a merge group renders
   (indent, glyph, color)? Affects `group-render.ts` only.
3. **Empty-title merge.** A merge needs a subject. Reject `merge: true` with an
   empty title at apply/validation time, or fall back to a synthesized
   `Merge group: <first-subject>`? Spec currently implies the title is required.

```

```
