import { generateCommitId } from "../parse/id.ts";
import type { GroupRecords, CommitMergeGroupMap } from "../parse/types.ts";
import type { CommitWithTrailers } from "../parse/stack.ts";

export interface CommitRow {
  hash: string;
  commitId: string;
  subject: string;
  groupLetter: string | null;
  // The MERGE axis, independent of groupLetter: a lowercase letter naming the
  // merge group this row belongs to, or null. A merge group's rows are always
  // contiguous and contained within one PR unit (see enforceMergeInvariants).
  mergeLetter: string | null;
}

export interface GroupEntry {
  id: string;
  title: string;
  isNew: boolean;
}

// A merge group in the editor model. `message` is the merge commit's message
// (subject + optional body) as edited via $EDITOR; it is written onto the merge
// commit when the group materializes on `enter`.
export interface MergeEntry {
  id: string;
  message: string;
  isNew: boolean;
}

export type EditorMode = "normal" | "move" | "rename";

export interface GroupEditorState {
  rows: CommitRow[];
  groups: Map<string, GroupEntry>; // letter → GroupEntry
  merges: Map<string, MergeEntry>; // lowercase letter → MergeEntry
  cursor: number;
  grabbed: number | null;
  grabbedOrigin: number | null;
  renameBuffer: string;
  mode: EditorMode;
  conflicts: Set<number>; // row indices with predicted conflicts
  hasChanges: boolean;
  originalOrder: string[]; // commit hashes in order at session start
  canReorder: boolean;
  // When set, the cursor is on a MERGE COMMIT's line rather than on a commit
  // row. The merge commit is a real, selectable node: grabbing it moves the
  // whole group, and ⇧← collapses the group. `cursor` still points at the
  // group's first member row (where that line is drawn), so every existing
  // row-indexed operation keeps working unchanged.
  onMergeCommit: string | null; // the merge-group letter, or null
  // Merge groups that blocked the last save attempt, surfaced in the UI until
  // the user resolves them. Empty until `enter` is pressed on an invalid state.
  problems: MergeGroupProblem[];
  // Set by any merge-axis mutation. Because materializing/unmerging rewrites
  // history, `enter` only runs that (expensive, destructive) pass when this is
  // true — an untouched merge axis is left exactly as git already has it.
  mergeDirty: boolean;
}

export type EditorEvent =
  | { type: "arrow-up" }
  | { type: "arrow-down" }
  | { type: "arrow-left" }
  | { type: "arrow-right" }
  | { type: "shift-arrow-up" }
  | { type: "shift-arrow-down" }
  | { type: "shift-arrow-left" }
  | { type: "shift-arrow-right" }
  | { type: "ctrl-arrow-up" }
  | { type: "ctrl-arrow-down" }
  | { type: "space" }
  | { type: "enter" }
  | { type: "escape" }
  | { type: "char"; char: string }
  | { type: "backspace" }
  | { type: "conflicts-updated"; conflicts: Set<number> };

// One merge group's desired final state, as the command layer needs it to drive
// buildMaterializePlan/materialize.
export interface MergeGroupResult {
  id: string;
  memberIds: string[];
  // The merge commit's message. Empty for a group created in this session — the
  // command layer collects it via $EDITOR AFTER the TUI exits (so experimenting
  // with placement is never interrupted), seeding from `firstSubject`.
  message: string;
  // The first member's subject, used to seed the message editor.
  firstSubject: string;
  // True when this group was created in this session and still needs a message.
  needsMessage: boolean;
}

export interface GroupEditorResult {
  newOrder: string[] | null; // null if commit order unchanged
  updatedRecords: GroupRecords;
  // The merge axis: every merge group the user wants after this edit, in stack
  // order. Empty means "no merge groups" (which still unmerges any that existed).
  mergeGroups: MergeGroupResult[];
  // True when the merge axis differs from session start, i.e. history must be
  // rewritten (materialize/unmerge) even if nothing else changed.
  mergeChanged: boolean;
  cancelled: boolean;
}

