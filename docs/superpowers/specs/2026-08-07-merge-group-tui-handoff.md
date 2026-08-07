# Handoff: `sp group` TUI — merge-group editing

**This is a standalone prompt for a fresh session.** It assumes no context from
the design conversation. Read the two referenced docs, study the existing TUI
code, then build and iterate on the interaction by hand. This task is
**feel-driven trial-and-error** — expect to run the TUI repeatedly, tweak, and
re-run. There is no single "correct" keymap to derive on paper; your job is to
find one that feels right while honoring a small set of fixed invariants.

## Background you need

`sp` is a stacked-PR tool. `sp group` opens an interactive TUI that edits how the
commits in the current stack are grouped. Two **independent** grouping axes exist:

- **PR groups** — which commits become one PR. Already implemented. Stored in
  `refs/spry/groups`. In the TUI today, `←/→` join/leave a PR group, `space`
  grab-to-move a commit, `r` rename, `enter` commit, `esc` cancel.
- **Merge groups** — a contiguous run of commits that materializes as a real
  **merge commit** in branch history. This is the NEW feature. Its non-interactive
  plumbing is already built and merged before you start (see below). Your job is
  the **interactive editing** of merge groups.

**Read these first** (they are the source of truth; this prompt summarizes):

- `docs/superpowers/specs/2026-08-07-merge-commit-groups-design.md` — the full
  design. Pay attention to "Interactive TUI" (intent + invariants) and
  "Implementation sequencing" (your step is #9; steps 1–8 are done).
- `AGENTS.md` — dogfooding, testing (`bun test`, doc tests), and the
  brainstorming/TDD conventions.

## What is already built when you start (your dependencies)

Steps 1–8 of the sequencing are complete and tested via the non-interactive
`sp group --apply <json>` path. Concretely, you can rely on:

- `MergeGroupRecord` / `MergeGroupRecords` and `src/git/merge-groups.ts`
  (`loadMergeGroupRecords` / `saveMergeGroupRecord` / `pushMergeGroupRecords`).
- The stack-walk understands materialized merges (first-parent walk + second-parent
  side branch); `parseStack` yields merge nodes; `StackTreeMerge` exists.
- The **materialize / unmerge plumbing**: given a desired set of merge groups
  (contiguous member spans, each with a message), the plumbing re-roots commits and
  builds/removes the merge commits deterministically. **You call this, you do not
  reimplement it.**
- `sp group --apply` already exercises all of the above end-to-end. Use it as your
  oracle: whatever the TUI produces on `enter` must be expressible as, and behave
  identically to, an equivalent `--apply` document.

So your work is confined to the TUI layer: reading keys, mutating the in-memory
editor model, rendering, launching `$EDITOR` for the message, and returning the
updated `MergeGroupRecords` from `extractResult`.

## Files you will live in

- `src/tui/group-state.ts` — the editor state machine (`GroupEditorState`,
  `applyEvent`, `EditorEvent`, `extractResult`). **Pure and unit-testable — this is
  where most of your logic and tests go.**
- `src/tui/group-render.ts` — frame rendering.
- `src/tui/group-editor.ts` — the editor loop.
- `src/tui/index.ts` + `src/tui/screen.ts` — key reading, alt-screen escape
  sequences (`ENTER_ALT_SCREEN`/`EXIT_ALT_SCREEN`).
- `src/commands/group.ts` — command entry; wires load/save of records.

Study how the existing PR-group editing works in `group-state.ts`
(`advanceGroup`/`retreatGroup`, the `move` mode, `extractResult`) before adding the
merge axis — mirror its shape.

## The intent (what the interaction must let a user do)

- Create / grow / shrink / dissolve a merge group over a **contiguous** run of
  commits, incrementally, with immediate visual feedback.
- Move a commit through the stack in a way that is **aware of both PR-group and
  merge-group boundaries**. Directional intent from the design discussion (NOT a
  fixed spec — you decide the final mapping by feel):
  - plain **up/down**: move a commit such that it joins/exits a group as it crosses
    the group's edge;
  - **shift-up/down**: jump a commit to the next group boundary;
  - **arrows** (`←/→`, `shift-←/→`): membership toggles.
    Treat these as a starting hypothesis to prototype, compare against alternatives,
    and refine. The existing `space`-to-grab move mode is also fair game to rework if
    a better model emerges — but keep PR-group editing working.
- Edit the merge commit **message** on creation (fixed contract, below).

## Invariants you MUST preserve (do not redesign these)

1. **Contiguity + containment.** A merge group's members are contiguous and lie
   within a single PR unit. Any interaction that would straddle a PR boundary or
   break contiguity must be a no-op or auto-corrected — never persisted.
2. **Independence.** Merge axis and PR-group axis are independent; a row may be in
   a PR group, a merge group, both, or neither. Editing one must not silently
   mutate the other.
3. **Rendering = indentation** for the merge axis (depth 0 or 1 — no nesting),
   layered on top of the existing PR-group letter column so both axes are legible
   simultaneously.
4. **Single-commit merge groups are allowed.**
5. **Batched materialization.** The TUI mutates an in-memory model only; on `enter`,
   `extractResult` returns the updated `MergeGroupRecords` (alongside
   `GroupRecords`) and the command layer runs the materialize/unmerge plumbing
   once. Nothing rewrites git history keystroke-by-keystroke. `esc` discards.

## The message editor (fixed contract)

When a merge group is first created, open `$EDITOR` (fallback `$GIT_EDITOR`, then
`vi`) on a temp file seeded git-style:

```
<first member's subject>

# Lines starting with # are ignored. The first line is the merge commit
# subject. Everything below the blank line is the merge commit body.
```

- Line 1 → merge commit subject; the rest → body. Held in the editor model, written
  onto the merge commit when it materializes on `enter`.
- Empty message / unmodified exit → **abort creating that merge group** (rows revert
  to un-merged in the model). Matches git's abort-on-empty convention.
- Launching `$EDITOR` from inside the alt-screen TUI: `EXIT_ALT_SCREEN` → restore
  cooked/echo tty → spawn `$EDITOR` inheriting the tty and wait → re-enter raw mode
  → `ENTER_ALT_SCREEN` → full redraw. No external editor is launched anywhere in
  the codebase today, so this is new; put it in `src/tui/external-editor.ts` reusing
  the escape sequences from `src/tui/screen.ts`.

## How to work

- **TDD the pure parts.** `group-state.ts` transitions (create/grow/shrink/dissolve
  merge group; contiguity + containment no-ops; move-with-boundary-awareness;
  independence from PR groups) are pure functions over `GroupEditorState` — write
  `bun test` cases first, they are fast and deterministic.
- **Iterate the feel by running it.** Build a small throwaway stack in a scratch
  repo and run `sp group` against it repeatedly. This is expected; budget for many
  cycles.
- **Use `--apply` as the oracle.** For any end state you reach in the TUI, confirm
  the equivalent `--apply` doc produces the same `MergeGroupRecords` and the same
  materialized history. If they diverge, the TUI logic is wrong.
- **Keep PR-group editing green.** Existing `sp group` behavior and its tests must
  keep passing.
- Follow `AGENTS.md`: doc tests for user-facing output, `bun run docs:verify`, and
  the beads/session protocol. Note the interactive TUI itself is not doc-tested —
  cover the pure model + the message seed/parse with unit tests; the spawn is thin
  and manually verified.

## Definition of done

- Merge groups can be created, grown, shrunk, dissolved, and message-edited
  interactively, honoring every invariant above.
- The TUI's `enter` output is identical in effect to the equivalent `--apply` doc.
- PR-group editing is unchanged and still passing.
- Pure model + message seed/parse are unit-tested; PR-group tests still green.
- You have iterated on the interaction enough to be confident it feels right (this
  is a real acceptance criterion, not a formality).
