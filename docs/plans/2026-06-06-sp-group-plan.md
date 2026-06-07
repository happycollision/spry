# sp group Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `sp group` — an interactive TUI that lets users assign commits to named groups, reorder commits, and set group titles, with results persisted as JSON records in `refs/spry/groups`.

**Architecture:** Pure state machine (`group-state.ts`) + pure renderer (`group-render.ts`) + TUI event loop (`group-editor.ts`) + command orchestrator (`group.ts`). Groups are stored in `refs/spry/groups` (not commit trailers), so grouping never rewrites commits — only reordering does.

**Tech Stack:** Bun, TypeScript, raw-mode stdin for keypress handling, `checkReorderConflicts` from `src/git/conflict.ts` for async conflict prediction, `rewriteCommitChain` + `finalizeRewrite` from `src/git/plumbing.ts` for reordering, `saveAllGroupRecords` (new) in `src/git/group-titles.ts`.

**Design doc:** `docs/plans/2026-06-06-sp-group-design.md`

**Note:** Both cross-cutting cleanups from the memory notes (`classifyGhInfraError` extraction, `CommitInfo`/`CommitTrailers` type unification) are already done. Skip them.

---

## Task 1: Add `saveAllGroupRecords` to group-titles.ts

The command needs to write the full set of group records atomically (replacing any previously stored records). The existing `saveGroupRecord` only upserts one at a time.

**Files:**

- Modify: `src/git/group-titles.ts`
- Modify: `src/git/index.ts`

**Step 1: Add `saveAllGroupRecords` to group-titles.ts**

Add after `saveGroupRecord`:

```ts
export async function saveAllGroupRecords(
  git: GitRunner,
  records: GroupRecords,
  opts?: GitOpts,
): Promise<void> {
  const entries: string[] = [];

  for (const [groupId, record] of Object.entries(records)) {
    const content = JSON.stringify(record);
    const blob = await git.run(["hash-object", "-w", "--stdin"], { ...opts, stdin: content });
    if (blob.exitCode !== 0)
      throw new Error(`saveAllGroupRecords: hash-object failed: ${blob.stderr}`);
    entries.push(`100644 blob ${blob.stdout.trim()}\t${groupId}`);
  }

  const treeInput = entries.length > 0 ? entries.join("\n") + "\n" : "";
  const tree = await git.run(["mktree"], { ...opts, stdin: treeInput });
  if (tree.exitCode !== 0)
    throw new Error(`saveAllGroupRecords: mktree failed: ${tree.stderr}`);
  const treeSha = tree.stdout.trim();

  const commitArgs = ["commit-tree", treeSha, "-m", "update group records"];
  const parent = await git.run(["rev-parse", "--verify", GROUPS_REF], opts);
  if (parent.exitCode === 0) commitArgs.push("-p", parent.stdout.trim());
  const commit = await git.run(commitArgs, opts);
  if (commit.exitCode !== 0)
    throw new Error(`saveAllGroupRecords: commit-tree failed: ${commit.stderr}`);

  const ref = await git.run(["update-ref", GROUPS_REF, commit.stdout.trim()], opts);
  if (ref.exitCode !== 0)
    throw new Error(`saveAllGroupRecords: update-ref failed: ${ref.stderr}`);
}
```

**Step 2: Export from `src/git/index.ts`**

Add `saveAllGroupRecords` to the existing group-titles export line:

```ts
export {
  loadGroupRecords,
  saveGroupRecord,
  saveAllGroupRecords,
  fetchGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
} from "./group-titles.ts";
```

**Step 3: Run existing group-titles tests to confirm no breakage**

Run: `bun run test:docker tests/git/group-titles.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/git/group-titles.ts src/git/index.ts
git commit -m "feat(group-titles): add saveAllGroupRecords for atomic write"
```

---

## Task 2: State machine (`src/tui/group-state.ts`)

Pure functions only — no I/O, no git calls. All keyboard events are `(state, event) → state`.

**Files:**

- Create: `src/tui/group-state.ts`

**Step 1: Create `src/tui/group-state.ts`**

