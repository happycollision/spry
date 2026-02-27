// tests/parse/stack.test.ts
import { test, expect, describe } from "bun:test";
import { detectPRUnits, parseStack, type CommitWithTrailers } from "../../src/parse/stack.ts";

function makeCommit(
  hash: string,
  subject: string,
  trailers: Record<string, string> = {},
): CommitWithTrailers {
  return { hash, subject, body: subject, trailers };
}

describe("detectPRUnits", () => {
  test("returns empty array for empty commits", () => {
    expect(detectPRUnits([])).toEqual([]);
  });

  test("creates singles for commits without group trailers", () => {
    const commits = [
      makeCommit("aaa111", "Add user model", { "Spry-Commit-Id": "a1b2c3d4" }),
      makeCommit("bbb222", "Add auth", { "Spry-Commit-Id": "b2c3d4e5" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ type: "single", id: "a1b2c3d4", commits: ["aaa111"] });
    expect(units[1]).toMatchObject({ type: "single", id: "b2c3d4e5", commits: ["bbb222"] });
  });

  test("creates group for contiguous commits with same Spry-Group", () => {
    const commits = [
      makeCommit("aaa111", "Start auth", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "Add login", { "Spry-Commit-Id": "b2", "Spry-Group": "g1" }),
      makeCommit("ccc333", "Add 2FA", { "Spry-Commit-Id": "c3", "Spry-Group": "g1" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      type: "group",
      id: "g1",
      commits: ["aaa111", "bbb222", "ccc333"],
    });
  });

  test("handles mixed singles and groups", () => {
    const commits = [
      makeCommit("aaa111", "Single", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "Group start", { "Spry-Commit-Id": "b2", "Spry-Group": "g1" }),
      makeCommit("ccc333", "Group end", { "Spry-Commit-Id": "c3", "Spry-Group": "g1" }),
      makeCommit("ddd444", "Another single", { "Spry-Commit-Id": "d4" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(3);
    expect(units[0]).toMatchObject({ type: "single", id: "a1" });
    expect(units[1]).toMatchObject({ type: "group", id: "g1" });
    expect(units[2]).toMatchObject({ type: "single", id: "d4" });
  });

  test("handles multiple consecutive groups", () => {
    const commits = [
      makeCommit("aaa111", "G1 c1", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "G1 c2", { "Spry-Commit-Id": "b2", "Spry-Group": "g1" }),
      makeCommit("ccc333", "G2 c1", { "Spry-Commit-Id": "c3", "Spry-Group": "g2" }),
      makeCommit("ddd444", "G2 c2", { "Spry-Commit-Id": "d4", "Spry-Group": "g2" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ type: "group", id: "g1" });
    expect(units[1]).toMatchObject({ type: "group", id: "g2" });
  });

  test("handles commits without Spry-Commit-Id (uses hash prefix)", () => {
    const commits = [makeCommit("aaa111bb", "No ID", {})];
    const units = detectPRUnits(commits);
    expect(units[0]).toMatchObject({ id: "aaa111bb", commitIds: [] });
  });

  test("preserves oldest-first order", () => {
    const commits = [
      makeCommit("first", "First", { "Spry-Commit-Id": "id1" }),
      makeCommit("second", "Second", { "Spry-Commit-Id": "id2" }),
      makeCommit("third", "Third", { "Spry-Commit-Id": "id3" }),
    ];
    expect(detectPRUnits(commits).map((u) => u.commits[0])).toEqual(["first", "second", "third"]);
  });

  test("single-commit group", () => {
    const commits = [
      makeCommit("aaa111", "Lone grouped", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ type: "group", id: "g1" });
  });

  test("uses title from GroupTitles when provided", () => {
    const commits = [
      makeCommit("aaa111", "First subject", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
    ];
    const units = detectPRUnits(commits, { g1: "Custom Title" });
    expect(units[0]?.title).toBe("Custom Title");
  });

  test("title is undefined when no GroupTitles entry", () => {
    const commits = [
      makeCommit("aaa111", "First subject", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
    ];
    const units = detectPRUnits(commits, {});
    expect(units[0]?.title).toBeUndefined();
  });

  test("single commits use their subject as title", () => {
    const commits = [makeCommit("aaa111", "My commit", { "Spry-Commit-Id": "a1" })];
    expect(detectPRUnits(commits)[0]?.title).toBe("My commit");
  });
});

describe("parseStack", () => {
  test("returns ok for valid stack", () => {
    const commits = [
      makeCommit("aaa111", "First", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "Second", { "Spry-Commit-Id": "b2" }),
    ];
    const result = parseStack(commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.units).toHaveLength(2);
  });

  test("returns ok for valid groups", () => {
    const commits = [
      makeCommit("aaa111", "G1", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "G1", { "Spry-Commit-Id": "b2", "Spry-Group": "g1" }),
    ];
    const result = parseStack(commits);
    expect(result.ok).toBe(true);
  });

  test("returns split-group error for non-contiguous group", () => {
    const commits = [
      makeCommit("aaa111", "Group c1", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "Interrupting", { "Spry-Commit-Id": "b2" }),
      makeCommit("ccc333", "Group c2", { "Spry-Commit-Id": "c3", "Spry-Group": "g1" }),
    ];
    const result = parseStack(commits);
    expect(result).toMatchObject({ ok: false, error: "split-group", group: { id: "g1" } });
    if (!result.ok && result.error === "split-group") {
      expect(result.group.commits).toContain("aaa111");
      expect(result.group.commits).toContain("ccc333");
      expect(result.interruptingCommits).toContain("bbb222");
    }
  });

  test("split-group with multiple interrupting commits", () => {
    const commits = [
      makeCommit("aaa111", "Group c1", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "Int 1", { "Spry-Commit-Id": "b2" }),
      makeCommit("ccc333", "Int 2", { "Spry-Commit-Id": "c3" }),
      makeCommit("ddd444", "Group c2", { "Spry-Commit-Id": "d4", "Spry-Group": "g1" }),
    ];
    const result = parseStack(commits);
    expect(result).toMatchObject({ ok: false, error: "split-group" });
    if (!result.ok && result.error === "split-group") {
      expect(result.interruptingCommits).toHaveLength(2);
    }
  });

  test("returns ok for empty commits", () => {
    const result = parseStack([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.units).toEqual([]);
  });
});
