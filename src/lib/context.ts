export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface GitRunner {
  run(args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface GhClient {
  run(args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface SpryContext {
  git: GitRunner;
  gh: GhClient;
}

/**
 * Build the stdin bytes for a subprocess. Returns a buffer whenever stdin is
 * provided — including the empty string — and `undefined` only when no stdin was
 * given (the child then inherits the parent's stdin).
 *
 * The empty-string case matters: it must still produce a buffer so the child is
 * handed an explicit, immediately-EOF stdin. Handing the parent's stdin to a
 * command that reads stdin (e.g. `gh ... --body-file -` with an empty PR body)
 * hangs forever when that inherited stdin is a terminal that never reaches EOF.
 */
export function toStdinBuffer(stdin: string | undefined): Buffer | undefined {
  return stdin !== undefined ? Buffer.from(stdin) : undefined;
}

/**
 * Run a subprocess and capture its output.
 *
 * Uses `Bun.spawn` (not the `$` shell) specifically because of stdin: `$`'s
 * `< ${buffer}` redirect is a no-op for an EMPTY buffer, which silently leaves
 * the child inheriting the parent's stdin. `Bun.spawn` with an explicit byte
 * stdin always feeds those bytes and closes the stream, so an empty stdin is a
 * real EOF rather than an inherited terminal. When no stdin is given we inherit,
 * matching the previous behavior for the (common) no-stdin commands.
 */
async function runSubprocess(
  bin: string,
  args: string[],
  options?: CommandOptions,
): Promise<CommandResult> {
  const input = toStdinBuffer(options?.stdin);
  const proc = Bun.spawn([bin, ...args], {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : process.env,
    stdin: input ?? "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export function createRealGitRunner(): GitRunner {
  return {
    run: (args: string[], options?: CommandOptions) => runSubprocess("git", args, options),
  };
}

export function createRealGhClient(): GhClient {
  return {
    run: (args: string[], options?: CommandOptions) => runSubprocess("gh", args, options),
  };
}