```ts
import { generateCommitId } from "../parse/id.ts";
import type { GroupRecords } from "../parse/types.ts";
import type { CommitWithTrailers } from "../parse/stack.ts";

export interface CommitRow {
  hash: string;
  commitId: string;
  subject: string;
  groupLetter: string | null;
}

export interface GroupEntry {
  id: string;
  title: string;
  isNew: boolean;
}

export type EditorMode = "normal" | "move" | "rename";

export interface GroupEditorState {
  rows: CommitRow[];
  groups: Map<string, GroupEntry>; // letter → GroupEntry
  cursor: number;
  grabbed: number | null;
  grabbedOrigin: number | null;
  renameBuffer: string;
  mode: EditorMode;
  conflicts: Set<number>; // row indices with predicted conflicts
  hasChanges: boolean;
  originalOrder: string[]; // commit hashes in order at session start
}

export type EditorEvent =
  | { type: "arrow-up" }
  | { type: "arrow-down" }
  | { type: "arrow-left" }
  | { type: "arrow-right" }
  | { type: "space" }
  | { type: "enter" }
  | { type: "escape" }
  | { type: "char"; char: string }
  | { type: "backspace" }
  | { type: "conflicts-updated"; conflicts: Set<number> };

export interface GroupEditorResult {
  newOrder: string[] | null; // null if commit order unchanged
  updatedRecords: GroupRecords;
  cancelled: boolean;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function createInitialState(
  commits: CommitWithTrailers[],
  groupRecords: GroupRecords,
): GroupEditorState {
  // Map commitId → groupId from stored records
  const commitToGroupId: Record<string, string> = {};
  for (const [groupId, record] of Object.entries(groupRecords)) {
    for (const memberId of record.members) {
      commitToGroupId[memberId] = groupId;
    }
  }

  // Assign letters to groups in order of first appearance
  const groupIdToLetter = new Map<string, string>();
  const groups = new Map<string, GroupEntry>();
  let letterIdx = 0;

  for (const commit of commits) {
    const commitId = commit.trailers["Spry-Commit-Id"];
    if (!commitId) continue;
    const groupId = commitToGroupId[commitId];
    if (!groupId || groupIdToLetter.has(groupId)) continue;
    const letter = LETTERS[letterIdx++];
    if (!letter) break; // exhausted A-Z
    groupIdToLetter.set(groupId, letter);
    const record = groupRecords[groupId]!;
    groups.set(letter, { id: groupId, title: record.title, isNew: false });
  }

  const rows: CommitRow[] = commits.map((commit) => {
    const commitId = commit.trailers["Spry-Commit-Id"] ?? "";
    const groupId = commitId ? commitToGroupId[commitId] : undefined;
    const groupLetter = groupId ? (groupIdToLetter.get(groupId) ?? null) : null;
    return { hash: commit.hash, commitId, subject: commit.subject, groupLetter };
  });

  return {
    rows,
    groups,
    cursor: 0,
    grabbed: null,
    grabbedOrigin: null,
    renameBuffer: "",
    mode: "normal",
    conflicts: new Set(),
    hasChanges: false,
    originalOrder: commits.map((c) => c.hash),
  };
}

export function applyEvent(state: GroupEditorState, event: EditorEvent): GroupEditorState {
  switch (state.mode) {
    case "normal":
      return applyNormal(state, event);
    case "move":
      return applyMove(state, event);
    case "rename":
      return applyRename(state, event);
  }
}

function applyNormal(state: GroupEditorState, event: EditorEvent): GroupEditorState {
  if (event.type === "arrow-up") {
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  }
  if (event.type === "arrow-down") {
    return { ...state, cursor: Math.min(state.rows.length - 1, state.cursor + 1) };
  }
  if (event.type === "arrow-right") return advanceGroup(state);
  if (event.type === "arrow-left") return retreatGroup(state);
  if (event.type === "space") {
    if (state.rows.length === 0) return state;
    return { ...state, mode: "move", grabbed: state.cursor, grabbedOrigin: state.cursor };
  }
  if (event.type === "char" && event.char === "r") {
    const row = state.rows[state.cursor];
    if (!row?.groupLetter) return state;
    const entry = state.groups.get(row.groupLetter);
    if (!entry) return state;
    return { ...state, mode: "rename", renameBuffer: entry.title };
  }
  if (event.type === "conflicts-updated") {
    return { ...state, conflicts: event.conflicts };
  }
  return state;
}

function advanceGroup(state: GroupEditorState): GroupEditorState {
  const row = state.rows[state.cursor];
  if (!row) return state;

  const sortedLetters = [...state.groups.keys()].sort();
  const newGroups = new Map(state.groups);
  let targetLetter: string;

  if (row.groupLetter === null) {
    if (sortedLetters.length === 0) {
      // No groups yet — create A
      newGroups.set("A", { id: generateCommitId(), title: "", isNew: true });
      targetLetter = "A";
    } else {
      // Join the first existing group
      targetLetter = sortedLetters[0]!;
    }
  } else {
    const idx = sortedLetters.indexOf(row.groupLetter);
    if (idx === sortedLetters.length - 1) {
      // At last group — create next letter
      const nextLetter = LETTERS[LETTERS.indexOf(row.groupLetter) + 1];
      if (!nextLetter) return state; // at Z, can't advance further
      newGroups.set(nextLetter, { id: generateCommitId(), title: "", isNew: true });
      targetLetter = nextLetter;
    } else {
      // Move to next existing group
      targetLetter = sortedLetters[idx + 1]!;
    }
    // Dissolve old group if this was its last member
    maybeDissolve(newGroups, state.rows, state.cursor, row.groupLetter);
  }

  const newRows = state.rows.map((r, i) =>
    i === state.cursor ? { ...r, groupLetter: targetLetter } : r,
  );
  return { ...state, rows: newRows, groups: newGroups, hasChanges: true };
}

function retreatGroup(state: GroupEditorState): GroupEditorState {
  const row = state.rows[state.cursor];
  if (!row || row.groupLetter === null) return state;

  const sortedLetters = [...state.groups.keys()].sort();
  const idx = sortedLetters.indexOf(row.groupLetter);
  const newGroups = new Map(state.groups);

  maybeDissolve(newGroups, state.rows, state.cursor, row.groupLetter);

  const targetLetter = idx === 0 ? null : (sortedLetters[idx - 1] ?? null);
  const newRows = state.rows.map((r, i) =>
    i === state.cursor ? { ...r, groupLetter: targetLetter } : r,
  );
  return { ...state, rows: newRows, groups: newGroups, hasChanges: true };
}

function maybeDissolve(
  groups: Map<string, GroupEntry>,
  rows: CommitRow[],
  excludeIdx: number,
  letter: string,
): void {
  const remaining = rows.filter((r, i) => i !== excludeIdx && r.groupLetter === letter);
  if (remaining.length === 0) groups.delete(letter);
}

function applyMove(state: GroupEditorState, event: EditorEvent): GroupEditorState {
  if (event.type === "arrow-up") {
    const g = state.grabbed;
    if (g === null || g === 0) return state;
    const rows = [...state.rows];
    [rows[g - 1], rows[g]] = [rows[g]!, rows[g - 1]!];
    return { ...state, rows, grabbed: g - 1, cursor: g - 1, hasChanges: true, conflicts: new Set() };
  }
  if (event.type === "arrow-down") {
    const g = state.grabbed;
    if (g === null || g === state.rows.length - 1) return state;
    const rows = [...state.rows];
    [rows[g], rows[g + 1]] = [rows[g + 1]!, rows[g]!];
    return { ...state, rows, grabbed: g + 1, cursor: g + 1, hasChanges: true, conflicts: new Set() };
  }
  if (event.type === "space" || event.type === "enter") {
    return { ...state, mode: "normal", grabbed: null, grabbedOrigin: null };
  }
  if (event.type === "escape") {
    const g = state.grabbed;
    const origin = state.grabbedOrigin;
    if (g === null || origin === null) {
      return { ...state, mode: "normal", grabbed: null, grabbedOrigin: null };
    }
    // Splice grabbed row back to its origin
    const rows = [...state.rows];
    const [grabbedRow] = rows.splice(g, 1);
    if (grabbedRow) rows.splice(origin, 0, grabbedRow);
    const orderChanged = rows.some((r, i) => r.hash !== state.originalOrder[i]);
    return {
      ...state,
      rows,
      mode: "normal",
      grabbed: null,
      grabbedOrigin: null,
      cursor: origin,
      hasChanges: orderChanged,
      conflicts: new Set(),
    };
  }
  if (event.type === "conflicts-updated") {
    return { ...state, conflicts: event.conflicts };
  }
  return state;
}

function applyRename(state: GroupEditorState, event: EditorEvent): GroupEditorState {
  if (event.type === "char") {
    return { ...state, renameBuffer: state.renameBuffer + event.char };
  }
  if (event.type === "backspace") {
    return { ...state, renameBuffer: state.renameBuffer.slice(0, -1) };
  }
  if (event.type === "enter") {
    const row = state.rows[state.cursor];
    if (!row?.groupLetter) return { ...state, mode: "normal", renameBuffer: "" };
    const entry = state.groups.get(row.groupLetter);
    if (!entry) return { ...state, mode: "normal", renameBuffer: "" };
    const newGroups = new Map(state.groups);
    newGroups.set(row.groupLetter, { ...entry, title: state.renameBuffer });
    return { ...state, groups: newGroups, mode: "normal", renameBuffer: "", hasChanges: true };
  }
  if (event.type === "escape") {
    return { ...state, mode: "normal", renameBuffer: "" };
  }
  return state;
}

export function extractResult(state: GroupEditorState): GroupEditorResult {
  const currentHashes = state.rows.map((r) => r.hash);
  const orderChanged = currentHashes.some((h, i) => h !== state.originalOrder[i]);

  const updatedRecords: GroupRecords = {};
  for (const [letter, entry] of state.groups) {
    const members = state.rows
      .filter((r) => r.groupLetter === letter && r.commitId)
      .map((r) => r.commitId);
    updatedRecords[entry.id] = { title: entry.title, members };
  }

  return {
    newOrder: orderChanged ? currentHashes : null,
    updatedRecords,
    cancelled: false,
  };
}
```

