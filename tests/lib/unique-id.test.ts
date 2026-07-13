import { test, expect } from "bun:test";
import { generateUniqueId, createSeededRng } from "./unique-id.ts";

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
  const rngA = createSeededRng("my-test-title");
  const a = [generateUniqueId(rngA), generateUniqueId(rngA), generateUniqueId(rngA)];
  const rngB = createSeededRng("my-test-title");
  const b = [generateUniqueId(rngB), generateUniqueId(rngB), generateUniqueId(rngB)];
  expect(a).toEqual(b);
});

test("different seeds produce different sequences", () => {
  const a = generateUniqueId(createSeededRng("title-a"));
  const b = generateUniqueId(createSeededRng("title-b"));
  expect(a).not.toBe(b);
});
