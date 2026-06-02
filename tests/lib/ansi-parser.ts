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

export function createScreenBuffer(cols: number, rows: number): ScreenBuffer {
  const grid: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ...BLANK })),
  );
  const cursor = { x: 0, y: 0 };
  const style: Omit<Cell, "char"> = { fg: null, bg: null, bold: false, dim: false };

  function getRow(row: number): Cell[] {
    return grid[row] ?? [];
  }

  function setCell(row: number, col: number, cell: Cell): void {
    const r = grid[row];
    if (r) r[col] = cell;
  }

  function putChar(ch: string): void {
    if (cursor.y >= 0 && cursor.y < rows && cursor.x >= 0 && cursor.x < cols) {
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
        cursor.y = Math.max(0, Math.min(rows - 1, parseInt(parts[0] ?? "1", 10) - 1));
        cursor.x = Math.max(0, Math.min(cols - 1, parseInt(parts[1] ?? "1", 10) - 1));
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
      case "l":
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