**Step 2: Run type check**

Run: `bun run check`
Expected: no errors in group-state.ts

**Step 3: Commit**

```bash
git add src/tui/group-state.ts
git commit -m "feat(group-state): add pure state machine for group editor"
```

---

## Task 3: Renderer (`src/tui/group-render.ts`)

Pure function — `(state, branch) → string`. No I/O. Tested via doc test screen captures.

**Files:**

- Create: `src/tui/group-render.ts`

**Step 1: Create `src/tui/group-render.ts`**

```ts
import kleur from "kleur";
import type { GroupEditorState } from "./group-state.ts";

const ESC = "\x1b";
export const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;

export function renderGroupEditor(state: GroupEditorState, branch: string): string {
  const lines: string[] = [];

  lines.push(`Stack: ${branch} (${state.rows.length} commit${state.rows.length === 1 ? "" : "s"})`);
  lines.push("");

  for (let i = 0; i < state.rows.length; i++) {
    const row = state.rows[i]!;
    const isCursor = i === state.cursor;
    const isGrabbed = i === state.grabbed;
    const hasConflict = state.conflicts.has(i);

    const prefix = isGrabbed ? kleur.yellow("●") : isCursor ? kleur.cyan("▶") : " ";
    const num = String(i + 1).padStart(2);
    const hash = kleur.dim(row.hash.slice(0, 7));
    const subject = row.subject.slice(0, 40).padEnd(40);

    let groupTag = "";
    if (row.groupLetter) {
      const entry = state.groups.get(row.groupLetter);
      if (entry) {
        const titleDisplay =
          state.mode === "rename" && isCursor
            ? state.renameBuffer + "▌"
            : entry.title || kleur.dim("(no title)");
        groupTag = ` [${row.groupLetter}: ${titleDisplay}]`;
      }
    }

    const conflictMarker = hasConflict ? " " + kleur.red("⚠") : "";
    const rowText = `${prefix} ${num}  ${hash}  ${subject}${groupTag}${conflictMarker}`;
    lines.push(isGrabbed ? kleur.yellow(rowText) : rowText);
  }

  lines.push("");

  if (state.mode === "move") {
    lines.push(kleur.cyan("MOVE MODE") + kleur.dim(" — ↑↓ reorder  Space/Enter drop  Esc cancel"));
    if (state.conflicts.size > 0) {
      lines.push(kleur.red("⚠ Moving this commit may cause a conflict"));
    }
  } else if (state.mode === "rename") {
    lines.push(kleur.cyan("RENAME MODE") + kleur.dim(" — Type title  Enter confirm  Esc cancel"));
  } else {
    lines.push(kleur.dim("↑↓ cursor  ←→ group  Space grab  r rename  Enter save  q quit"));
  }

  return CLEAR_SCREEN + HIDE_CURSOR + lines.join("\n");
}
```

