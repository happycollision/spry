import kleur from "kleur";

export interface SelectOption {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface SelectResult {
  cancelled: boolean;
  selectedIds: string[];
}

export interface SelectOptions {
  title?: string;
}

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;

export async function selectUnits(
  options: SelectOption[],
  opts: SelectOptions = {},
): Promise<SelectResult> {
  if (options.length === 0) {
    return { cancelled: true, selectedIds: [] };
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const selected = new Set<string>();
  let cursor = 0;

  function render(): void {
    const lines: string[] = [];
    lines.push(
      opts.title ?? "Select units to open (space toggle, a all, enter confirm, esc cancel):",
    );
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (!opt) continue;
      const isCursor = i === cursor;
      const isSelected = selected.has(opt.id);
      const box = isSelected ? "[x]" : "[ ]";
      const prefix = isCursor ? kleur.cyan(">") : " ";
      const label = opt.disabled ? kleur.dim(opt.label) : opt.label;
      const hint = opt.hint ? " " + kleur.dim(opt.hint) : "";
      lines.push(`${prefix} ${box} ${label}${hint}`);
    }
    stdout.write(CLEAR_SCREEN);
    stdout.write(lines.join("\n"));
  }

  function cleanup(): void {
    stdout.write(SHOW_CURSOR);
    stdout.write("\n");
    stdin.setRawMode?.(false);
    stdin.pause();
  }

  stdin.setRawMode?.(true);
  stdin.resume();
  stdout.write(HIDE_CURSOR);
  render();

  return new Promise<SelectResult>((resolve) => {
    function onData(chunk: Buffer): void {
      const data = chunk.toString();
      // Parse the chunk into individual keys so multiple keys arriving in a
      // single read (e.g. Space+Enter) are handled correctly.
      const keys: string[] = [];
      let i = 0;
      while (i < data.length) {
        const ch = data[i];
        if (ch === "\x1b") {
          // Lone ESC vs CSI sequence (e.g. arrow keys "\x1b[A").
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
          cleanup();
          resolve({ cancelled: true, selectedIds: [] });
          return;
        }
        if (key === "\r" || key === "\n") {
          stdin.off("data", onData);
          cleanup();
          resolve({
            cancelled: false,
            selectedIds: options.filter((o) => selected.has(o.id)).map((o) => o.id),
          });
          return;
        }
        if (key === " ") {
          const opt = options[cursor];
          if (opt && !opt.disabled) {
            if (selected.has(opt.id)) selected.delete(opt.id);
            else selected.add(opt.id);
          }
        } else if (key === "a") {
          const allSelected = options.every((o) => o.disabled || selected.has(o.id));
          if (allSelected) {
            selected.clear();
          } else {
            for (const o of options) if (!o.disabled) selected.add(o.id);
          }
        } else if (key === "\x1b[A") {
          cursor = (cursor - 1 + options.length) % options.length;
        } else if (key === "\x1b[B") {
          cursor = (cursor + 1) % options.length;
        }
      }
      render();
    }

    stdin.on("data", onData);
  });
}
