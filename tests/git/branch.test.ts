import { describe, test, expect } from "bun:test";
import { branchForUnit } from "../../src/git/branch.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import type { SpryConfig } from "../../src/git/config.ts";

const config: SpryConfig = {
  trunk: "main",
  remote: "origin",
  branchPrefix: "spry/test",
};

function singleUnit(id: string): PRUnit {
  return {
    type: "single",
    id,
    title: "T",
    commitIds: [id],
    commits: [id.repeat(5)],
    subjects: ["T"],
  };
}

function groupUnit(id: string): PRUnit {
  return {
    type: "group",
    id,
    title: "G",
    commitIds: [id],
    commits: [id.repeat(5)],
    subjects: ["T"],
  };
}

describe("branchForUnit", () => {
  test("returns <prefix>/<unit-id> for single units", () => {
    expect(branchForUnit(singleUnit("a1b2c3d4"), config)).toBe("spry/test/a1b2c3d4");
  });

  test("returns <prefix>/<unit-id> for group units", () => {
    expect(branchForUnit(groupUnit("grp00001"), config)).toBe("spry/test/grp00001");
  });

  test("works with prefixes containing slashes", () => {
    const prefixed: SpryConfig = { ...config, branchPrefix: "spry/dondenton" };
    expect(branchForUnit(singleUnit("a1"), prefixed)).toBe("spry/dondenton/a1");
  });

  test("throws on prefix that produces invalid branch names", () => {
    const bad: SpryConfig = { ...config, branchPrefix: "with spaces" };
    expect(() => branchForUnit(singleUnit("a1"), bad)).toThrow(/Invalid derived branch name/);
  });
});
