/**
 * Terminal utilities for raw mode input handling and ANSI output.
 */

export interface Keypress {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  raw: string;
}

/**
 * ANSI escape codes for terminal control.
 */
export const ansi = {
  // Cursor control
  cursorUp: (n = 1) => `\x1b[${n}A`,
  cursorDown: (n = 1) => `\x1b[${n}B`,
  cursorForward: (n = 1) => `\x1b[${n}C`,
  cursorBack: (n = 1) => `\x1b[${n}D`,
  cursorTo: (row: number, col: number) => `\x1b[${row};${col}H`,
  cursorHome: "\x1b[H",
  cursorHide: "\x1b[?25l",
  cursorShow: "\x1b[?25h",
  saveCursor: "\x1b7",
  restoreCursor: "\x1b8",

  // Screen control
  clearScreen: "\x1b[2J",
  clearLine: "\x1b[2K",
  clearToEnd: "\x1b[0J",
  clearToLineEnd: "\x1b[0K",

  // Colors (foreground)
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",

  // Foreground colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",

  // Bright foreground colors
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",

  // Background colors
  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgWhite: "\x1b[47m",
};

/**
 * Color helper functions.
 */
export const colors = {
  reset: (s: string) => `${ansi.reset}${s}${ansi.reset}`,
  bold: (s: string) => `${ansi.bold}${s}${ansi.reset}`,
  dim: (s: string) => `${ansi.dim}${s}${ansi.reset}`,
  italic: (s: string) => `${ansi.italic}${s}${ansi.reset}`,
  underline: (s: string) => `${ansi.underline}${s}${ansi.reset}`,
  inverse: (s: string) => `${ansi.inverse}${s}${ansi.reset}`,

  black: (s: string) => `${ansi.black}${s}${ansi.reset}`,
  red: (s: string) => `${ansi.red}${s}${ansi.reset}`,
  green: (s: string) => `${ansi.green}${s}${ansi.reset}`,
  yellow: (s: string) => `${ansi.yellow}${s}${ansi.reset}`,
  blue: (s: string) => `${ansi.blue}${s}${ansi.reset}`,
  magenta: (s: string) => `${ansi.magenta}${s}${ansi.reset}`,
  cyan: (s: string) => `${ansi.cyan}${s}${ansi.reset}`,
  white: (s: string) => `${ansi.white}${s}${ansi.reset}`,

  brightBlack: (s: string) => `${ansi.brightBlack}${s}${ansi.reset}`,
  brightRed: (s: string) => `${ansi.brightRed}${s}${ansi.reset}`,
  brightGreen: (s: string) => `${ansi.brightGreen}${s}${ansi.reset}`,
  brightYellow: (s: string) => `${ansi.brightYellow}${s}${ansi.reset}`,
  brightBlue: (s: string) => `${ansi.brightBlue}${s}${ansi.reset}`,
  brightMagenta: (s: string) => `${ansi.brightMagenta}${s}${ansi.reset}`,
  brightCyan: (s: string) => `${ansi.brightCyan}${s}${ansi.reset}`,
  brightWhite: (s: string) => `${ansi.brightWhite}${s}${ansi.reset}`,
};

/**
 * Parse raw stdin data into a keypress object.
 * Handles escape sequences for arrow keys, special keys, etc.
 */
