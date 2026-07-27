import { describe, test, expect } from "bun:test";
import { mapWithConcurrency } from "../../src/lib/concurrency.ts";

describe("mapWithConcurrency", () => {
  test("returns empty array for empty input without calling fn", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => {
      calls++;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  test("preserves input order even when later items resolve first", async () => {
    // Item 0 is slowest, item 2 fastest — proves results are written by index,
    // not completion order.
    const delays = [30, 10, 0];
    const out = await mapWithConcurrency([0, 1, 2], 4, async (item) => {
      await new Promise((r) => setTimeout(r, delays[item]));
      return item * 10;
    });
    expect(out).toEqual([0, 10, 20]);
  });

  test("passes the original index to fn", async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(["a", "b", "c"], 2, async (item, i) => {
      seen.push([item, i]);
      return i;
    });
    expect(seen.sort((x, y) => x[1] - y[1])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  test("never runs more than `limit` tasks concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return null;
      },
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  test("runs all items even when there are more items than the limit", async () => {
    const out = await mapWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      8,
      async (i) => i,
    );
    expect(out).toHaveLength(50);
    expect(out).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  test("a limit larger than the item count still runs everything", async () => {
    const out = await mapWithConcurrency([1, 2], 100, async (i) => i * 2);
    expect(out).toEqual([2, 4]);
  });

  test("rejects when fn rejects (matching Promise.all)", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });
});