export interface CreateInitialStateOptions {
  canReorder?: boolean;
  // Existing merge groups: commitId → merge-group id, plus that group's current
  // merge commit message (by merge-group id).
  mergeGroups?: CommitMergeGroupMap;
  mergeMessages?: Record<string, string>;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MERGE_LETTERS = "abcdefghijklmnopqrstuvwxyz";

export function createInitialState(
  commits: CommitWithTrailers[],
  groupRecords: GroupRecords,
  options: CreateInitialStateOptions = {},
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
    const record = groupRecords[groupId];
    if (!record) continue;
    groups.set(letter, { id: groupId, title: record.title, isNew: false });
  }

  // Assign lowercase letters to existing merge groups, in order of first
  // appearance — the merge axis, independent of the PR-group letters above.
  const mergeGroupMap = options.mergeGroups ?? {};
  const mergeMessages = options.mergeMessages ?? {};
  const mergeIdToLetter = new Map<string, string>();
  const merges = new Map<string, MergeEntry>();
  let mergeLetterIdx = 0;

  for (const commit of commits) {
    const commitId = commit.trailers["Spry-Commit-Id"];
    if (!commitId) continue;
    const mergeId = mergeGroupMap[commitId];
    if (!mergeId || mergeIdToLetter.has(mergeId)) continue;
    const letter = MERGE_LETTERS[mergeLetterIdx++];
    if (!letter) break; // exhausted a-z
    mergeIdToLetter.set(mergeId, letter);
    merges.set(letter, { id: mergeId, message: mergeMessages[mergeId] ?? "", isNew: false });
  }

  const rows: CommitRow[] = commits.map((commit) => {
    const commitId = commit.trailers["Spry-Commit-Id"] ?? "";
    const groupId = commitId ? commitToGroupId[commitId] : undefined;
    const groupLetter = groupId ? (groupIdToLetter.get(groupId) ?? null) : null;
    const mergeId = commitId ? mergeGroupMap[commitId] : undefined;
    const mergeLetter = mergeId ? (mergeIdToLetter.get(mergeId) ?? null) : null;
    return { hash: commit.hash, commitId, subject: commit.subject, groupLetter, mergeLetter };
  });

  return {
    rows,
    groups,
    merges,
    cursor: 0,
    grabbed: null,
    grabbedOrigin: null,
    renameBuffer: "",
    mode: "normal",
    conflicts: new Set(),
    hasChanges: false,
    originalOrder: commits.map((c) => c.hash),
    canReorder: options.canReorder ?? true,
    onMergeCommit: null,
    problems: [],
    mergeDirty: false,
  };
}

export function applyEvent(state: GroupEditorState, event: EditorEvent): GroupEditorState {
  const next = applyEventInner(state, event);
  // Any edit invalidates the problems from the last save attempt — they are
  // recomputed on the next `enter`, so a stale complaint never lingers.
  if (next !== state && next.problems === state.problems && state.problems.length > 0) {
    return { ...next, problems: [] };
  }
  return next;
}

function applyEventInner(state: GroupEditorState, event: EditorEvent): GroupEditorState {
  switch (state.mode) {
    case "normal":
      return applyNormal(state, event);
    case "move":
      return applyMove(state, event);
    case "rename":
      return applyRename(state, event);
  }
}

// The merge commit is drawn immediately BELOW its last (newest) member — it is
// newer than everything it merges — so a cursor on that row can also be "on the
// merge commit".
function mergeLetterAt(state: GroupEditorState, rowIdx: number): string | null {
  const row = state.rows[rowIdx];
  if (!row?.mergeLetter) return null;
  const isLastMember = state.rows[rowIdx + 1]?.mergeLetter !== row.mergeLetter;
  return isLastMember ? row.mergeLetter : null;
}

