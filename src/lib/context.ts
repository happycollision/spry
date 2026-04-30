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

export function createRealGitRunner(): GitRunner {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const input = options?.stdin ? Buffer.from(options.stdin) : undefined;
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
      let proc = $`gh ${args}`.nothrow().quiet();
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
