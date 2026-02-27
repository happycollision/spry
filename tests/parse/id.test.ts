import { test, expect, describe } from "bun:test";
import { generateCommitId } from "../../src/parse/id.ts";

describe("parse/id", () => {
  test("generates 8-character hex string", () => {
    const id = generateCommitId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("generates unique IDs", () => {
    const id1 = generateCommitId();
    const id2 = generateCommitId();
    expect(id1).not.toBe(id2);
  });

  test("generates unique IDs across 100 calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCommitId()));
    expect(ids.size).toBe(100);
  });
});