**Step 2: Run type check**

Run: `bun run check`
Expected: no errors

**Step 3: Commit**

```bash
git add src/tui/group-render.ts
git commit -m "feat(group-render): add pure renderer for group editor"
```

---

## Task 4: TUI editor loop (`src/tui/group-editor.ts`)

Handles raw-mode stdin, maps keypresses to events, runs async conflict prediction, returns `GroupEditorResult`.

**Files:**

- Create: `src/tui/group-editor.ts`

**Step 1: Create `src/tui/group-editor.ts`**

```ts
import { getMergeBase, checkReorderConflicts } from "../git/index.ts";
import type { GitRunner } from "../lib/context.ts";
import type { CommitWithTrailers } from "../parse/stack.ts";
import type { GroupRecords } from "../parse/types.ts";
import {
  createInitialState,
  applyEvent,
  extractResult,
} from "./group-state.ts";
import type { GroupEditorResult, GroupEditorState, EditorEvent } from "./group-state.ts";
import { renderGroupEditor, SHOW_CURSOR } from "./group-render.ts";

export interface GroupEditorOptions {
  branch: string;
  trunkRef: string;
  cwd?: string;
}

export async function runGroupEditor(
  git: GitRunner,
  commits: CommitWithTrailers[],
  groupRecords: GroupRecords,
  opts: GroupEditorOptions,
): Promise<GroupEditorResult> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    throw new Error("sp group requires an interactive terminal (stdin is not a TTY)");
  }

  const mergeBase = await getMergeBase(git, opts.trunkRef, { cwd: opts.cwd });
  const originalHashes = commits.map((c) => c.hash);

  let state = createInitialState(commits, groupRecords);

  function render(): void {
    stdout.write(renderGroupEditor(state, opts.branch));
  }

  async function updateConflicts(currentState: GroupEditorState): Promise<void> {
    const currentHashes = currentState.rows.map((r) => r.hash);
    try {
      const conflictMap = await checkReorderConflicts(
        git,
        originalHashes,
        currentHashes,
        mergeBase,
        { cwd: opts.cwd },
      );
      const conflictIndices = new Set<number>();
      for (const key of conflictMap.keys()) {
        const [hashA, hashB] = key.split(":");
        state.rows.forEach((r, i) => {
          if (r.hash === hashA || r.hash === hashB) conflictIndices.add(i);
        });
      }
      state = applyEvent(state, { type: "conflicts-updated", conflicts: conflictIndices });
      render();
    } catch {
      // conflict prediction is best-effort — ignore errors
    }
  }

  let cleanedUp = false;
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    stdout.write(SHOW_CURSOR + "\n");
    stdin.setRawMode?.(false);
    stdin.pause();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  function onSignal(): void {
    cleanup();
    process.exit(130);
  }

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  stdin.setRawMode?.(true);
  stdin.resume();
  render();

  return new Promise<GroupEditorResult>((resolve) => {
    function onData(chunk: Buffer): void {
      const keys = parseKeys(chunk.toString());

      for (const key of keys) {
        if (state.mode === "normal") {
          if (key === "\r" || key === "\n") {
            stdin.off("data", onData);
            cleanup();
            resolve(extractResult(state));
            return;
          }
          if (key === "q" || key === "\x03" || key === "\x1b") {
            stdin.off("data", onData);
            cleanup();
            resolve({ newOrder: null, updatedRecords: {}, cancelled: true });
            return;
          }
        }

        const event = keyToEvent(key);
        if (!event) continue;

        const prevGrabbed = state.grabbed;
        state = applyEvent(state, event);

        // Trigger conflict prediction after each move step
        if (state.mode === "move" && state.grabbed !== prevGrabbed) {
          updateConflicts(state).catch(() => {});
        }
      }

      render();
    }

    stdin.on("data", onData);
  }).finally(cleanup);
}

function parseKeys(data: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === "\x1b" && data[i + 1] === "[" && i + 2 < data.length) {
      keys.push(data.slice(i, i + 3));
      i += 3;
    } else {
      keys.push(ch);
      i++;
    }
  }
  return keys;
}

function keyToEvent(key: string): EditorEvent | null {
  if (key === "\x1b[A") return { type: "arrow-up" };
  if (key === "\x1b[B") return { type: "arrow-down" };
  if (key === "\x1b[C") return { type: "arrow-right" };
  if (key === "\x1b[D") return { type: "arrow-left" };
  if (key === " ") return { type: "space" };
  if (key === "\r" || key === "\n") return { type: "enter" };
  if (key === "\x1b") return { type: "escape" };
  if (key === "\x7f") return { type: "backspace" };
  if (key.length === 1 && key >= " ") return { type: "char", char: key };
  return null;
}
```

