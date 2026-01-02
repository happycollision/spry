/**
 * Single-select TUI component for repair action selection.
 * Similar to multi-select but returns a single choice.
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

export interface RepairOption<T> {
  label: string;
  value: T;
  description?: string;
}

export interface RepairSelectResult<T> {
  selected: T | null;
  cancelled: boolean;
}

/**
 * Render the repair select UI.
 */
function render<T>(
  options: RepairOption<T>[],
  cursor: number,
  title: string,
  errorSummary: string,
): string {
  const lines: string[] = [];

  // Error summary at top
  lines.push(colors.red(errorSummary));
  lines.push("");

  // Title and controls
  lines.push(colors.bold(title));
  lines.push(colors.dim("↑↓ navigate │ Enter confirm │ Esc cancel"));
  lines.push("");

  // Options with descriptions
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (!opt) continue;
    const isCursor = i === cursor;

    const pointer = isCursor ? colors.cyan("→") : " ";
    const label = isCursor ? colors.cyan(opt.label) : opt.label;

    lines.push(`${pointer} ${label}`);

    // Show description indented below (consistent indentation)
    if (opt.description) {
      lines.push(`  ${colors.dim(opt.description)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Run an interactive single-select prompt for repair actions.
 *
 * @param options - Array of options to select from
 * @param title - Title to display above options
 * @param errorSummary - Error context to show at top
 * @returns Selected value, or null if cancelled
 */
export async function repairSelect<T>(
  options: RepairOption<T>[],
  title: string,
  errorSummary: string,
): Promise<RepairSelectResult<T>> {
  if (!isTTY()) {
    // Non-interactive: return cancelled
    return { selected: null, cancelled: true };
  }

  if (options.length === 0) {
    return { selected: null, cancelled: false };
  }

  let cursor = 0;

  const restoreMode = enableRawMode();
  hideCursor();

  const redraw = () => {
    clearScreen();
    const output = render(options, cursor, title, errorSummary);
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
          cursor = cursor > 0 ? cursor - 1 : options.length - 1;
          redraw();
          break;

        case "down":
        case "j":
          cursor = cursor < options.length - 1 ? cursor + 1 : 0;
          redraw();
          break;

        case "return": {
          cleanup();
          const selectedOption = options[cursor];
          resolve({
            selected: selectedOption ? selectedOption.value : null,
            cancelled: false,
          });
          break;
        }

        case "escape":
        case "q":
          cleanup();
          resolve({ selected: null, cancelled: true });
          break;

        default:
          // Ctrl+C
          if (key.ctrl && key.name === "c") {
            cleanup();
            resolve({ selected: null, cancelled: true });
          }
          break;
      }
    };

    process.stdin.on("data", onData);
  });
}
