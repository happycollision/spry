import { test, expect } from "bun:test";
import { generateUniqueId, seedUniqueId, resetUniqueIdSeed } from "./unique-id.ts";

test("generates string in adjective-noun-suffix format", () => {
  const id = generateUniqueId();
  const parts = id.split("-");
  expect(parts.length).toBe(3);
  expect(parts[0]!.length).toBeGreaterThan(0);
  expect(parts[1]!.length).toBeGreaterThan(0);
  expect(parts[2]!.length).toBeGreaterThan(0);
});

test("generates unique IDs across 100 calls", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateUniqueId()));
  expect(ids.size).toBe(100);
});

test("seeded generator is deterministic across runs", () => {
  seedUniqueId("my-test-title");
  const a = [generateUniqueId(), generateUniqueId(), generateUniqueId()];
  seedUniqueId("my-test-title");
  const b = [generateUniqueId(), generateUniqueId(), generateUniqueId()];
  expect(a).toEqual(b);
  resetUniqueIdSeed();
});

test("different seeds produce different sequences", () => {
  seedUniqueId("title-a");
  const a = generateUniqueId();
  seedUniqueId("title-b");
  const b = generateUniqueId();
  expect(a).not.toBe(b);
  resetUniqueIdSeed();
});
