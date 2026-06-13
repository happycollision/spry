import kleur from "kleur";

export interface SelectOneOption {
  id: string;
  label: string;
  hint?: string;
}

export interface SelectOneResult {
  cancelled: boolean;
  selectedId: string | null;
}

export interface SelectOneOptions {
  title?: string;
}

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;

/**
 * Single-select picker: one cursor position, Enter selects the cursor row,
 * Esc/Ctrl+C cancels. Unlike `selectUnits`, there are no toggles — the cursor
 * row is the selection.
 */
export async function selectOne(
  options: SelectOneOption[],
  opts: SelectOneOptions = {},
): Promise<SelectOneResult> {
  if (options.length === 0) {
    return { cancelled: true, selectedId: null };
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  let cursor = 0;

  function render(): void {
    const lines: string[] = [];
    lines.push(
      opts.title ?? "Select the unit to land through (↑/↓ move, enter select, esc cancel):",
    );
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (!opt) continue;
      const isCursor = i === cursor;
      const prefix = isCursor ? kleur.cyan(">") : " ";
      const label = isCursor ? kleur.cyan(opt.label) : opt.label;
      const hint = opt.hint ? " " + kleur.dim(opt.hint) : "";
      lines.push(`${prefix} ${label}${hint}`);
    }
    stdout.write(CLEAR_SCREEN);
    stdout.write(lines.join("\n"));
  }

  // Idempotent: safe to call multiple times.
  let cleanedUp = false;
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    stdout.write(SHOW_CURSOR);
    stdout.write("\n");
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
  stdout.write(HIDE_CURSOR);

  try {
    render();
    return await new Promise<SelectOneResult>((resolve) => {
      function onData(chunk: Buffer): void {
        const data = chunk.toString();
        const keys: string[] = [];
        let i = 0;
        while (i < data.length) {
          const ch = data[i];
          if (ch === "\x1b") {
            if (data[i + 1] === "[" && i + 2 < data.length) {
              keys.push(data.slice(i, i + 3));
              i += 3;
              continue;
            }
            keys.push("\x1b");
            i += 1;
            continue;
          }
          keys.push(ch ?? "");
          i += 1;
        }

        for (const key of keys) {
          if (key === "\x03" || key === "\x1b") {
            // Ctrl+C or Esc
            stdin.off("data", onData);
            resolve({ cancelled: true, selectedId: null });
            return;
          }
          if (key === "\r" || key === "\n") {
            stdin.off("data", onData);
            const opt = options[cursor];
            resolve({ cancelled: false, selectedId: opt?.id ?? null });
            return;
          }
          if (key === "\x1b[A") {
            cursor = (cursor - 1 + options.length) % options.length;
          } else if (key === "\x1b[B") {
            cursor = (cursor + 1) % options.length;
          }
        }
        render();
      }

      stdin.on("data", onData);
    });
  } finally {
    cleanup();
  }
}
