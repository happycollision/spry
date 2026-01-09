import { test, expect, describe } from "bun:test";
import { detectPRUnits, parseStack, type CommitWithTrailers } from "./stack.ts";

function makeCommit(
  hash: string,
  subject: string,
  trailers: Record<string, string> = {},
): CommitWithTrailers {
  return {
    hash,
    subject,
    body: subject,
    trailers,
  };
}

describe("core/stack", () => {
  describe("detectPRUnits", () => {
    test("returns empty array for empty commits", () => {
      const units = detectPRUnits([]);
      expect(units).toEqual([]);
    });

    test("creates single PRUnits for commits without group trailers", () => {
      const commits = [
        makeCommit("aaa111", "Add user model", { "Spry-Commit-Id": "a1b2c3d4" }),
        makeCommit("bbb222", "Add auth endpoints", { "Spry-Commit-Id": "b2c3d4e5" }),
        makeCommit("ccc333", "Add UI components", { "Spry-Commit-Id": "c3d4e5f6" }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(3);
      expect(units[0]).toMatchObject({ type: "single", id: "a1b2c3d4", commits: ["aaa111"] });
      expect(units[1]).toMatchObject({ type: "single", id: "b2c3d4e5", commits: ["bbb222"] });
      expect(units[2]).toMatchObject({ type: "single", id: "c3d4e5f6", commits: ["ccc333"] });
    });

    test("creates a group PRUnit for contiguous commits with same Spry-Group", () => {
      const commits = [
        makeCommit("aaa111", "Start auth feature", {
          "Spry-Commit-Id": "a1b2c3d4",
          "Spry-Group": "f7e8d9c0",
        }),
        makeCommit("bbb222", "Add login endpoint", {
          "Spry-Commit-Id": "b2c3d4e5",
          "Spry-Group": "f7e8d9c0",
        }),
        makeCommit("ccc333", "Add 2FA support", {
          "Spry-Commit-Id": "c3d4e5f6",
          "Spry-Group": "f7e8d9c0",
        }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({
        type: "group",
        id: "f7e8d9c0",
        commits: ["aaa111", "bbb222", "ccc333"],
      });
    });

    test("handles mixed singles and groups", () => {
      const commits = [
        makeCommit("aaa111", "Add user model", { "Spry-Commit-Id": "a1b2c3d4" }),
        makeCommit("bbb222", "Start auth", {
          "Spry-Commit-Id": "b2c3d4e5",
          "Spry-Group": "f7e8d9c0",
        }),
        makeCommit("ccc333", "End auth", {
          "Spry-Commit-Id": "c3d4e5f6",
          "Spry-Group": "f7e8d9c0",
        }),
        makeCommit("ddd444", "Add dashboard", { "Spry-Commit-Id": "d4e5f6a7" }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(3);
      expect(units[0]).toMatchObject({ type: "single", id: "a1b2c3d4" });
      expect(units[1]).toMatchObject({
        type: "group",
        id: "f7e8d9c0",
        commits: ["bbb222", "ccc333"],
      });
      expect(units[2]).toMatchObject({ type: "single", id: "d4e5f6a7" });
    });

    test("handles multiple consecutive groups", () => {
      const commits = [
        makeCommit("aaa111", "Group 1 commit 1", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
        makeCommit("bbb222", "Group 1 commit 2", {
          "Spry-Commit-Id": "b2",
          "Spry-Group": "g1",
        }),
        makeCommit("ccc333", "Group 2 commit 1", {
          "Spry-Commit-Id": "c3",
          "Spry-Group": "g2",
        }),
        makeCommit("ddd444", "Group 2 commit 2", {
          "Spry-Commit-Id": "d4",
          "Spry-Group": "g2",
        }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(2);
      expect(units[0]).toMatchObject({ type: "group", id: "g1", commits: ["aaa111", "bbb222"] });
      expect(units[1]).toMatchObject({ type: "group", id: "g2", commits: ["ccc333", "ddd444"] });
    });

    test("handles commits without Spry-Commit-Id", () => {
      const commits = [
        makeCommit("aaa111", "No ID commit", {}),
        makeCommit("bbb222", "Has ID", { "Spry-Commit-Id": "b2c3d4e5" }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(2);
      // Uses hash prefix as fallback ID, commitIds is empty when no Spry-Commit-Id
      expect(units[0]).toMatchObject({ id: "aaa111".slice(0, 8), commitIds: [] });
      expect(units[1]).toMatchObject({ id: "b2c3d4e5", commitIds: ["b2c3d4e5"] });
    });

    test("preserves commit order (oldest first)", () => {
      const commits = [
        makeCommit("first", "First commit", { "Spry-Commit-Id": "id1" }),
        makeCommit("second", "Second commit", { "Spry-Commit-Id": "id2" }),
        makeCommit("third", "Third commit", { "Spry-Commit-Id": "id3" }),
      ];

      const units = detectPRUnits(commits);

      expect(units.map((u) => u.commits[0])).toEqual(["first", "second", "third"]);
    });

    test("handles single-commit group", () => {
      const commits = [
        makeCommit("aaa111", "Single-commit group", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({ type: "group", id: "g1", commits: ["aaa111"] });
    });

    test("handles single-commit group followed by multi-commit group", () => {
      const commits = [
        makeCommit("aaa111", "Single-commit group", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
        makeCommit("bbb222", "Multi-commit group start", {
          "Spry-Commit-Id": "b2",
          "Spry-Group": "g2",
        }),
        makeCommit("ccc333", "Multi-commit group end", {
          "Spry-Commit-Id": "c3",
          "Spry-Group": "g2",
        }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(2);
      expect(units[0]).toMatchObject({ type: "group", id: "g1", commits: ["aaa111"] });
      expect(units[1]).toMatchObject({ type: "group", id: "g2", commits: ["bbb222", "ccc333"] });
    });
  });

  describe("parseStack", () => {
    test("returns success with PRUnits for valid stack without groups", () => {
      const commits = [
        makeCommit("aaa111", "First", { "Spry-Commit-Id": "a1" }),
        makeCommit("bbb222", "Second", { "Spry-Commit-Id": "b2" }),
      ];

      const result = parseStack(commits);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.units).toHaveLength(2);
      }
    });

    test("returns success with PRUnits for valid stack with groups", () => {
      const commits = [
        makeCommit("aaa111", "Group commit 1", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
        makeCommit("bbb222", "Group commit 2", {
          "Spry-Commit-Id": "b2",
          "Spry-Group": "g1",
        }),
      ];

      const result = parseStack(commits);

      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.units).toHaveLength(1);
        expect(result.units[0]).toMatchObject({ type: "group" });
      }
    });

    test("returns success for multiple non-overlapping groups", () => {
      const commits = [
        makeCommit("aaa111", "Group 1 commit 1", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
        makeCommit("bbb222", "Group 1 commit 2", {
          "Spry-Commit-Id": "b2",
          "Spry-Group": "g1",
        }),
        makeCommit("ccc333", "Group 2 commit 1", {
          "Spry-Commit-Id": "c3",
          "Spry-Group": "g2",
        }),
        makeCommit("ddd444", "Group 2 commit 2", {
          "Spry-Commit-Id": "d4",
          "Spry-Group": "g2",
        }),
      ];

      const result = parseStack(commits);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.units).toHaveLength(2);
      }
    });

    test("returns split-group error when group commits are non-contiguous", () => {
      const commits = [
        makeCommit("aaa111", "Group commit 1", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
        makeCommit("bbb222", "Interrupting single commit", { "Spry-Commit-Id": "b2" }),
        makeCommit("ccc333", "Group commit 2", {
          "Spry-Commit-Id": "c3",
          "Spry-Group": "g1",
        }),
      ];

      const result = parseStack(commits);

      expect(result).toMatchObject({
        ok: false,
        error: "split-group",
        group: { id: "g1" },
      });
      if (!result.ok && result.error === "split-group") {
        expect(result.group.commits).toContain("aaa111");
        expect(result.group.commits).toContain("ccc333");
        expect(result.interruptingCommits).toContain("bbb222");
      }
    });

    test("returns success for empty commits", () => {
      const result = parseStack([]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.units).toEqual([]);
      }
    });

    test("handles split group with multiple interrupting commits", () => {
      const commits = [
        makeCommit("aaa111", "Group commit 1", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
        makeCommit("bbb222", "Interrupting commit 1", { "Spry-Commit-Id": "b2" }),
        makeCommit("ccc333", "Interrupting commit 2", { "Spry-Commit-Id": "c3" }),
        makeCommit("ddd444", "Group commit 2", {
          "Spry-Commit-Id": "d4",
          "Spry-Group": "g1",
        }),
      ];

      const result = parseStack(commits);

      expect(result).toMatchObject({ ok: false, error: "split-group" });
      if (!result.ok && result.error === "split-group") {
        expect(result.interruptingCommits).toHaveLength(2);
        expect(result.interruptingCommits).toContain("bbb222");
        expect(result.interruptingCommits).toContain("ccc333");
      }
    });
  });

  describe("title resolution", () => {
    test("uses title from ref storage when provided", () => {
      const commits = [
        makeCommit("aaa111", "First commit subject", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
        makeCommit("bbb222", "Second commit subject", {
          "Spry-Commit-Id": "b2",
          "Spry-Group": "g1",
        }),
      ];

      const titles = { g1: "Custom Group Title" };
      const units = detectPRUnits(commits, titles);

      expect(units[0]?.title).toBe("Custom Group Title");
    });

    test("does not have a fallback title if one is not present. (That is view layer stuff)", () => {
      const commits = [
        makeCommit("aaa111", "First commit subject", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
        makeCommit("bbb222", "Second commit subject", {
          "Spry-Commit-Id": "b2",
          "Spry-Group": "g1",
        }),
      ];

      const units = detectPRUnits(commits, {});

      expect(units[0]?.title).toBeUndefined();
    });

    test("resolves titles independently for multiple groups", () => {
      const commits = [
        makeCommit("aaa111", "Group 1 first commit", {
          "Spry-Commit-Id": "a1",
          "Spry-Group": "g1",
        }),
        makeCommit("bbb222", "Group 2 first commit", {
          "Spry-Commit-Id": "b2",
          "Spry-Group": "g2",
        }),
      ];

      // Only g1 has a title in ref storage
      const titles = { g1: "Stored Title" };
      const units = detectPRUnits(commits, titles);

      expect(units[0]?.title).toBe("Stored Title");
      expect(units[1]?.title).toBeUndefined();
    });

    test("single commits use their subject as title", () => {
      const commits = [makeCommit("aaa111", "My single commit", { "Spry-Commit-Id": "a1" })];

      const units = detectPRUnits(commits);

      expect(units[0]?.title).toBe("My single commit");
    });
  });
});
