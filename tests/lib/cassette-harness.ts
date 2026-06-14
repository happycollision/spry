import { join } from "node:path";

// Committed cassette directory. Absolute (derived from this file's location) so
// the path is stable regardless of the process cwd.
const CASSETTES_DIR = join(import.meta.dir, "../fixtures/cassettes");

/**
 * Path to a committed cassette, keyed by doc section + order the same way
 * `fragmentPath` keys doc fragments: "/" in the section becomes "__", and the
 * order is zero-padded to 3 digits.
 *
 * e.g. { section: "commands/sync", order: 20 } ->
 *   <repoRoot>/tests/fixtures/cassettes/commands__sync--020.json
 */
export function cassettePath({ section, order }: { section: string; order: number }): string {
  const keyedSection = section.replaceAll("/", "__");
  const keyedOrder = String(order).padStart(3, "0");
  return join(CASSETTES_DIR, `${keyedSection}--${keyedOrder}.json`);
}

/** True when running in record mode (`SPRY_RECORD=1`). */
export function isRecording(): boolean {
  return process.env.SPRY_RECORD === "1";
}

/**
 * Env block to hand a subprocess so it records or replays the right cassette.
 * Record mode points the gh seam at SPRY_GH_CASSETTE_RECORD; replay (default)
 * points it at SPRY_GH_CASSETTE.
 */
export function cassetteEnv({
  section,
  order,
}: {
  section: string;
  order: number;
}): Record<string, string> {
  const path = cassettePath({ section, order });
  return isRecording() ? { SPRY_GH_CASSETTE_RECORD: path } : { SPRY_GH_CASSETTE: path };
}
