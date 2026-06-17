import { $ } from "bun";
import type { CommandResult } from "./context.ts";

export interface RunResult {
  /** The exact CLI invocation string (e.g., "sp sync --open") — single source of truth for docs */
  command: string;
  /** The execution result */
  result: CommandResult;
}

export type SpryRunner = (
  cwd: string,
  command: string,
  args?: string[],
  options?: { env?: Record<string, string> },
) => Promise<RunResult>;

/**
 * Create a runner bound to a specific CLI entry point.
 * In tests: `createRunner("src/cli/index.ts")`
 * The runner sets SPRY_NO_TTY=1 to force non-interactive mode.
 * Callers may pass extra env (e.g. cassette seams) via `options.env`.
 */
export function createRunner(cliPath: string): SpryRunner {
  return async (cwd, command, args = [], options) => {
    let proc = $`bun run ${cliPath} ${command} ${args}`.nothrow().quiet();
    // .env() replaces the whole environment, so spread process.env to keep
    // PATH etc., then force the non-interactive flags doc tests depend on,
    // and finally layer any caller-supplied env on top.
    proc = proc.env({
      ...process.env,
      SPRY_NO_TTY: "1",
      FORCE_COLOR: "1",
      ...options?.env,
    });
    proc = proc.cwd(cwd);
    const result = await proc;

    const commandStr = args.length > 0 ? `sp ${command} ${args.join(" ")}` : `sp ${command}`;

    return {
      command: commandStr,
      result: {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      },
    };
  };
}
