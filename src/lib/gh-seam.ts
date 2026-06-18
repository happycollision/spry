import { createRealGhClient } from "./context.ts";
import type { GhClient } from "./context.ts";
import { createReplayingClient } from "./replaying-client.ts";
import { createRecordingClient } from "./recording-client.ts";

export interface SeamedGhClient {
  gh: GhClient;
  flush(): Promise<void>;
}

/**
 * Build a gh client wired to the cassette seam, selected by env:
 *   SPRY_GH_CASSETTE_RECORD -> record real traffic (flush persists the cassette)
 *   SPRY_GH_CASSETTE        -> replay a committed cassette (flush is a no-op)
 *   neither                 -> real gh (flush is a no-op)
 *
 * `realClient` is injectable for tests; defaults to the live gh client.
 */
export async function createSeamedGhClient(
  env: Record<string, string | undefined> = process.env,
  realClient: GhClient = createRealGhClient(),
): Promise<SeamedGhClient> {
  if (env.SPRY_GH_CASSETTE_RECORD) {
    const recorder = createRecordingClient(realClient, env.SPRY_GH_CASSETTE_RECORD);
    return { gh: recorder, flush: () => recorder.flush() };
  }
  if (env.SPRY_GH_CASSETTE) {
    const gh = await createReplayingClient(env.SPRY_GH_CASSETTE, { match: "args" });
    return { gh, flush: async () => {} };
  }
  return { gh: realClient, flush: async () => {} };
}
