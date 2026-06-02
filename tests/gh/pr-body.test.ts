import { describe, test, expect } from "bun:test";
import { formatPRTitle, formatPRBody, stripTrailers } from "../../src/gh/pr-body.ts";
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

describe("stripTrailers", () => {
  test("returns body unchanged when there are no trailers", () => {
    expect(stripTrailers("Just prose.\nMore prose.")).toBe("Just prose.\nMore prose.");
  });

  test("strips a contiguous trailer block at the end", () => {
    const body = "Prose paragraph.\n\nSpry-Commit-Id: aaa11111\nCo-Authored-By: A <a@x>";
    expect(stripTrailers(body)).toBe("Prose paragraph.");
  });

  test("strips ALL trailer types (Spry, Co-Authored-By, Signed-off-by)", () => {
    const body =
      "Description.\n\nSigned-off-by: B <b@x>\nCo-Authored-By: A <a@x>\nSpry-Commit-Id: aaa11111";
    expect(stripTrailers(body)).toBe("Description.");
  });

  test("returns empty string when body is only trailers", () => {
    const body = "Spry-Commit-Id: aaa11111\nCo-Authored-By: A <a@x>";
    expect(stripTrailers(body)).toBe("");
  });

  test("does not strip a line that looks like a trailer but is not at the end", () => {
    const body = "Discussion: see ticket #1\n\nThis paragraph follows.";
    expect(stripTrailers(body)).toBe("Discussion: see ticket #1\n\nThis paragraph follows.");
  });

  test("requires a blank line before the trailer block", () => {
    const body = "Prose ends here.\nSpry-Commit-Id: aaa11111";
    // No blank line → not a real trailer block; keep as-is (sans trailing whitespace)
    expect(stripTrailers(body)).toBe("Prose ends here.\nSpry-Commit-Id: aaa11111");
  });

  test("trims trailing blank lines", () => {
    expect(stripTrailers("Prose.\n\n\n")).toBe("Prose.");
  });
});

describe("formatPRTitle", () => {
  test("returns commit subject for a single unit", () => {
    const unit = singleUnit("aaa11111", "abc", "Add login page");
    const commits = [commit("abc", "Add login page", "")];
    expect(formatPRTitle(unit, commits)).toBe("Add login page");
  });

  test("falls back to unit.title when commit not found in list", () => {
    const unit = singleUnit("aaa11111", "missing", "Cached title");
    expect(formatPRTitle(unit, [])).toBe("Cached title");
  });
});

describe("formatPRBody", () => {
  test("returns commit prose with trailers stripped", () => {
    const unit = singleUnit("aaa11111", "abc", "Add login page");
    const commits = [
      commit(
        "abc",
        "Add login page",
        "Implements OAuth via the platform SDK.\n\nSpry-Commit-Id: aaa11111",
      ),
    ];
    expect(formatPRBody(unit, commits)).toBe("Implements OAuth via the platform SDK.");
  });

  test("returns empty string when commit has no body", () => {
    const unit = singleUnit("aaa11111", "abc", "Subject");
    const commits = [commit("abc", "Subject", "")];
    expect(formatPRBody(unit, commits)).toBe("");
  });

  test("returns empty string for a group unit", () => {
    const groupUnit: PRUnit = {
      type: "group",
      id: "grp1",
      title: "G",
      commitIds: ["a", "b"],
      commits: ["aaa", "bbb"],
      subjects: ["A", "B"],
    };
    expect(formatPRBody(groupUnit, [])).toBe("");
  });
});