function applyNormal(state: GroupEditorState, event: EditorEvent): GroupEditorState {
  // The merge commit is drawn BELOW its last member and shares that row's
  // index, so the two directions are mirror images:
  //   going DOWN — arrive at the last member, then step down onto the merge line.
  //   going UP   — arrive at the merge line, then step up onto the member row.
  // Getting this backwards silently skips a member row.
  if (event.type === "arrow-up") {
    // On a merge line: the previous stop is its own last member (same row).
    if (state.onMergeCommit) return { ...state, onMergeCommit: null };
    const target = Math.max(0, state.cursor - 1);
    // Entering a group from below stops on its merge line first.
    const mergeAbove = mergeLetterAt(state, target);
    if (mergeAbove && target !== state.cursor) {
      return { ...state, cursor: target, onMergeCommit: mergeAbove };
    }
    return { ...state, cursor: target };
  }
  if (event.type === "arrow-down") {
    if (state.rows.length === 0) return state;
    // On a merge line: the next stop is the row below the group.
    if (state.onMergeCommit) {
      return {
        ...state,
        onMergeCommit: null,
        cursor: Math.min(state.rows.length - 1, state.cursor + 1),
      };
    }
    // On a group's last member: step down onto its own merge line (same row).
    const ownMerge = mergeLetterAt(state, state.cursor);
    if (ownMerge) return { ...state, onMergeCommit: ownMerge };
    return { ...state, cursor: Math.min(state.rows.length - 1, state.cursor + 1) };
  }
  // The merge commit owns the merge axis: ⇧← collapses the whole group.
  // The PR-group keys stay on the member row underneath, since a merge commit
  // has no PR-group identity of its own.
  if (event.type === "shift-arrow-left" && state.onMergeCommit) {
    return dissolveMergeGroup(state, state.onMergeCommit);
  }
  if (event.type === "arrow-right") return advanceGroup(state);
  if (event.type === "arrow-left") return retreatGroup(state);
  if (event.type === "shift-arrow-right") return mergeIn(state);
  if (event.type === "shift-arrow-left") return mergeOut(state);
  // Shift + ↑/↓ moves the commit under the cursor, with no grab step — holding
  // shift and tapping arrows is the drag. Uses the identical travel rules as
  // space-grab (below) by borrowing move mode for the duration of one step.
  if (event.type === "shift-arrow-up" || event.type === "shift-arrow-down") {
    if (!state.canReorder) return state;
    if (state.rows.length === 0) return state;
    const dir = event.type === "shift-arrow-up" ? "arrow-up" : "arrow-down";
    const asMove: GroupEditorState = {
      ...state,
      mode: "move",
      grabbed: state.cursor,
      grabbedOrigin: state.grabbedOrigin ?? state.cursor,
    };
    const moved = applyMove(asMove, { type: dir });
    // Return to normal mode: the shift-move is self-contained, not a mode.
    return { ...moved, mode: "normal", grabbed: null, grabbedOrigin: null };
  }
  if (event.type === "ctrl-arrow-up") return jumpToBoundary(state, -1);
  if (event.type === "ctrl-arrow-down") return jumpToBoundary(state, 1);
  if (event.type === "space") {
    if (state.rows.length === 0) return state;
    if (!state.canReorder) return state;
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
      targetLetter = sortedLetters[0] ?? "A";
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
      targetLetter = sortedLetters[idx + 1] ?? row.groupLetter;
    }
    // Dissolve old group if this was its last member
    maybeDissolve(newGroups, state.rows, state.cursor, row.groupLetter);
  }

  const newRows = state.rows.map((r, i) =>
    i === state.cursor ? { ...r, groupLetter: targetLetter } : r,
  );
  // The merge axis is deliberately left alone: changing a PR group may leave a
  // merge group straddling a boundary, which validateMergeGroups surfaces for
  // the user to resolve rather than us silently rewriting their merge.
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
  // Merge axis untouched — see advanceGroup.
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

// ---------------------------------------------------------------------------
// Merge axis
//
// Two separate concerns, deliberately not entangled:
//
//   ⇧→ / ⇧←  a pure TOGGLE on the cursor's own row — create a single-commit
//            merge group, or dissolve the one it's in. It never joins a
//            neighbouring group.
//   ↑ / ↓    in grab mode, MOVES the commit; membership follows from where it
//            lands (travelling along the outermost leaf). This is the only way
//            to grow a merge group.
//
// Invalid intermediate states (a non-contiguous group, or one straddling a PR
// boundary) are ALLOWED to exist while editing — they are surfaced by
// validateMergeGroups and block saving, rather than being silently corrected
// underneath the user.
// ---------------------------------------------------------------------------

function nextMergeLetter(merges: Map<string, MergeEntry>): string | null {
  for (const letter of MERGE_LETTERS) {
    if (!merges.has(letter)) return letter;
  }
  return null;
}

