import { $ } from "bun";

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
 * Build the stdin buffer for a subprocess. Returns a buffer whenever stdin is
 * provided — including the empty string — so the child's stdin is redirected to
 * empty input rather than inherited from the parent. (An inherited terminal
 * stdin never reaches EOF, which hangs commands that read stdin, e.g.
 * `gh ... --body-file -` with an empty body.)
 */
export function toStdinBuffer(stdin: string | undefined): Buffer | undefined {
  return stdin !== undefined ? Buffer.from(stdin) : undefined;
}

export function createRealGitRunner(): GitRunner {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const input = toStdinBuffer(options?.stdin);
      let proc = input
        ? $`git ${args} < ${input}`.nothrow().quiet()
        : $`git ${args}`.nothrow().quiet();
      if (options?.cwd) proc = proc.cwd(options.cwd);
      if (options?.env) proc = proc.env(options.env);
      const result = await proc;
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      };
    },
  };
}

export function createRealGhClient(): GhClient {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const input = toStdinBuffer(options?.stdin);
      let proc = input
        ? $`gh ${args} < ${input}`.nothrow().quiet()
        : $`gh ${args}`.nothrow().quiet();
      if (options?.cwd) proc = proc.cwd(options.cwd);
      if (options?.env) proc = proc.env(options.env);
      const result = await proc;
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      };
    },
  };
}