**Step 2: Run type check**

Run: `bun run check`
Expected: no errors

**Step 3: Commit**

```bash
git add src/tui/group-editor.ts
git commit -m "feat(group-editor): add TUI main loop with conflict prediction"
```

---

## Task 5: Command handler (`src/commands/group.ts`)

Orchestrates: load config + stack + records → PR enrichment → TUI → apply result.

**Files:**

- Create: `src/commands/group.ts`

**Step 1: Create `src/commands/group.ts`**

```ts
import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import {
  loadConfig,
  trunkRef,
  getCurrentBranch,
  getStackCommits,
  injectMissingIds,
  saveAllGroupRecords,
  fetchGroupRecords,
  loadGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
  rewriteCommitChain,
  finalizeRewrite,
  branchForUnit,
} from "../git/index.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { findPRsForBranches, classifyGhInfraError } from "../gh/index.ts";
import type { PRInfo } from "../gh/index.ts";
import { runGroupEditor } from "../tui/group-editor.ts";
import { selectUnits } from "../tui/index.ts";
import type { PRUnit } from "../parse/types.ts";
import type { GroupRecords } from "../parse/types.ts";
import type { SpryConfig } from "../git/config.ts";

export interface GroupOptions {
  cwd?: string;
}

export async function groupCommand(ctx: SpryContext, opts: GroupOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });
  const branch = await getCurrentBranch(ctx.git, { cwd });
  const ref = trunkRef(config);

  // Inject missing IDs so all commits are groupable
  const inject = await injectMissingIds(ctx.git, ref, { cwd });
  if (!inject.ok) {
    console.error("✗ Cannot run from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }

  const commits = await getStackCommits(ctx.git, ref, { cwd });
  if (commits.length === 0) {
    console.log("No commits in stack.");
    return;
  }

  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });

  // Fetch + load group records
  const fetchResult = await fetchGroupRecords(ctx.git, config.remote, { cwd });
  if (!fetchResult.ok) {
    console.log(kleur.dim(`⚠ Could not fetch group records: ${fetchResult.warning}`));
  }
  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);

  // Build units for PR adoption detection (proceed even if stack has errors)
  const stackResult = parseStack(withTrailers, groupTitles, commitGroups);
  const units: PRUnit[] = stackResult.ok ? stackResult.units : [];

  // Fetch existing PRs (best-effort for adoption prompt)
  let prsByBranch = new Map<string, PRInfo | null>();
  if (units.length > 0) {
    try {
      const branches = units.map((u) => branchForUnit(u, config));
      prsByBranch = await findPRsForBranches(ctx, branches);
    } catch (err) {
      const kind = classifyGhInfraError(err);
      if (kind !== "network") {
        console.log(kleur.dim("PR adoption unavailable: gh not available"));
      }
    }
  }

  // Launch TUI
  const result = await runGroupEditor(ctx.git, withTrailers, groupRecords, {
    branch,
    trunkRef: ref,
    cwd,
  });

  if (result.cancelled) {
    console.log("Cancelled.");
    return;
  }

  // Resolve PR adoption for newly-created groups
  const resolvedRecords = await adoptPRs(
    result.updatedRecords,
    groupRecords,
    units,
    prsByBranch,
    config,
  );

  // Reorder commits if the stack order changed
  if (result.newOrder) {
    const oldTip = withTrailers.at(-1)?.hash;
    if (!oldTip) throw new Error("groupCommand: unexpected empty commit list");
    const rewriteResult = await rewriteCommitChain(ctx.git, result.newOrder, new Map(), { cwd });
    await finalizeRewrite(ctx.git, branch, oldTip, rewriteResult.newTip, { cwd });
    console.log(`✓ Reordered ${result.newOrder.length} commits`);
  }

  // Write all group records atomically
  await saveAllGroupRecords(ctx.git, resolvedRecords, { cwd });

  // Push refs/spry/groups best-effort
  const pushResult = await ctx.git.run(
    ["push", config.remote, "refs/spry/groups:refs/spry/groups"],
    { cwd },
  );
  if (pushResult.exitCode !== 0) {
    console.log(kleur.dim("⚠ Could not push group records to remote (local changes saved)"));
  }

  const groupCount = Object.keys(resolvedRecords).length;
  console.log(`✓ Groups updated (${groupCount} group${groupCount === 1 ? "" : "s"})`);
}

async function adoptPRs(
  updatedRecords: GroupRecords,
  originalRecords: GroupRecords,
  units: PRUnit[],
  prsByBranch: Map<string, PRInfo | null>,
  config: SpryConfig,
): Promise<GroupRecords> {
  const originalIds = new Set(Object.keys(originalRecords));
  const result: GroupRecords = {};

  for (const [groupId, record] of Object.entries(updatedRecords)) {
    if (originalIds.has(groupId)) {
      // Existing group — keep as-is
      result[groupId] = record;
      continue;
    }

    // New group — check if any member commits had open PRs
    const memberUnits = units.filter(
      (u) => u.type === "single" && record.members.includes(u.id),
    );
    const openPRUnits = memberUnits.filter((u) => {
      const br = branchForUnit(u, config);
      const pr = prsByBranch.get(br);
      return pr?.state === "OPEN";
    });

    if (openPRUnits.length === 0) {
      result[groupId] = record;
    } else if (openPRUnits.length === 1) {
      const adopted = openPRUnits[0]!;
      console.log(kleur.dim(`↻ adopted PR for group (unit ${adopted.id.slice(0, 8)})`));
      result[adopted.id] = record;
    } else {
      // Multiple open PRs — prompt user to pick one
      const options = openPRUnits.map((u) => ({
        id: u.id,
        label: `PR for ${u.id.slice(0, 8)}: ${u.title ?? "(untitled)"}`,
      }));
      const selection = await selectUnits(options, {
        title: "Multiple commits in this group have open PRs. Which PR should the group adopt?",
      });
      if (!selection.cancelled && selection.selectedIds.length > 0) {
        const adoptedId = selection.selectedIds[0]!;
        console.log(kleur.dim(`↻ adopted PR for group (unit ${adoptedId.slice(0, 8)})`));
        result[adoptedId] = record;
      } else {
        result[groupId] = record;
      }
    }
  }

  return result;
}
```

