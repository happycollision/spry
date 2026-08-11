import kleur from "kleur";
import type { GroupEditorState } from "./group-state.ts";
import { frameReset, HIDE_CURSOR } from "./screen.ts";

// Layout, defined once so commit rows, merge-commit lines and the rejoin line
// all share the same columns.
//
//   <---- GUTTER_COLUMN ----><-- gutter --><----- to TAG_COLUMN ----->[A]
//   ▶  1  1111111            │ ●           Commit 1: add f1          [A: title]
//
// GUTTER_COLUMN is the width of "<prefix> <num>  <hash> " on a commit row.
const GUTTER_COLUMN = 1 + 1 + 2 + 2 + 7 + 1;
// TAG_COLUMN is measured from the START OF THE LINE, so lines whose gutters are
// different widths still land their [A]/[B] tag in the same place.
// Wide enough that even the longest merge-commit placeholder label still gets
// padding before its tag (otherwise that line's tag would drift left).
const TAG_COLUMN = GUTTER_COLUMN + 46;

export function renderGroupEditor(state: GroupEditorState, branch: string): string {
  const lines: string[] = [];

  lines.push(`Stack: ${branch} (${state.rows.length} commit${state.rows.length === 1 ? "" : "s"})`);
  lines.push("");

  const seenGroupLetters = new Set<string>();

  // Rows belonging to a merge group that blocked the last save attempt.
  const problemRows = new Set<number>();
  for (const problem of state.problems) {
    for (const i of problem.rowIndices) problemRows.add(i);
  }

  // Grabbing a merge commit grabs the whole group, so every member highlights
  // — the block moves as one, and the highlight should say so.
  const grabbedMergeLetter =
    state.mode === "move" && state.onMergeCommit ? state.onMergeCommit : null;

  for (let i = 0; i < state.rows.length; i++) {
    const row = state.rows[i];
    if (!row) continue;
    // When the cursor is on a merge-commit line it shares that row's index, so
    // the commit row itself must not also draw the marker.
    const isCursor = i === state.cursor && !state.onMergeCommit;
    const isGrabbed =
      grabbedMergeLetter !== null
        ? row.mergeLetter === grabbedMergeLetter
        : i === state.grabbed && !state.onMergeCommit;
    const hasConflict = state.conflicts.has(i);

    // The grab marker belongs to the thing grabbed: when that is the merge
    // commit, its own line carries it and the members just highlight.
    const prefix = isGrabbed && !grabbedMergeLetter ? "●" : isCursor ? kleur.cyan("▶") : " ";
    const num = String(i + 1).padStart(2);
    const hash = kleur.dim(row.hash.slice(0, 7));

    // The MERGE axis renders as a real commit graph in the gutter: EVERY commit
    // is a ●, the trunk line runs the full height, and a merge group's members
    // sit on a second track.
    //
    // Rows print OLDEST-FIRST (top = oldest), and a merge commit is NEWER than
    // the members it merges — so the side branch opens ABOVE the members and
    // the merge commit closes it BELOW them:
    //
    //     ●    plain commit (older)
    //     ├─┐  branch point        <- side track opens
    //     │ ●  member (oldest)
    //     │ ●  member
    //     ●─┘  Merge commit        <- newest; closes the side track
    //
    // Layered on the PR-group letter column so both axes stay legible at once.
    const isMerged = row.mergeLetter !== null;
    const isLastMember = isMerged && state.rows[i + 1]?.mergeLetter !== row.mergeLetter;
    // Every commit is a ● — merged ones ride a second track to the right of the
    // trunk. The branch (●─┐) and rejoin (├─┘) get their own lines around the
    // group, so no commit row is ever double-height.
    // Merged rows carry two extra columns after the ● so their subjects sit
    // indented from the trunk's — the depth cue, on top of the track position.
    const graph = isMerged ? "│ ●  " : "●  ";
    // The subject field absorbs whatever the gutter took, so every row's tag
    // lands on TAG_COLUMN regardless of merge depth.
    // "…<gutter> <subject>" — the +1 is the space after the gutter, matching
    // how the merge-commit line above measures its own label.
    const subjectWidth = TAG_COLUMN - (GUTTER_COLUMN + graph.length + 1);
    const subject = row.subject.slice(0, subjectWidth).padEnd(subjectWidth);

    let groupTag = "";
    if (row.groupLetter) {
      const entry = state.groups.get(row.groupLetter);
      if (entry) {
        const isFirstInGroup = !seenGroupLetters.has(row.groupLetter);
        seenGroupLetters.add(row.groupLetter);
        if (isFirstInGroup) {
          const isBeingRenamed =
            state.mode === "rename" && state.rows[state.cursor]?.groupLetter === row.groupLetter;
          const titleDisplay = isBeingRenamed
            ? state.renameBuffer + "▌"
            : entry.title || kleur.dim("(no title)");
          groupTag = ` [${row.groupLetter}: ${titleDisplay}]`;
        } else {
          groupTag = ` [${row.groupLetter}]`;
        }
      }
    }

    // Before the group's OLDEST member (the first one printed), open the side
    // track. This is just the branch point — the merge commit itself comes
    // after the members, since it is newer than all of them.
    const isFirstMember = isMerged && state.rows[i - 1]?.mergeLetter !== row.mergeLetter;
    if (isFirstMember) {
      const branchLine = `${" ".repeat(GUTTER_COLUMN)}${kleur.magenta("├─┐")}`;
      lines.push(grabbedMergeLetter === row.mergeLetter ? kleur.yellow(branchLine) : branchLine);
    }

    const conflictMarker = hasConflict ? " " + kleur.red("⚠") : "";
    // A row in an unsaveable merge group turns red so the problem is locatable.
    const gutter = problemRows.has(i)
      ? kleur.red(graph)
      : isMerged
        ? kleur.magenta(graph)
        : kleur.dim(graph);
    const rowText = `${prefix} ${num}  ${hash} ${gutter} ${subject}${groupTag}${conflictMarker}`;
    lines.push(isGrabbed ? kleur.yellow(rowText) : rowText);

    // After the group's NEWEST member, the merge commit itself closes the side
    // track back onto the trunk. It is a selectable node, so it carries the
    // cursor/grab markers exactly like a commit row does.
    if (isLastMember && row.mergeLetter) {
      const entry = state.merges.get(row.mergeLetter);
      const subjectLine = (entry?.message ?? "").split("\n")[0] ?? "";
      const rawLabel = subjectLine || "(merge message set on save)";
      const label = subjectLine ? kleur.magenta(rawLabel) : kleur.dim(rawLabel);
      const onIt = state.onMergeCommit === row.mergeLetter && i === state.cursor;
      const grabbedIt = onIt && state.mode === "move";
      const mergePrefix = grabbedIt ? "●" : onIt ? kleur.cyan("▶") : " ";
      // Inherits the PR-group letter of the unit it lands in, padded by the
      // label's VISIBLE length (`label` carries ANSI codes) to TAG_COLUMN.
      const mergeGraph = "●─┘";
      const used = GUTTER_COLUMN + 1 + mergeGraph.length + rawLabel.length;
      const pad = " ".repeat(Math.max(1, TAG_COLUMN - used));
      const inheritedTag = row.groupLetter ? `${pad}${kleur.dim(`[${row.groupLetter}]`)}` : "";
      const mergeLine = `${mergePrefix}${" ".repeat(GUTTER_COLUMN - 1)}${kleur.magenta(mergeGraph)} ${label}${inheritedTag}`;
      lines.push(grabbedIt ? kleur.yellow(mergeLine) : mergeLine);
    }
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
    if (!state.canReorder) {
      lines.push(kleur.yellow("Reordering disabled: working tree is dirty."));
    }
    // Why the last save was refused. Shown until the user edits something.
    for (const problem of state.problems) {
      const rows = problem.rowIndices.map((i) => i + 1).join(", ");
      const why =
        problem.reason === "non-contiguous"
          ? "is split apart — its commits must be next to each other"
          : "spans more than one PR group — a merge must live inside one PR";
      lines.push(
        kleur.red(`✗ Can't save: the merge on row${rows.includes(",") ? "s" : ""} ${rows} ${why}.`),
      );
    }
    const reorderHelp = state.canReorder ? "⇧↑↓ move commit  Space grab" : "reorder disabled";
    lines.push(kleur.dim(`↑↓ cursor  ⌃↑↓ jump boundary  ←→ PR group  ⇧←→ merge on/off`));
    lines.push(kleur.dim(`${reorderHelp}  r rename  Enter save  q quit`));
  }

  return frameReset() + HIDE_CURSOR + lines.join("\n");
}
