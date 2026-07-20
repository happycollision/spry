import { join } from "node:path";

// Committed cassette directory. Absolute (derived from this file's location) so
// the path is stable regardless of the process cwd.
const CASSETTES_DIR = join(import.meta.dir, "../fixtures/cassettes");

/**
 * Sanitizes a doc section + order into a single ref-safe, filename-safe token:
 * "/" in the section becomes "__", and the order is zero-padded to 3 digits.
 * e.g. { section: "commands/sync", order: 20 } -> "commands__sync--020".
 *
 * This is the ONE place that turns (section, order) into a key. `cassettePath`
 * uses it for the cassette filename, `fragmentPath` (tests/lib/doc.ts) for the
 * doc-fragment filename, and `setupDocRepo` (tests/lib/doc-repo.ts) for the
 * per-test GitHub namespace (trunk branch, spry branch prefix, remote refs
 * prefix) — sharing this function is what keeps all three keyings identical
 * by construction rather than by convention. The result is also a
 * valid git ref path component (no `..`, no leading/trailing `/`, no
 * `~^:?*[\`, no `@{`, no `//`; only `_` and `-` besides alphanumerics), which
 * `setupDocRepo` depends on since the key is embedded in ref names like
 * `trunk/<key>` and `spry/t-<key>/`.
 */
export function cassetteKey({ section, order }: { section: string; order: number }): string {
  const keyedSection = section.replaceAll("/", "__");
  const keyedOrder = String(order).padStart(3, "0");
  return `${keyedSection}--${keyedOrder}`;
}

/**
 * Path to a committed cassette, keyed by doc section + order the same way
 * `fragmentPath` keys doc fragments (see {@link cassetteKey}).
 *
 * e.g. { section: "commands/sync", order: 20 } ->
 *   <repoRoot>/tests/fixtures/cassettes/commands__sync--020.json
 */
export function cassettePath({ section, order }: { section: string; order: number }): string {
  return join(CASSETTES_DIR, `${cassetteKey({ section, order })}.json`);
}

/** True when running in record mode (`SPRY_RECORD=1`). */
export function isRecording(): boolean {
  return process.env.SPRY_RECORD === "1";
}

/**
 * Env block to hand a subprocess so it records or replays the right cassette.
 * Record mode points the gh seam at SPRY_GH_CASSETTE_RECORD; replay (default)
 * points it at SPRY_GH_CASSETTE.
 *
 * `recording` defaults to the global `isRecording()`, but callers that already
 * carry an explicit record/replay decision (e.g. `setupDocRepo`'s `recording`
 * option) should pass it through so the env can never contradict the rest of
 * their setup.
 */
export function cassetteEnv({
  section,
  order,
  recording = isRecording(),
}: {
  section: string;
  order: number;
  recording?: boolean;
}): Record<string, string> {
  const path = cassettePath({ section, order });
  return recording ? { SPRY_GH_CASSETTE_RECORD: path } : { SPRY_GH_CASSETTE: path };
}