**Step 2: Run type check**

Run: `bun run check`
Expected: no errors

**Step 3: Commit**

```bash
git add src/commands/group.ts
git commit -m "feat(group): add groupCommand orchestrator"
```

---

## Task 6: Wire CLI and update exports

**Files:**

- Modify: `src/cli/index.ts`
- Modify: `src/tui/index.ts`

**Step 1: Add `sp group` to `src/cli/index.ts`**

Add after the sync command block:

```ts
import { groupCommand } from "../commands/group.ts";
```

And add the command:

```ts
program
  .command("group")
  .description("Interactively group and reorder commits")
  .action(() => groupCommand(ctx));
```

**Step 2: Export from `src/tui/index.ts`**

The file currently only exports `selectUnits`. No new exports needed from tui/index.ts for the command layer — `runGroupEditor` is imported directly by `group.ts`. Leave `src/tui/index.ts` as-is.

**Step 3: Run type check and all tests**

Run: `bun run check`
Run: `bun run test:docker`
Expected: PASS

**Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): wire sp group command"
```

---

## Task 7: TUI test harness (`tests/fixtures/group-tui-harness.ts`)

Thin script that the `TerminalDriver` spawns. Accepts `<repo-cwd>` as argv[2] and calls `groupCommand` with a stub gh client (returns no PRs by default).

**Files:**

- Create: `tests/fixtures/group-tui-harness.ts`

**Step 1: Create `tests/fixtures/group-tui-harness.ts`**

```ts
#!/usr/bin/env bun
import { groupCommand } from "../../src/commands/group.ts";
import { createRealGitRunner } from "../lib/index.ts";
import type { GhClient, CommandOptions, CommandResult, SpryContext } from "../lib/index.ts";