export function parseKeypress(data: Buffer): Keypress {
  const raw = data.toString();
  const bytes = [...data];

  // Default keypress
  const key: Keypress = {
    name: "",
    ctrl: false,
    shift: false,
    meta: false,
    raw,
  };

  // Single byte - regular character or control character
  if (bytes.length === 1) {
    const byte = bytes[0];

    // Special single-byte keys (check these BEFORE ctrl+key)
    switch (byte) {
      case 0x09: // Tab
        key.name = "tab";
        return key;
      case 0x0a: // LF (Enter on some terminals/systems)
      case 0x0d: // CR (Enter)
        key.name = "return";
        return key;
      case 0x1b: // Escape (alone)
        key.name = "escape";
        return key;
      case 0x7f: // Backspace (some terminals)
        key.name = "backspace";
        return key;
      case 0x20: // Space
        key.name = "space";
        return key;
    }

    // Ctrl+key (0x01-0x1A, but special keys above are already handled)
    if (byte !== undefined && byte >= 1 && byte <= 26) {
      key.ctrl = true;
      key.name = String.fromCharCode(byte + 96); // Convert to letter
      return key;
    }

    // Regular printable character
    key.name = raw;
    return key;
  }

  // Escape sequences
  if (bytes[0] === 0x1b) {
    // CSI sequences (ESC [ ...)
    if (bytes[1] === 0x5b) {
      // Arrow keys
      switch (bytes[2]) {
        case 0x41: // Up
          key.name = "up";
          return key;
        case 0x42: // Down
          key.name = "down";
          return key;
        case 0x43: // Right
          key.name = "right";
          return key;
        case 0x44: // Left
          key.name = "left";
          return key;
        case 0x48: // Home
          key.name = "home";
          return key;
        case 0x46: // End
          key.name = "end";
          return key;
      }

      // Extended sequences (ESC [ n ~)
      if (bytes.length >= 4 && bytes[3] === 0x7e) {
        switch (bytes[2]) {
          case 0x31: // Home (some terminals)
            key.name = "home";
            return key;
          case 0x32: // Insert
            key.name = "insert";
            return key;
          case 0x33: // Delete
            key.name = "delete";
            return key;
          case 0x34: // End (some terminals)
            key.name = "end";
            return key;
          case 0x35: // Page Up
            key.name = "pageup";
            return key;
          case 0x36: // Page Down
            key.name = "pagedown";
            return key;
        }
      }

      // Shift+arrow keys (ESC [ 1 ; 2 X)
      if (bytes.length >= 6 && bytes[2] === 0x31 && bytes[3] === 0x3b && bytes[4] === 0x32) {
        key.shift = true;
        switch (bytes[5]) {
          case 0x41:
            key.name = "up";
            return key;
          case 0x42:
            key.name = "down";
            return key;
          case 0x43:
            key.name = "right";
            return key;
          case 0x44:
            key.name = "left";
            return key;
        }
      }

      // Ctrl+arrow keys (ESC [ 1 ; 5 X)
      if (bytes.length >= 6 && bytes[2] === 0x31 && bytes[3] === 0x3b && bytes[4] === 0x35) {
        key.ctrl = true;
        switch (bytes[5]) {
          case 0x41:
            key.name = "up";
            return key;
          case 0x42:
            key.name = "down";
            return key;
          case 0x43:
            key.name = "right";
            return key;
          case 0x44:
            key.name = "left";
            return key;
        }
      }

      // Alt/Option+arrow keys (ESC [ 1 ; 3 X)
      if (bytes.length >= 6 && bytes[2] === 0x31 && bytes[3] === 0x3b && bytes[4] === 0x33) {
        key.meta = true;
        switch (bytes[5]) {
          case 0x41:
            key.name = "up";
            return key;
          case 0x42:
            key.name = "down";
            return key;
          case 0x43:
            key.name = "right";
            return key;
          case 0x44:
            key.name = "left";
            return key;
        }
      }
    }

    // Meta+key (ESC followed by character)
    const secondByte = bytes[1];
    if (bytes.length === 2 && secondByte !== undefined && secondByte >= 0x20 && secondByte < 0x7f) {
      key.meta = true;
      key.name = String.fromCharCode(secondByte);
      return key;
    }
  }

  // Unknown sequence
  key.name = raw;
  return key;
}

/**
 * Enable raw mode on stdin.
 * Returns a function to restore the original mode.
 */
export function enableRawMode(): () => void {
  if (!process.stdin.isTTY) {
    throw new Error("stdin is not a TTY - cannot enable raw mode");
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();

  return () => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
}

/**
 * Clear the screen and move cursor to home position.
 */
export function clearScreen(): void {
  process.stdout.write(ansi.clearScreen + ansi.cursorHome);
}

/**
 * Move cursor to a specific position.
 */
export function moveCursor(row: number, col: number): void {
  process.stdout.write(ansi.cursorTo(row, col));
}

/**
 * Hide the cursor.
 */
export function hideCursor(): void {
  process.stdout.write(ansi.cursorHide);
}

/**
 * Show the cursor.
 */
export function showCursor(): void {
  process.stdout.write(ansi.cursorShow);
}

/**
 * Write text to stdout.
 */
export function write(text: string): void {
  process.stdout.write(text);
}

/**
 * Get the terminal size.
 */
export function getTerminalSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

/**
 * Check if stdin is a TTY.
 * Respects SPRY_NO_TTY=1 environment variable to force non-interactive mode.
 */
export function isTTY(): boolean {
  if (process.env.SPRY_NO_TTY === "1") {
    return false;
  }
  return !!process.stdin.isTTY;
}
