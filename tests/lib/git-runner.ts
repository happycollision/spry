import { $ } from "bun";
import type { GitRunner, CommandResult, CommandOptions } from "./context.ts";

export function createRealGitRunner(): GitRunner {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      let proc = $`git ${args}`.nothrow().quiet();
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
