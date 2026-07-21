import { describe, test, expect } from "bun:test";
import {
  MARKERS,
  BETA_WARNING,
  generateBodyContent,
  generateFooter,
} from "../../src/gh/pr-body.ts";
import type { CommitInfo, PRUnit } from "../../src/parse/types.ts";

function commit(hash: string, subject: string, body: string): CommitInfo {
  return { hash, subject, body, trailers: {} };
}
function singleUnit(id: string, hash: string, subject: string): PRUnit {
  return {
    type: "single",
    id,
    title: subject,
    commitIds: [id],
    commits: [hash],
    subjects: [subject],
  };
}

describe("MARKERS", () => {
  test("info marker matches the spec string exactly", () => {
    expect(MARKERS.INFO).toBe(
      "<!-- spry:info - Your edits outside of spry markers will be preserved on sync. -->",
    );
  });
});

describe("generateBodyContent", () => {
  test("single: strips trailers, keeps prose", () => {
    const unit = singleUnit("aaa11111", "abc", "Add login page");
    const commits = [
      commit("abc", "Add login page", "Implements OAuth.\n\nSpry-Commit-Id: aaa11111"),
    ];
    expect(generateBodyContent(unit, commits)).toBe("Implements OAuth.");
  });

  test("single: empty when body is only trailers", () => {
    const unit = singleUnit("aaa11111", "abc", "Subject");
    const commits = [commit("abc", "Subject", "Spry-Commit-Id: aaa11111")];
    expect(generateBodyContent(unit, commits)).toBe("");
  });

  test("group: bulleted list of subjects", () => {
    const groupUnit: PRUnit = {
      type: "group",
      id: "grp1",
      title: "G",
      commitIds: ["a", "b"],
      commits: ["aaa", "bbb"],
      subjects: ["Add A", "Add B"],
    };
    expect(generateBodyContent(groupUnit, [])).toBe("- Add A\n- Add B");
  });

  test("single: empty when the commit hash is not found", () => {
    const unit = singleUnit("aaa11111", "missing", "Subject");
    expect(generateBodyContent(unit, [])).toBe("");
  });

  test("group: empty string when there are no subjects", () => {
    const groupUnit: PRUnit = {
      type: "group",
      id: "grp1",
      title: "G",
      commitIds: [],
      commits: [],
      subjects: [],
    };
    expect(generateBodyContent(groupUnit, [])).toBe("");
  });
});

describe("generateFooter", () => {
  test("returns the beta warning", () => {
    expect(generateFooter()).toBe(BETA_WARNING);
    expect(BETA_WARNING).toContain("Do not manually merge stacked PRs.");
  });
});
