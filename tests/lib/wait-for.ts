/**
 * Condition-based waiting for GitHub's eventually-consistent read APIs.
 *
 * GitHub's Contents / git-refs / commits endpoints lag behind a write: a read
 * issued immediately after a ref PATCH (or a fresh README push) can return the
 * stale pre-write value before its replicas catch up. Asserting a single such
 * read is flaky. `waitForValue` re-reads (fresh every pass — never caches) until
 * the value satisfies `predicate`, then returns it; it throws a descriptive
 * error once `attempts` reads have all failed.
 *
 * The `sleep` seam is injectable so unit tests can drive the poll loop without
 * real delays; production callers get the default `Bun.sleep`-backed wait.
 */
export interface WaitForOptions {
  /** Human-readable description of the awaited condition, used in the timeout error. */
  description: string;
  /** Maximum number of reads before giving up. Default 10. */
  attempts?: number;
  /** Delay between reads, in ms. Default 500. */
  intervalMs?: number;
  /** Injectable delay (tests pass a no-op). Default sleeps `intervalMs`. */
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForValue<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options: WaitForOptions,
): Promise<T> {
  const attempts = options.attempts ?? 10;
  const intervalMs = options.intervalMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  let last: T | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await read();
    if (predicate(last)) return last;
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${options.description} after ${attempts} attempts ` +
      `(last observed: ${JSON.stringify(last)})`,
  );
}
