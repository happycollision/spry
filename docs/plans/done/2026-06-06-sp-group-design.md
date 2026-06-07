# sp group Design

**Date:** 2026-06-06
**Step:** Step 7 — sp group (TUI editor)

## Goal

`sp group` lets users assign commits to named groups, reorder commits, and set group titles — all in a single interactive TUI session. Groups are persisted as JSON records in `refs/spry/groups` (not as commit trailers), so grouping never requires a commit rewrite. Reordering still rewrites the commit chain.

## Scope

- Interactive TUI: group assignment, reordering, inline title editing
- PR adoption prompt when newly-grouped commits have existing open PRs
- Write updated `GroupRecord` objects to `refs/spry/groups`; push ref best-effort
- Cross-cutting cleanups: `classifyGhInfraError` extraction, `CommitInfo`/`CommitTrailers` type unification

**Out of scope (deferred):** `--fix`, `--apply`, `dissolve` subcommand.

## Architecture

Group membership is stored as `GroupRecord { title: string, members: string[] }` JSON blobs in `refs/spry/groups`, keyed by group ID. `parseStack` reads a `CommitGroupMap` (commitId → groupId) built from those records — it never touches `Spry-Group` trailers. This means `sp group` only needs to rewrite commits when **reordering**; group assignment changes are pure ref writes.

### Data flow

```
loadConfig → getStackCommits → parseCommitTrailers
          → loadGroupRecords → buildCommitGroupMap + extractGroupTitles
          → findPRsForBranches (for PR adoption, falls back silently)
          ↓
     group-editor (TUI)
          ↓
    GroupEditorResult {
      newOrder: string[] | null,     // commit hashes in new order, null if unchanged
      updatedRecords: GroupRecords,  // all records after editing (deleted groups absent)
      cancelled: boolean
    }
          ↓
  IF newOrder: rewriteCommitChain + finalizeRewrite
  saveGroupRecord (per new/modified/deleted record)
  git push origin refs/spry/groups:refs/spry/groups (best-effort)
```

### Components

1. **`src/commands/group.ts`** — orchestrates load → TUI → apply result. Saves records. Pushes ref. Rewrites commit chain only if order changed.
2. **`src/tui/group-editor.ts`** — TUI main loop (raw mode + PTY). Returns `GroupEditorResult`.
3. **`src/tui/group-state.ts`** — pure state machine. `(state, event) → state`. No I/O.
4. **`src/tui/group-render.ts`** — pure render. `(state) → string`. No I/O.

## TUI Interaction Model

### Modes

**Normal mode** (default):

- `↑`/`↓` — move cursor
- `→` — advance group (no group → A → B → ...; allocates new group + ID if needed)
- `←` — retreat group (A → no group; dissolves group entry if last member removed)
- `Space` — enter Move mode (grab current commit)
- `r` — enter Rename mode for current row's group (no-op if ungrouped)
- `Enter` — save and exit
- `q` / `Ctrl+C` / `Esc` — cancel (confirm if changes pending)

**Move mode:**

- `↑`/`↓` — move grabbed commit up/down; conflict prediction runs async after each step
- `Space` / `Enter` — drop at current position, return to Normal mode
- `Esc` — cancel move, snap commit back to original position

**Rename mode:**

- Typing replaces the group title character by character
- `Enter` — confirm title, return to Normal mode
- `Esc` — discard edit, return to Normal mode
- `Backspace` — delete last character

### Screen layout

```
Stack: feature-branch (4 commits)

  1  abc1234  Add login form          [A: Auth Flow   ]
  2  def5678  Add session handling    [A: Auth Flow   ]
▶ 3  ghi9012  Fix typo in README
  4  jkl3456  Add logout button       [B: Logout      ]

↑↓ cursor  ←→ group  Space grab  r rename  Enter save  q quit
```

## State Machine

```ts
interface CommitRow {
  hash: string;
  commitId: string;           // Spry-Commit-Id
  subject: string;
  groupLetter: string | null; // "A", "B", etc.
}

interface GroupEntry {
  id: string;       // actual group ID from refs or newly generated
  title: string;
  isNew: boolean;   // true if created this session
}

type EditorMode = "normal" | "move" | "rename";

interface GroupEditorState {
  rows: CommitRow[];
  groups: Map<string, GroupEntry>;  // letter → GroupEntry
  cursor: number;
  grabbed: number | null;           // move mode: index of grabbed row
  renameBuffer: string;
  mode: EditorMode;
  conflicts: Set<number>;           // row indices with predicted conflicts
  hasChanges: boolean;
}
```

`extractResult(state): GroupEditorResult` — converts state to the command layer's output type.

## Conflict Prediction

Runs asynchronously in Move mode after every `↑`/`↓` step. The state machine stays pure — the TUI loop calls `predictRebaseConflicts` then feeds a synthetic `conflicts-updated` event back into state. Movement is instant; conflict highlights catch up on the next tick. Conflicted rows show `⚠` and dim red. Non-blocking — user can drop a conflicting commit anyway.

Only reorder changes trigger prediction. Group assignment changes (`←`/`→`) do not.

## PR Adoption

Resolved in `group.ts` after `extractResult()`, before writing records. The TUI has no PR knowledge.

- **No existing PRs** — proceed silently with the generated group ID.
- **Exactly one PR** — adopt that PR's branch ID automatically; print `↻ adopted PR #N for group A`.
- **Multiple PRs** — post-TUI prompt via `src/tui/select.ts` to pick which PR to adopt; others are orphaned for the user to handle via `sp sync`.
- **gh unavailable** — skip adoption, print hint, continue with fresh ID.

## Testing Strategy

Lean on integration and doc tests. Unit test only code paths not reachable from those.

**Integration tests (`tests/commands/group.test.ts`):** real repo via `createRepo`, stub gh client. Cover: no-op (no changes), group assignment written to `refs/spry/groups`, reorder rewrites commit chain, PR adoption (single PR via stub), gh unavailable fallback.

**Doc tests (`tests/commands/group.doc.test.ts`):** TUI screens via `TerminalDriver` + `doc.screen(snapshot)`. Cover: grouping two commits, renaming a group, reordering with conflict warning.

**TUI harness (`tests/fixtures/group-tui-harness.ts`):** thin script that constructs a stub `SpryContext` + pre-built `GroupRecords`, calls the editor. Used by both doc tests and any targeted TUI integration tests.

**Unit tests:** only for state machine edge cases not exercised by integration tests (e.g. dissolve-last-member, conflict snap-back).

## Cross-Cutting Cleanups (land before sp group feature)

1. **Extract `classifyGhInfraError`** — hoist the duplicated `/no github remotes|not a github/i` regex from `src/gh/enrich.ts` and `src/commands/sync.ts` to `src/gh/errors.ts`.

2. **Unify `CommitInfo.trailers` / `CommitTrailers`** — both are `Record<string, string>`; delete the `commitsToInfos` shim in `src/commands/sync.ts` and merge the types.
