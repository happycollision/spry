import { test, expect } from "bun:test";
import { waitForValue } from "./wait-for.ts";

test("waitForValue returns immediately when the condition already holds", async () => {
  let calls = 0;
  const result = await waitForValue(
    () => {
      calls++;
      return 7;
    },
    (v) => v === 7,
    { description: "seven", sleep: async () => {} },
  );
  expect(result).toBe(7);
  expect(calls).toBe(1);
});

test("waitForValue polls until the condition holds, reading fresh each pass", async () => {
  const observed = [2, 2, 1]; // stale reads before the endpoint catches up
  let idx = 0;
  const result = await waitForValue(
    () => observed[Math.min(idx++, observed.length - 1)]!,
    (v) => v === 1,
    { description: "count == 1", attempts: 10, sleep: async () => {} },
  );
  expect(result).toBe(1);
  expect(idx).toBe(3); // read three times (fresh each pass), not cached
});

test("waitForValue throws a descriptive error after exhausting attempts", async () => {
  let calls = 0;
  await expect(
    waitForValue(
      () => {
        calls++;
        return 2;
      },
      (v) => v === 1,
      { description: "count == 1", attempts: 3, sleep: async () => {} },
    ),
  ).rejects.toThrow("count == 1");
  expect(calls).toBe(3); // exactly `attempts` reads, then give up
});
