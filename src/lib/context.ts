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
  /** Explicit permission for Spry-owned pickers and confirmations; default false. */
  interactive?: boolean;
}

/**
 * Build the stdin bytes for a subprocess. Returns a buffer whenever stdin is
 * provided — including the empty string — and `undefined` only when no stdin was
 * given (the runner then supplies closed stdin).
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
 * real EOF rather than an inherited terminal. No-input commands receive EOF too;
 * Git/gh must never steal input from the caller or open an authentication prompt.
 */
async function runSubprocess(
  bin: string,
  args: string[],
  options?: CommandOptions,
): Promise<CommandResult> {
  const input = toStdinBuffer(options?.stdin);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options?.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "false",
    SSH_ASKPASS: "false",
    SSH_ASKPASS_REQUIRE: "never",
    GH_PROMPT_DISABLED: "1",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    GIT_EDITOR: "false",
    GIT_SEQUENCE_EDITOR: "false",
  };
  // Use batch authentication for the default OpenSSH transport, without replacing
  // a user's custom transport/command. Arbitrary helpers and hooks remain external
  // code: closing stdin cannot stop them from opening /dev/tty themselves.
  if (bin === "git" && ["fetch", "push", "ls-remote"].includes(args[0] ?? "")) {
    if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
      const configured = await runSubprocess(
        "git",
        ["config", "--get", "core.sshCommand"],
        options,
      );
      if (!configured.stdout.trim()) env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
    }
  }
  const proc = Bun.spawn([bin, ...args], {
    cwd: options?.cwd,
    env,
    stdin: input ?? "ignore",
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
