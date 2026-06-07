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
    const record = groupRecords[groupId];
    if (!record) continue;
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
    if (state.rows.length === 0) return state;
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
    const tmp1 = rows[g];
    const tmp2 = rows[g - 1];
    if (tmp1 && tmp2) {
      rows[g - 1] = tmp1;
      rows[g] = tmp2;
    }
    return {
      ...state,
      rows,
      grabbed: g - 1,
      cursor: g - 1,
      hasChanges: true,
      conflicts: new Set(),
    };
  }
  if (event.type === "arrow-down") {
    const g = state.grabbed;
    if (g === null || g === state.rows.length - 1) return state;
    const rows = [...state.rows];
    const tmp3 = rows[g];
    const tmp4 = rows[g + 1];
    if (tmp3 && tmp4) {
      rows[g] = tmp4;
      rows[g + 1] = tmp3;
    }
    return {
      ...state,
      rows,
      grabbed: g + 1,
      cursor: g + 1,
      hasChanges: true,
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

  return {
    newOrder: orderChanged ? currentHashes : null,
    updatedRecords,
    cancelled: false,
  };
}
