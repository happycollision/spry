import { readCassette } from "./cassette.ts";
import type { GitRunner, CommandResult, CommandOptions } from "./context.ts";

export async function createReplayingClient(cassettePath: string): Promise<GitRunner> {
  const cassette = await readCassette(cassettePath);
  let index = 0;

  return {
    async run(args: string[], _options?: CommandOptions): Promise<CommandResult> {
      if (index >= cassette.entries.length) {
        throw new Error(
          `Replay: no more recorded entries (${cassette.entries.length} total). ` +
          `Unexpected call with args: [${args.join(", ")}]`,
        );
      }

      const entry = cassette.entries[index]!;

      // Verify args match
      const expectedArgs = JSON.stringify(entry.args);
      const actualArgs = JSON.stringify(args);
      if (expectedArgs !== actualArgs) {
        throw new Error(
          `Replay mismatch at entry ${index}: ` +
          `expected args ${expectedArgs}, got ${actualArgs}`,
        );
      }

      index++;
      return entry.result;
    },
  };
}