/**
 * ⇧→ : start a single-commit merge group on the cursor's row.
 *
 * Deliberately does NOT join an adjacent group — growing a group is done by
 * moving commits into it (grab + ↑/↓), which keeps "what does this key do"
 * answerable without looking at the neighbours.
 */
/**
 * Collapse an entire merge group: every member returns to the trunk and the
 * merge commit is gone. This is ⇧← on the merge commit itself — the whole-group
 * counterpart to ⇧← on a single member.
 */
function dissolveMergeGroup(state: GroupEditorState, letter: string): GroupEditorState {
  const rows = state.rows.map((r) => (r.mergeLetter === letter ? { ...r, mergeLetter: null } : r));
  const merges = new Map(state.merges);
  merges.delete(letter);
  return {
    ...state,
    rows,
    merges,
    onMergeCommit: null,
    hasChanges: true,
    mergeDirty: true,
  };
}

function mergeIn(state: GroupEditorState): GroupEditorState {
  if (state.onMergeCommit) return state; // the merge commit is not a commit row
  const row = state.rows[state.cursor];
  if (!row || !row.commitId) return state;
  if (row.mergeLetter !== null) return state; // already merged — ⇧← to dissolve

  const letter = nextMergeLetter(state.merges);
  if (!letter) return state; // exhausted a-z
  const merges = new Map(state.merges);
  // Message stays empty: it is collected once on save, so experimenting with
  // placement is never interrupted by an editor.
  merges.set(letter, { id: generateCommitId(), message: "", isNew: true });
  const rows = state.rows.map((r, i) => (i === state.cursor ? { ...r, mergeLetter: letter } : r));
  return { ...state, rows, merges, hasChanges: true, mergeDirty: true };
}

/**
 * ⇧← : remove the cursor's row from its merge group.
 *
 * Any member may leave, including one in the middle — that leaves the group
 * non-contiguous, which is a legal (if unsaveable) intermediate state the user
 * resolves by moving commits. The group dissolves when its last member leaves.
 */
function mergeOut(state: GroupEditorState): GroupEditorState {
  const row = state.rows[state.cursor];
  if (!row || row.mergeLetter === null) return state;
  const letter = row.mergeLetter;

  const memberCount = state.rows.filter((r) => r.mergeLetter === letter).length;
  const rows = state.rows.map((r, i) => (i === state.cursor ? { ...r, mergeLetter: null } : r));
  const merges = new Map(state.merges);
  if (memberCount === 1) merges.delete(letter); // last member left
  return { ...state, rows, merges, hasChanges: true, mergeDirty: true };
}

/**
 * shift-↑/↓ : jump the cursor to the next group boundary in that direction — the
 * first row whose PR group or merge group differs from the row before it. Lets
 * the user skate over a long group instead of stepping through every row.
 */
function jumpToBoundary(state: GroupEditorState, dir: 1 | -1): GroupEditorState {
  if (state.rows.length === 0) return state;
  const last = state.rows.length - 1;
  let i = state.cursor + dir;
  while (i > 0 && i < last) {
    const cur = state.rows[i];
    const prev = state.rows[i - dir];
    if (
      cur &&
      prev &&
      (cur.groupLetter !== prev.groupLetter || cur.mergeLetter !== prev.mergeLetter)
    )
      break;
    i += dir;
  }
  return { ...state, cursor: Math.max(0, Math.min(last, i)) };
}

/**
 * Move the grabbed commit ONE graph position in `dir`.
 *
 * A row index is not a position: next to a merge group there are two distinct
 * places a commit can sit — on the trunk beside the group, or inside it. So a
 * plain swap is wrong; it skips the trunk slot and teleports the commit into
 * the group.
 *
 * Each keypress does exactly one of:
 *   - MOVE THE WHOLE GROUP, when the grabbed commit is its only member (a
 *     single-commit group is a thing the user built; moving it must relocate
 *     it, not dissolve it),
 *   - ENTER the adjacent group (same rows, but now on the side track),
 *   - TRAVERSE within the group, or STEP OUT past its far edge — so a commit
 *     can pass all the way over a group and come out the other side,
 *   - SWAP with the neighbouring commit (both on the same track).
 *
 * This is the "travel along the outermost leaf" rule: the commit walks the
 * outline of the graph rather than jumping across it.
 */
