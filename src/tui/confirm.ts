import { requireInteractive } from "../lib/interaction.ts";
import { readTerminalInput } from "./input.ts";

/**
 * Minimal yes/no prompt. Returns true only for an explicit "y"/"yes" (default
 * is No). Reads a single line from stdin; injected in tests so no real TTY is
 * needed.
 */
export async function confirm(message: string, interactive = false): Promise<boolean> {
  requireInteractive(
    interactive,
    "  Supply the explicit command option instead of confirming at a prompt.",
  );
  process.stdout.write(`${message} [y/N] `);
  process.stdin.resume();
  try {
    const line = await readTerminalInput<string>((data, finish) => finish(data.toString()));
    return /^y(es)?$/i.test(line.trim());
  } finally {
    process.stdin.pause();
  }
}
