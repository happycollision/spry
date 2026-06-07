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
    const row = state.rows[i];
    if (!row) continue;
    const isCursor = i === state.cursor;
    const isGrabbed = i === state.grabbed;
    const hasConflict = state.conflicts.has(i);

    const prefix = isGrabbed ? "●" : isCursor ? kleur.cyan("▶") : " ";
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
