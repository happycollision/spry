/**
 * Single-select TUI component for selecting a commit from a list.
 * Used for picking group start/end commits in repair flows.
 */

import {
  enableRawMode,
  parseKeypress,
  clearScreen,
  hideCursor,
  showCursor,
  write,
  isTTY,
  colors,
} from "./terminal.ts";
import type { CommitWithTrailers } from "../core/stack.ts";

export interface CommitSelectResult {
  commit: string | null; // hash
  cancelled: boolean;
}

/**
 * Format trailer info for display.
 */
function formatTrailerHint(trailers: CommitWithTrailers["trailers"]): string {
  const hints: string[] = [];

  if (trailers["Taspr-Group-Start"]) {
    hints.push(`Group-Start: ${trailers["Taspr-Group-Start"].slice(0, 8)}`);
  }
  if (trailers["Taspr-Group-End"]) {
    hints.push(`Group-End: ${trailers["Taspr-Group-End"].slice(0, 8)}`);
  }
  if (trailers["Taspr-Group-Title"]) {
    hints.push(`"${trailers["Taspr-Group-Title"]}"`);
  }

  return hints.length > 0 ? `[${hints.join(", ")}]` : "";
}

/**
 * Render the commit select UI.
 */
function render(
  commits: CommitWithTrailers[],
  cursor: number,
  title: string,
  highlightCommit?: string,
): string {
  const lines: string[] = [];

  // Title and controls
  lines.push(colors.bold(title));
  lines.push(colors.dim("↑↓ navigate │ Enter confirm │ Esc cancel"));
  lines.push("");

  // Commits list
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    if (!commit) continue;
    const isCursor = i === cursor;
    const isHighlighted = commit.hash === highlightCommit;

    const pointer = isCursor ? colors.cyan("→") : " ";
    const hash = commit.hash.slice(0, 7);
    const subject = commit.subject.slice(0, 50);
    const trailerHint = formatTrailerHint(commit.trailers);

    // Build the line parts
    let line = `${pointer} ${hash} ${subject}`;

    // Add trailer hint if present
    if (trailerHint) {
      line += `  ${colors.dim(trailerHint)}`;
    }

    // Add highlight marker
    if (isHighlighted) {
      line += colors.yellow("  (problem)");
    }

    // Colorize the whole line based on cursor (but pointer already colored)
    if (isCursor) {
      // Re-build with cyan hash and subject
      const cyanLine = `${pointer} ${colors.cyan(hash)} ${colors.cyan(subject)}`;
      let finalLine = cyanLine;
      if (trailerHint) {
        finalLine += `  ${colors.dim(trailerHint)}`;
      }
      if (isHighlighted) {
        finalLine += colors.yellow("  (problem)");
      }
      lines.push(finalLine);
    } else {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

/**
 * Run an interactive single-select prompt for choosing a commit.
 *
 * @param commits - Array of commits to select from
 * @param title - Title to display above options
 * @param highlightCommit - Optional commit hash to highlight (e.g., problem commit)
 * @returns Selected commit hash, or null if cancelled
 */
export async function commitSelect(
  commits: CommitWithTrailers[],
  title: string,
  highlightCommit?: string,
): Promise<CommitSelectResult> {
  if (!isTTY()) {
    // Non-interactive: return cancelled
    return { commit: null, cancelled: true };
  }

  if (commits.length === 0) {
    return { commit: null, cancelled: false };
  }

  let cursor = 0;

  const restoreMode = enableRawMode();
  hideCursor();

  const redraw = () => {
    clearScreen();
    const output = render(commits, cursor, title, highlightCommit);
    write(output);
  };

  // Initial render
  redraw();

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      showCursor();
      restoreMode();
      write("\n");
    };

    const onData = (data: Buffer) => {
      const key = parseKeypress(data);

      switch (key.name) {
        case "up":
        case "k":
          cursor = cursor > 0 ? cursor - 1 : commits.length - 1;
          redraw();
          break;

        case "down":
        case "j":
          cursor = cursor < commits.length - 1 ? cursor + 1 : 0;
          redraw();
          break;

        case "return": {
          cleanup();
          const selectedCommit = commits[cursor];
          resolve({
            commit: selectedCommit ? selectedCommit.hash : null,
            cancelled: false,
          });
          break;
        }

        case "escape":
        case "q":
          cleanup();
          resolve({ commit: null, cancelled: true });
          break;

        default:
          // Ctrl+C
          if (key.ctrl && key.name === "c") {
            cleanup();
            resolve({ commit: null, cancelled: true });
          }
          break;
      }
    };

    process.stdin.on("data", onData);
  });
}