const cwd = process.argv[2];
if (!cwd) {
  console.error("Usage: group-tui-harness.ts <repo-cwd>");
  process.exit(1);
}

const gh: GhClient = {
  async run(_args: string[], _opts?: CommandOptions): Promise<CommandResult> {
    return {
      stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
      stderr: "",
      exitCode: 0,
    };
  },
};

const runner = createRealGitRunner();
const ctx: SpryContext = {
  git: {
    run: (args: string[], opts?: { cwd?: string }) =>
      runner.run(args, { ...opts, cwd: opts?.cwd ?? cwd }),
  },
  gh,
};

await groupCommand(ctx, { cwd });
```

**Step 2: Commit**

```bash
git add tests/fixtures/group-tui-harness.ts
git commit -m "test(fixtures): add group TUI harness for TerminalDriver tests"
```

---

## Task 8: Integration and doc tests

**Files:**

- Create: `tests/commands/group.test.ts`
- Create: `tests/commands/group.doc.test.ts`

### Integration tests (`group.test.ts`)

These tests drive the TUI harness via `TerminalDriver` and verify the correct git state after completion.

**Step 1: Create `tests/commands/group.test.ts`**

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { createRepo, createRealGitRunner, createTerminalDriver } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";
import { loadGroupRecords } from "../../src/git/group-titles.ts";

const harnessPath = join(import.meta.dir, "../fixtures/group-tui-harness.ts");

const repos: TestRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()!.cleanup();
});

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
  return repo;
}

describe("sp group TUI", () => {
  test("assigns two commits to a group and saves a record", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login form"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add session handling"], { cwd: repo.path });

    // Launch TUI: press → on first row (assign to A), ↓ to second row,
    // → to assign to A, then Enter to save
    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 100,
      rows: 30,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    term.press("ArrowRight"); // assign row 1 to group A
    await Bun.sleep(100);
    term.press("ArrowDown");  // move cursor to row 2
    await Bun.sleep(100);
    term.press("ArrowRight"); // assign row 2 to group A
    await Bun.sleep(100);
    term.press("Enter");      // save
    await term.waitForText("Groups updated", { timeout: 10000 });
    await term.close();

    // Verify group record was saved
    const records = await loadGroupRecords(git, { cwd: repo.path });
    const allRecords = Object.values(records);
    expect(allRecords).toHaveLength(1);
    expect(allRecords[0]!.members).toHaveLength(2);
  });

  test("renames a group", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add auth"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add session"], { cwd: repo.path });

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 100,
      rows: 30,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    term.press("ArrowRight"); // assign row 1 to A
    await Bun.sleep(100);
    term.press("ArrowDown");
    await Bun.sleep(100);
    term.press("ArrowRight"); // assign row 2 to A
    await Bun.sleep(100);
    term.type("r");           // enter rename mode
    await Bun.sleep(100);
    term.type("Auth Flow");   // type the title
    await Bun.sleep(100);
    term.press("Enter");      // confirm rename
    await Bun.sleep(100);
    term.press("Enter");      // save editor
    await term.waitForText("Groups updated", { timeout: 10000 });
    await term.close();

    const records = await loadGroupRecords(git, { cwd: repo.path });
    const allRecords = Object.values(records);
    expect(allRecords).toHaveLength(1);
    expect(allRecords[0]!.title).toBe("Auth Flow");
  });

  test("cancelling with q writes no records", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add feature"], { cwd: repo.path });

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 100,
      rows: 30,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    term.press("ArrowRight"); // assign to group A
    await Bun.sleep(100);
    term.type("q");           // cancel
    await term.waitForText("Cancelled", { timeout: 5000 });
    await term.close();

    const records = await loadGroupRecords(git, { cwd: repo.path });
    expect(Object.keys(records)).toHaveLength(0);
  });

  test("reordering two commits rewrites the git history", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "First commit"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Second commit"], { cwd: repo.path });

    // Get original order
    const logBefore = await git.run(
      ["log", "--reverse", "--format=%s", "main..HEAD"],
      { cwd: repo.path },
    );
    expect(logBefore.stdout.trim()).toBe("First commit\nSecond commit");

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 100,
      rows: 30,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    term.press("ArrowDown");  // move cursor to second commit
    await Bun.sleep(100);
    term.press(" ");          // grab it
    await Bun.sleep(100);
    term.press("ArrowUp");    // move it up
    await Bun.sleep(100);
    term.press(" ");          // drop it
    await Bun.sleep(100);
    term.press("Enter");      // save
    await term.waitForText("Reordered", { timeout: 10000 });
    await term.close();

    const logAfter = await git.run(
      ["log", "--reverse", "--format=%s", "main..HEAD"],
      { cwd: repo.path },
    );
    expect(logAfter.stdout.trim()).toBe("Second commit\nFirst commit");
  });
});
```

**Step 2: Run integration tests**

Run: `bun run test:docker tests/commands/group.test.ts`
Expected: PASS (all 4 tests)

### Doc tests (`group.doc.test.ts`)

