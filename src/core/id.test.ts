import { test, expect, describe } from "bun:test";
import { generateCommitId } from "./id.ts";

describe("core/id", () => {
  describe("generateCommitId", () => {
    test("generates 8-character hex string", () => {
      const id = generateCommitId();

      expect(id).toHaveLength(8);
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
