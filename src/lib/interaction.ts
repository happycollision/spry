export function hasInteractiveTerminal(): boolean {
  return Boolean(
    process.stdin.isTTY && process.stdout.isTTY && process.env.TERM && process.env.TERM !== "dumb",
  );
}

/** All Spry-owned input sessions require explicit permission and a usable terminal. */
export function requireInteractive(interactive: boolean | undefined, guidance: string): void {
  let reason: string | undefined;
  if (process.env.SPRY_NON_INTERACTIVE === "1") {
    reason = "Interactive input is disabled by SPRY_NON_INTERACTIVE=1.";
  } else if (!interactive) {
    reason = "Interactive input is disabled by default; use -i, --interactive to opt in.";
  } else if (!hasInteractiveTerminal()) {
    reason = "Interactive input requires terminal stdin and stdout and a usable TERM.";
  }
  if (reason) throw new Error(`${reason}\n${guidance}`);
}
