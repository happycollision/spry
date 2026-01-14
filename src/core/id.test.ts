import { test, expect, describe } from "bun:test";
import { generateCommitId } from "./id.ts";

describe("core/id", () => {
  describe("generateCommitId", () => {
    test("generates unique hex IDs", () => {
      const id1 = generateCommitId();
      const id2 = generateCommitId();

      expect(id1).toMatch(/^[0-9a-f]+$/);
      expect(id2).toMatch(/^[0-9a-f]+$/);
      expect(id1).not.toBe(id2);
    });
  });
});