**Step 3: Create `tests/commands/group.doc.test.ts`**

```ts
import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import {
  docTest,
  createRepo,
  createRealGitRunner,
  createTerminalDriver,
} from "../lib/index.ts";

const harnessPath = join(import.meta.dir, "../fixtures/group-tui-harness.ts");

const repos: Array<{ cleanup(): Promise<void> }> = [];
afterAll(async () => {
  for (const repo of repos) await repo.cleanup();
});

describe("sp group docs", () => {
  docTest(
    "Grouping commits",
    { section: "commands/group", order: 10 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });
      await git.run(["checkout", "-b", "feature/auth"], { cwd: repo.path });
      await git.run(["commit", "--allow-empty", "-m", "Add login form"], { cwd: repo.path });
      await git.run(["commit", "--allow-empty", "-m", "Add session handling"], { cwd: repo.path });
      await git.run(["commit", "--allow-empty", "-m", "Fix typo in README"], { cwd: repo.path });

      doc.prose(
        "Run `sp group` to open the interactive group editor. Use ↑↓ to move between commits and ←→ to assign or remove group membership. Commits in the same group ship as a single PR.",
      );

      const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
        cols: 80,
        rows: 20,
      });

      // Wait for editor to appear, capture the initial screen
      await term.waitForText("Stack:", { timeout: 15000 });
      await Bun.sleep(200);

      // Assign first two commits to group A
      term.press("ArrowRight");
      await Bun.sleep(150);
      term.press("ArrowDown");
      await Bun.sleep(150);
      term.press("ArrowRight");
      await Bun.sleep(150);

      // Rename the group
      term.type("r");
      await Bun.sleep(150);
      term.type("Auth Flow");
      await Bun.sleep(150);
      term.press("Enter");
      await Bun.sleep(150);

      const { expect } = await import("bun:test");
      await term.waitForText("Auth Flow", { timeout: 3000 });
      const snapshot = term.capture();
      doc.screen(snapshot);

      // Save
      term.press("Enter");
      await term.waitForText("Groups updated", { timeout: 10000 });
      await term.close();

      expect(snapshot.text).toContain("Auth Flow");
    },
  );

  docTest(
    "Reordering commits",
    { section: "commands/group", order: 20 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });
      await git.run(["checkout", "-b", "feature/auth"], { cwd: repo.path });
      await git.run(["commit", "--allow-empty", "-m", "Add login form"], { cwd: repo.path });
      await git.run(["commit", "--allow-empty", "-m", "Add session handling"], { cwd: repo.path });

      doc.prose(
        "Press Space to grab a commit and ↑↓ to reorder it. Spry predicts rebase conflicts as you move — rows with ⚠ may conflict. Press Space or Enter to drop the commit at its new position.",
      );

      const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
        cols: 80,
        rows: 20,
      });

      await term.waitForText("Stack:", { timeout: 15000 });
      await Bun.sleep(200);

      // Grab the second commit and move it up
      term.press("ArrowDown");
      await Bun.sleep(150);
      term.press(" "); // grab
      await Bun.sleep(150);
      term.press("ArrowUp"); // move up
      await Bun.sleep(300); // wait for conflict prediction

      const { expect } = await import("bun:test");
      const snapshot = term.capture();
      doc.screen(snapshot);
      expect(snapshot.text).toContain("MOVE MODE");

      term.press(" "); // drop
      await Bun.sleep(100);
      term.press("Enter"); // save
      await term.waitForText("Reordered", { timeout: 10000 });
      await term.close();
    },
  );
});
```

**Step 4: Run doc tests**

Run: `bun run test:docker tests/commands/group.doc.test.ts`
Expected: PASS

**Step 5: Build docs**

Run: `bun run docs:build`
Expected: `docs/generated/commands/group.md` and `.html` created

**Step 6: Commit**

```bash
git add tests/commands/group.test.ts tests/commands/group.doc.test.ts
git commit -m "test(group): add integration and doc tests for sp group"
```

---

## Task 9: Update CHANGELOG and final check

**Step 1: Add changelog entry to `CHANGELOG.md` under `## [Unreleased]`**

```markdown
- `sp group` command — interactive TUI for grouping, renaming, and reordering commits
  - ↑↓ to move cursor, ←→ to assign/remove group membership
  - Space to grab a commit and reorder via ↑↓; live conflict prediction as you drag
  - `r` to rename the group at the cursor (inline edit mode)
  - Groups saved as JSON records in `refs/spry/groups` — no commit rewrites needed for grouping
  - Reordering rewrites the commit chain via plumbing
  - PR adoption: if commits being grouped already have open PRs, group inherits the PR ID automatically (single PR) or prompts for selection (multiple PRs)
  - Pushes `refs/spry/groups` to the remote after saving (best-effort)
- `saveAllGroupRecords` in `src/git/group-titles.ts` — atomic write of all group records
```

**Step 2: Run full test suite**

Run: `bun run test:docker`
Expected: PASS

**Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "chore: update changelog for sp group (Step 7)"
```
