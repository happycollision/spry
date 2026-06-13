/**
 * Minimal yes/no prompt. Returns true only for an explicit "y"/"yes" (default
 * is No). Reads a single line from stdin; injected in tests so no real TTY is
 * needed.
 */
export async function confirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} [y/N] `);
  const line = await new Promise<string>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(d.toString());
    });
  });
  return /^y(es)?$/i.test(line.trim());
}
