import { readCassette } from "./cassette.ts";
import type { GitRunner, CommandResult, CommandOptions } from "./context.ts";

export interface ReplayOptions {
  match?: "ordinal" | "args";
}

export async function createReplayingClient(
  cassettePath: string,
  options?: ReplayOptions,
): Promise<GitRunner> {
  const cassette = await readCassette(cassettePath);
  const match = options?.match ?? "ordinal";

  if (match === "args") {
    const consumed: boolean[] = cassette.entries.map(() => false);

    return {
      async run(args: string[], callOptions?: CommandOptions): Promise<CommandResult> {
        const actualArgs = JSON.stringify(args);
        const actualStdin = callOptions?.stdin ?? undefined;

        for (let i = 0; i < cassette.entries.length; i++) {
          if (consumed[i]) continue;
          const entry = cassette.entries[i];
          if (entry === undefined) continue;
          const entryStdin = entry.options?.stdin ?? undefined;
          if (JSON.stringify(entry.args) === actualArgs && entryStdin === actualStdin) {
            consumed[i] = true;
            return entry.result;
          }
        }

        throw new Error(
          `No matching recorded entry for args [${args.join(", ")}] ` +
            `(stdin: ${actualStdin === undefined ? "undefined" : JSON.stringify(actualStdin)})`,
        );
      },
    };
  }

  let index = 0;

  return {
    async run(args: string[], _options?: CommandOptions): Promise<CommandResult> {
      if (index >= cassette.entries.length) {
        throw new Error(
          `Replay: no more recorded entries (${cassette.entries.length} total). ` +
            `Unexpected call with args: [${args.join(", ")}]`,
        );
      }

      const entry = cassette.entries[index];
      if (entry === undefined) {
        throw new Error(`Replay: missing entry at index ${index}`);
      }

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