function moveGrabbed(
  state: GroupEditorState,
  dir: 1 | -1,
): { rows: CommitRow[]; merges: Map<string, MergeEntry>; index: number } | null {
  const g = state.grabbed;
  if (g === null) return null;
  const moved = state.rows[g];
  if (!moved) return null;

  const neighborIdx = g + dir;
  const neighbor = state.rows[neighborIdx];

  const here = moved.mergeLetter;
  const there = neighbor?.mergeLetter ?? null;
  const soleMember = here !== null && state.rows.filter((r) => r.mergeLetter === here).length === 1;

  const swapWith = (idx: number) => {
    const rows = [...state.rows];
    const a = rows[g];
    const b = rows[idx];
    if (a && b) {
      rows[idx] = a;
      rows[g] = b;
    }
    return rows;
  };

  // 1. Inside a multi-member group at its edge => step OUT onto the trunk.
  //    Checked BEFORE the end-of-stack guard below, because leaving a group is
  //    not a reorder and needs no neighbour: otherwise a group sitting at the
  //    very top or bottom of the stack becomes a trap you can enter but never
  //    leave (the commit has nothing to swap with past the group's edge).
  if (here !== null && !soleMember && there !== here) {
    const rows = state.rows.map((r, i) => (i === g ? { ...r, mergeLetter: null } : r));
    return { rows, merges: dropEmpty(rows, state.merges), index: g };
  }

  // Everything below reorders, so it needs a neighbour to trade places with.
  if (!neighbor) return null; // at the end of the stack

  // 2. Sole member of its group => the group travels WITH it, keeping its
  //    identity. Swapping is enough: the group is just "wherever its member is".
  // 3. Same track (both in the group, or both on the trunk) => ordinary swap.
  if (soleMember || here === there) {
    return { rows: swapWith(neighborIdx), merges: state.merges, index: neighborIdx };
  }

  // 4. On the trunk, standing beside a group we are not in => step INTO it.
  if (here === null && there !== null) {
    const rows = state.rows.map((r, i) => (i === g ? { ...r, mergeLetter: there } : r));
    return { rows, merges: state.merges, index: g };
  }

  return { rows: swapWith(neighborIdx), merges: state.merges, index: neighborIdx };
}

/**
 * Slide an ENTIRE merge group one position in `dir`, as one block.
 *
 * Used when the grabbed thing is the merge commit itself: the group keeps its
 * shape and simply trades places with the commit just outside it. Members are
 * assumed contiguous (the save-time validator is what catches the case where
 * they are not).
 *
 * Returns the group's new LAST-member index — the row the merge-commit line is
 * drawn against, so the cursor stays on the merge commit as the block moves.
 */
function moveWholeGroup(
  state: GroupEditorState,
  letter: string,
  dir: 1 | -1,
): { rows: CommitRow[]; index: number } | null {
  const idx = state.rows.map((r, i) => (r.mergeLetter === letter ? i : -1)).filter((i) => i >= 0);
  const first = idx[0];
  const last = idx[idx.length - 1];
  if (first === undefined || last === undefined) return null;

  // The commit the block would trade places with.
  const outsideIdx = dir === -1 ? first - 1 : last + 1;
  const outside = state.rows[outsideIdx];
  if (!outside) return null; // group is already at the stack's edge

  const block = state.rows.slice(first, last + 1);
  const rows = [...state.rows];
  if (dir === -1) {
    // Block moves up over `outside`, which drops to just below it.
    rows.splice(first - 1, block.length + 1, ...block, outside);
    return { rows, index: last - 1 };
  }
  // Block moves down under `outside`, which rises to just above it.
  rows.splice(first, block.length + 1, outside, ...block);
  return { rows, index: last + 1 };
}

// Forget any merge group that no longer has members.
function dropEmpty(rows: CommitRow[], merges: Map<string, MergeEntry>): Map<string, MergeEntry> {
  const next = new Map(merges);
  for (const letter of [...next.keys()]) {
    if (!rows.some((r) => r.mergeLetter === letter)) next.delete(letter);
  }
  return next;
}

