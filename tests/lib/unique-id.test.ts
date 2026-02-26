import { test, expect } from "bun:test";
import { generateUniqueId } from "./unique-id.ts";

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
