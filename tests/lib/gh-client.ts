import { $ } from "bun";
import type { GhClient, CommandResult, CommandOptions } from "./context.ts";

export function createRealGhClient(): GhClient {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const proc = $`gh ${args}`.nothrow().quiet();
      if (options?.cwd) proc.cwd(options.cwd);
      if (options?.env) proc.env(options.env);
      const result = await proc;
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      };
    },
  };
}