// A merge group that cannot be saved as-is, and why. Surfaced in the UI so the
// user can fix it; never auto-corrected.
export interface MergeGroupProblem {
  letter: string;
  rowIndices: number[];
  reason: "non-contiguous" | "straddles-pr-groups";
}

/**
 * Find merge groups that are not yet saveable. Invalid states are legal WHILE
 * editing (you may need to pass through one to get where you're going); this is
 * what `enter` consults to decide whether the edit can be committed.
 */
export function validateMergeGroups(state: GroupEditorState): MergeGroupProblem[] {
  const problems: MergeGroupProblem[] = [];
  for (const letter of state.merges.keys()) {
    const rowIndices = state.rows
      .map((r, i) => (r.mergeLetter === letter ? i : -1))
      .filter((i) => i >= 0);
    if (rowIndices.length === 0) continue;

    const first = rowIndices[0] ?? 0;
    const last = rowIndices[rowIndices.length - 1] ?? 0;
    if (last - first + 1 !== rowIndices.length) {
      problems.push({ letter, rowIndices, reason: "non-contiguous" });
      continue;
    }
    // Containment: every member must sit in the same PR unit. Ungrouped rows are
    // each their own unit, so a multi-member group of them straddles units too.
    const prGroups = new Set(rowIndices.map((i) => state.rows[i]?.groupLetter ?? null));
    const spansUngrouped = rowIndices.length > 1 && prGroups.has(null);
    if (prGroups.size > 1 || spansUngrouped) {
      problems.push({ letter, rowIndices, reason: "straddles-pr-groups" });
    }
  }
  return problems;
}

function applyMove(state: GroupEditorState, event: EditorEvent): GroupEditorState {
  if (event.type === "arrow-up" || event.type === "arrow-down") {
    const dir = event.type === "arrow-up" ? -1 : 1;
    // Grabbing the merge commit moves the group as a single block.
    if (state.onMergeCommit) {
      const movedGroup = moveWholeGroup(state, state.onMergeCommit, dir);
      if (!movedGroup) return state;
      return {
        ...state,
        rows: movedGroup.rows,
        grabbed: movedGroup.index,
        cursor: movedGroup.index,
        hasChanges: true,
        mergeDirty: true,
        conflicts: new Set(),
      };
    }
    const moved = moveGrabbed(state, dir);
    if (!moved) return state;
    return {
      ...state,
      rows: moved.rows,
      merges: moved.merges,
      grabbed: moved.index,
      cursor: moved.index,
      hasChanges: true,
      mergeDirty: true,
      conflicts: new Set(),
    };
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
  if (event.type === "space") {
    return { ...state, renameBuffer: state.renameBuffer + " " };
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
    newGroups.set(row.groupLetter, { ...entry, title: state.renameBuffer, isNew: false });
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

  // The merge axis, emitted in stack order (the order materialize walks). Rows
  // carry contiguity/containment by construction, so no validation is needed
  // here — buildMaterializePlan re-checks anyway.
  const mergeGroups: MergeGroupResult[] = [];
  const seen = new Set<string>();
  for (const row of state.rows) {
    if (!row.mergeLetter || seen.has(row.mergeLetter)) continue;
    seen.add(row.mergeLetter);
    const entry = state.merges.get(row.mergeLetter);
    if (!entry) continue;
    const members = state.rows.filter((r) => r.mergeLetter === row.mergeLetter && r.commitId);
    const memberIds = members.map((r) => r.commitId);
    if (memberIds.length === 0) continue;
    mergeGroups.push({
      id: entry.id,
      memberIds,
      message: entry.message,
      firstSubject: members[0]?.subject ?? "",
      needsMessage: entry.message.trim().length === 0,
    });
  }

  return {
    newOrder: orderChanged ? currentHashes : null,
    updatedRecords,
    mergeGroups,
    // Any merge-axis mutation sets mergeDirty; a reorder also changes where the
    // merges sit in history, so it too requires a rewrite.
    mergeChanged: state.mergeDirty || (orderChanged && mergeGroups.length > 0),
    cancelled: false,
  };
}
