import { writeCassette } from "./cassette.ts";
import type { CommandResult, CommandOptions, GitRunner } from "./context.ts";
import type { CassetteEntry } from "./cassette.ts";

export interface RecordingClient extends GitRunner {
  flush(): Promise<void>;
}

export function createRecordingClient(inner: GitRunner, cassettePath: string): RecordingClient {
  const entries: CassetteEntry[] = [];

  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const result = await inner.run(args, options);
      entries.push({ args, options, result });
      // Persist after every call so a recording survives a command that
      // process.exit()s before the seam's flush() in finally can run.
      await writeCassette(cassettePath, { entries });
      return result;
    },
    async flush(): Promise<void> {
      await writeCassette(cassettePath, { entries });
    },
  };
}
