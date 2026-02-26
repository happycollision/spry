export interface ScreenSnapshot {
  lines: string[];
  cursor: { x: number; y: number };
  text: string;
}

export interface ScreenBuffer {
  write(data: string): void;
  lineAt(row: number): string;
  capture(): ScreenSnapshot;
  cursor: { x: number; y: number };
}

export function createScreenBuffer(cols: number, rows: number): ScreenBuffer {
  const grid: string[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => " "),
  );
  const cursor = { x: 0, y: 0 };

  function putChar(ch: string): void {
    if (cursor.y >= 0 && cursor.y < rows && cursor.x >= 0 && cursor.x < cols) {
      grid[cursor.y]![cursor.x] = ch;
    }
    cursor.x++;
    if (cursor.x >= cols) {
      cursor.x = 0;
      cursor.y++;
    }
  }

  function clearLine(row: number): void {
    if (row >= 0 && row < rows) {
      for (let i = 0; i < cols; i++) grid[row]![i] = " ";
    }
  }

  function clearAll(): void {
    for (let r = 0; r < rows; r++) clearLine(r);
  }

  function lineAt(row: number): string {
    if (row < 0 || row >= rows) return "";
    return grid[row]!.join("").trimEnd();
  }

  function write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;

      if (ch === "\x1b") {
        i++;
        if (i >= data.length) break;
        const next = data[i]!;

        if (next === "[") {
          i++;
          let params = "";
          while (i < data.length && data[i]! >= "\x20" && data[i]! <= "\x3f") {
            params += data[i]!;
            i++;
          }
          if (i >= data.length) break;
          const finalByte = data[i]!;
          i++;
          handleCSI(params, finalByte);
        } else if (next === "7" || next === "8") {
          i++; // Save/restore cursor — no-op
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
        cursor.y = Math.max(
          0,
          Math.min(rows - 1, parseInt(parts[0] || "1", 10) - 1),
        );
        cursor.x = Math.max(
          0,
          Math.min(cols - 1, parseInt(parts[1] || "1", 10) - 1),
        );
        break;
      }
      case "J":
        if (params === "2" || params === "3") {
          clearAll();
        } else if (params === "" || params === "0") {
          for (let x = cursor.x; x < cols; x++) grid[cursor.y]![x] = " ";
          for (let r = cursor.y + 1; r < rows; r++) clearLine(r);
        }
        break;
      case "K":
        if (params === "2") {
          clearLine(cursor.y);
        } else if (params === "" || params === "0") {
          for (let x = cursor.x; x < cols; x++) grid[cursor.y]![x] = " ";
        } else if (params === "1") {
          for (let x = 0; x <= cursor.x; x++) grid[cursor.y]![x] = " ";
        }
        break;
      case "m":
        break; // SGR — ignore
      case "h":
        break; // Set mode — ignore
      case "l":
        break; // Reset mode — ignore
    }
  }

  function capture(): ScreenSnapshot {
    const lines = Array.from({ length: rows }, (_, r) => lineAt(r));
    return {
      lines: [...lines],
      cursor: { ...cursor },
      text: lines.join("\n"),
    };
  }

  return { write, lineAt, capture, cursor };
}
