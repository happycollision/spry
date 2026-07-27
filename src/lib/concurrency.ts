/**
 * Run `fn` over every item with at most `limit` invocations in flight at once,
 * preserving input order in the returned results array. A bounded pool (not a
 * bare `Promise.all`) so network fan-out — e.g. `gh` subprocess spawns — stays
 * capped well under GitHub's secondary rate limits on a deep stack.
 *
 * `fn` receives each item's original index alongside the item. Results are
 * written back at that index, so `results[k]` is always `fn(items[k], k)`'s
 * value regardless of which task resolves first. A rejecting `fn` rejects the
 * whole call (matching `Promise.all`); callers that want per-item best-effort
 * should catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      if (item === undefined) continue;
      results[i] = await fn(item, i);
    }
  }
  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
