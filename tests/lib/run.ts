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
) => Promise<RunResult>;

/**
 * Create a runner bound to a specific CLI entry point.
 * In tests: `createRunner("src/cli/index.ts")`
 * The runner sets SPRY_NO_TTY=1 to force non-interactive mode.
 */
export function createRunner(cliPath: string): SpryRunner {
  return async (cwd, command, args = []) => {
    let proc = $`SPRY_NO_TTY=1 bun run ${cliPath} ${command} ${args}`
      .nothrow()
      .quiet();
    proc = proc.cwd(cwd);
    const result = await proc;

    const commandStr = args.length > 0
      ? `sp ${command} ${args.join(" ")}`
      : `sp ${command}`;

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
