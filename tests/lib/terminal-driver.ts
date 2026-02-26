import { createScreenBuffer } from "./ansi-parser.ts";
import type { ScreenSnapshot } from "./ansi-parser.ts";

export interface TerminalDriverOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface TerminalDriver {
  type(text: string): void;
  press(key: string): void;
  waitForText(text: string, options?: { timeout?: number }): Promise<void>;
  capture(): ScreenSnapshot;
  close(): Promise<void>;
}

const KEY_MAP: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Enter: "\r",
  Return: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Backspace: "\x7f",
  Space: " ",
  Home: "\x1b[H",
  End: "\x1b[F",
  "Shift+ArrowUp": "\x1b[1;2A",
  "Shift+ArrowDown": "\x1b[1;2B",
  "Ctrl+c": "\x03",
  "Ctrl+d": "\x04",
};

export async function createTerminalDriver(
  command: string,
  args: string[],
  options?: TerminalDriverOptions,
): Promise<TerminalDriver> {
  const cols = options?.cols ?? 80;
  const rows = options?.rows ?? 24;
  const screen = createScreenBuffer(cols, rows);

  const proc = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        const text =
          typeof data === "string" ? data : new TextDecoder().decode(data);
        screen.write(text);
      },
    },
  });

  function type(text: string): void {
    proc.terminal!.write(text);
  }

  function press(key: string): void {
    const sequence = KEY_MAP[key];
    if (sequence) {
      type(sequence);
    } else if (key.length === 1) {
      type(key);
    } else {
      throw new Error(
        `Unknown key: "${key}". Use KEY_MAP entries or single characters.`,
      );
    }
  }

  async function waitForText(
    text: string,
    opts?: { timeout?: number },
  ): Promise<void> {
    const timeout = opts?.timeout ?? 5000;
    const pollInterval = 50;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const snapshot = screen.capture();
      if (snapshot.text.includes(text)) return;
      await Bun.sleep(pollInterval);
    }

    const snapshot = screen.capture();
    throw new Error(
      `Timeout waiting for text "${text}" after ${timeout}ms.\n` +
        `Current screen:\n${snapshot.text}`,
    );
  }

  function capture(): ScreenSnapshot {
    return screen.capture();
  }

  async function close(): Promise<void> {
    try {
      proc.terminal?.close();
    } catch {
      /* may have exited */
    }
    try {
      proc.kill();
    } catch {
      /* may have exited */
    }
    await proc.exited;
  }

  return { type, press, waitForText, capture, close };
}
