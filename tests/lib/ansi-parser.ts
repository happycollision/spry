export interface ScreenSnapshot {
  lines: string[];
  cursor: { x: number; y: number };
  text: string;
  ansi: string; // reconstructed clean ANSI — no cursor movement codes, newline-separated
}

export interface ScreenBuffer {
  write(data: string): void;
  lineAt(row: number): string;
  capture(): ScreenSnapshot;
  cursor: { x: number; y: number };
}

interface Cell {
  char: string;
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
}

const BLANK: Cell = { char: " ", fg: null, bg: null, bold: false, dim: false };

function blankGrid(cols: number, rows: number): Cell[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ...BLANK })));
}

export function createScreenBuffer(cols: number, rows: number): ScreenBuffer {
  let grid: Cell[][] = blankGrid(cols, rows);
  const cursor = { x: 0, y: 0 };
  const style: Omit<Cell, "char"> = { fg: null, bg: null, bold: false, dim: false };

  // Alternate screen buffer (DECSET/DECRST 1049), as used by the interactive
  // TUIs (src/tui/screen.ts): ESC[?1049h saves the primary grid + cursor and
  // switches to a fresh cleared grid; ESC[?1049l restores them. Modeling this
  // faithfully is what keeps a TUI's rendered frame from bleeding into the
  // command output printed AFTER the TUI exits (spry-ohjb): on a real terminal
  // those live in separate buffers, so a doc test that captures the primary
  // buffer post-exit sees only the real output, never picker/hint residue.
  let savedPrimary: { grid: Cell[][]; cursor: { x: number; y: number } } | null = null;

  function enterAltScreen(): void {
    if (savedPrimary) return; // already in the alt buffer — ignore a repeat enter
    savedPrimary = { grid, cursor: { ...cursor } };
    grid = blankGrid(cols, rows);
    cursor.x = 0;
    cursor.y = 0;
  }

  function exitAltScreen(): void {
    if (!savedPrimary) return; // never entered — a spurious exit is a no-op
    grid = savedPrimary.grid;
    cursor.x = savedPrimary.cursor.x;
    cursor.y = savedPrimary.cursor.y;
    savedPrimary = null;
  }

  function getRow(row: number): Cell[] {
    return grid[row] ?? [];
  }

  function setCell(row: number, col: number, cell: Cell): void {
    const r = grid[row];
    if (r) r[col] = cell;
  }

  function scrollUp(): void {
    grid.shift();
    grid.push(Array.from({ length: cols }, () => ({ ...BLANK })));
  }

  function putChar(ch: string): void {
    // Scroll-on-overflow, applied lazily: a newline (or wrap) may leave the
    // cursor past the last row, but the grid only scrolls when a character
    // actually needs that row. Scrolling eagerly would shift the frame when a
    // full-screen TUI paints the bottom-right cell and then repositions with
    // CUP — deferring matches real terminals' pending-wrap behavior closely
    // enough that in-bounds redraws render identically to before. Without
    // this, output longer than `rows` was silently truncated to the FIRST
    // `rows` lines, so capture() after exit missed the final lines.
    while (cursor.y >= rows) {
      scrollUp();
      cursor.y--;
    }
    if (cursor.y >= 0 && cursor.x >= 0 && cursor.x < cols) {
      setCell(cursor.y, cursor.x, { char: ch, ...style });
    }
    cursor.x++;
    if (cursor.x >= cols) {
      cursor.x = 0;
      cursor.y++;
    }
  }

  function clearLine(row: number): void {
    if (row >= 0 && row < rows) {
      for (let i = 0; i < cols; i++) setCell(row, i, { ...BLANK });
    }
  }

  function clearAll(): void {
    for (let r = 0; r < rows; r++) clearLine(r);
  }

  function lineAt(row: number): string {
    if (row < 0 || row >= rows) return "";
    return getRow(row)
      .map((c) => c.char)
      .join("")
      .trimEnd();
  }

  function buildAnsiLine(row: number): string {
    const cells = getRow(row);
    // Find last non-blank cell
    let lastCol = cols - 1;
    while (lastCol > 0) {
      const c = cells[lastCol];
      if (!c || (c.char === " " && c.fg === null && c.bg === null && !c.bold && !c.dim)) {
        lastCol--;
      } else {
        break;
      }
    }
    const lastCell = cells[lastCol];
    if (
      !lastCell ||
      (lastCell.char === " " &&
        lastCol === 0 &&
        lastCell.fg === null &&
        lastCell.bg === null &&
        !lastCell.bold &&
        !lastCell.dim)
    )
      return "";

    let out = "";
    let prev: Omit<Cell, "char"> = { fg: null, bg: null, bold: false, dim: false };
    let needsReset = false;

    for (let x = 0; x <= lastCol; x++) {
      const cell = cells[x];
      if (!cell) continue;
      const changed =
        cell.fg !== prev.fg ||
        cell.bg !== prev.bg ||
        cell.bold !== prev.bold ||
        cell.dim !== prev.dim;

      if (changed) {
        const sgr: number[] = [];
        if (
          (prev.bold && !cell.bold) ||
          (prev.dim && !cell.dim) ||
          (prev.fg !== null && cell.fg === null) ||
          (prev.bg !== null && cell.bg === null)
        ) {
          sgr.push(0);
          prev = { fg: null, bg: null, bold: false, dim: false };
        }
        if (cell.bold && !prev.bold) sgr.push(1);
        if (cell.dim && !prev.dim) sgr.push(2);
        if (cell.fg !== null && cell.fg !== prev.fg) sgr.push(cell.fg);
        if (cell.bg !== null && cell.bg !== prev.bg) sgr.push(cell.bg);

        if (sgr.length > 0) {
          out += `\x1b[${sgr.join(";")}m`;
          needsReset = true;
        }
        prev = { fg: cell.fg, bg: cell.bg, bold: cell.bold, dim: cell.dim };
      }
      out += cell.char;
    }

    if (needsReset) out += "\x1b[0m";
    return out;
  }

  function write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === undefined) break;

      if (ch === "\x1b") {
        i++;
        if (i >= data.length) break;
        const next = data[i];

        if (next === "[") {
          i++;
          let params = "";
          while (i < data.length) {
            const c = data[i];
            if (c === undefined || c < "\x20" || c > "\x3f") break;
            params += c;
            i++;
          }
          if (i >= data.length) break;
          const finalByte = data[i];
          i++;
          if (finalByte !== undefined) handleCSI(params, finalByte);
        } else if (next === "7" || next === "8") {
          i++;
        } else {
          i++;
        }
        continue;
      }

      if (ch === "\n") {
        cursor.y++;
        cursor.x = 0;
        i++;
        continue;
      }
      if (ch === "\r") {
        cursor.x = 0;
        i++;
        continue;
      }

      putChar(ch);
      i++;
    }
  }

  function handleCSI(params: string, finalByte: string): void {
    const n = params === "" ? 1 : parseInt(params, 10) || 1;

    switch (finalByte) {
      case "A":
        cursor.y = Math.max(0, cursor.y - n);
        break;
      case "B":
        cursor.y = Math.min(rows - 1, cursor.y + n);
        break;
      case "C":
        cursor.x = Math.min(cols - 1, cursor.x + n);
        break;
      case "D":
        cursor.x = Math.max(0, cursor.x - n);
        break;
      case "H":
      case "f": {
        const parts = params.split(";");
        // VT100: absent or 0 params default to 1 (1-based).
        // ?? guards null/undefined but not "", so use || 1 after parseInt.
        const row = parseInt(parts[0] ?? "", 10) || 1;
        const col = parseInt(parts[1] ?? "", 10) || 1;
        cursor.y = Math.max(0, Math.min(rows - 1, row - 1));
        cursor.x = Math.max(0, Math.min(cols - 1, col - 1));
        break;
      }
      case "J":
        if (params === "2" || params === "3") {
          clearAll();
        } else if (params === "" || params === "0") {
          for (let x = cursor.x; x < cols; x++) setCell(cursor.y, x, { ...BLANK });
          for (let r = cursor.y + 1; r < rows; r++) clearLine(r);
        }
        break;
      case "K":
        if (params === "2") {
          clearLine(cursor.y);
        } else if (params === "" || params === "0") {
          for (let x = cursor.x; x < cols; x++) setCell(cursor.y, x, { ...BLANK });
        } else if (params === "1") {
          for (let x = 0; x <= cursor.x; x++) setCell(cursor.y, x, { ...BLANK });
        }
        break;
      case "m": {
        const codes = params === "" ? [0] : params.split(";").map(Number);
        for (const code of codes) {
          if (code === 0) {
            style.fg = null;
            style.bg = null;
            style.bold = false;
            style.dim = false;
          } else if (code === 1) style.bold = true;
          else if (code === 2) style.dim = true;
          else if (code === 22) {
            style.bold = false;
            style.dim = false;
          } else if (code >= 30 && code <= 37) style.fg = code;
          else if (code === 39) style.fg = null;
          else if (code >= 40 && code <= 47) style.bg = code;
          else if (code === 49) style.bg = null;
          else if (code >= 90 && code <= 97) style.fg = code;
          else if (code >= 100 && code <= 107) style.bg = code;
        }
        break;
      }
      case "h":
        // DECSET. Only ?1049 (alternate screen) is modeled; other private
        // modes (e.g. ?25 cursor visibility) stay no-ops.
        if (params === "?1049") enterAltScreen();
        break;
      case "l":
        // DECRST. Mirror of ?1049h.
        if (params === "?1049") exitAltScreen();
        break;
    }
  }

  function capture(): ScreenSnapshot {
    const lines = Array.from({ length: rows }, (_, r) => lineAt(r));
    const ansiLines = Array.from({ length: rows }, (_, r) => buildAnsiLine(r));
    const trimmedLines = [...lines];
    while (trimmedLines.length > 0 && trimmedLines[trimmedLines.length - 1] === "") {
      trimmedLines.pop();
    }
    return {
      lines: [...lines],
      cursor: { ...cursor },
      text: trimmedLines.join("\n"),
      ansi: ansiLines.join("\n"),
    };
  }

  return { write, lineAt, capture, cursor };
}
