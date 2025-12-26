import { test, expect, describe } from "bun:test";
import { detectPRUnits, parseStack, type CommitWithTrailers } from "./stack.ts";

function makeCommit(
  hash: string,
  subject: string,
  trailers: Record<string, string> = {}
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
        makeCommit("aaa111", "Add user model", { "Taspr-Commit-Id": "a1b2c3d4" }),
        makeCommit("bbb222", "Add auth endpoints", { "Taspr-Commit-Id": "b2c3d4e5" }),
        makeCommit("ccc333", "Add UI components", { "Taspr-Commit-Id": "c3d4e5f6" }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(3);
      expect(units[0]).toEqual({
        type: "single",
        id: "a1b2c3d4",
        title: "Add user model",
        commitIds: ["a1b2c3d4"],
        commits: ["aaa111"],
      });
      expect(units[1]).toEqual({
        type: "single",
        id: "b2c3d4e5",
        title: "Add auth endpoints",
        commitIds: ["b2c3d4e5"],
        commits: ["bbb222"],
      });
      expect(units[2]).toEqual({
        type: "single",
        id: "c3d4e5f6",
        title: "Add UI components",
        commitIds: ["c3d4e5f6"],
        commits: ["ccc333"],
      });
    });

    test("creates a group PRUnit for commits with group trailers", () => {
      const commits = [
        makeCommit("aaa111", "Start auth feature", {
          "Taspr-Commit-Id": "a1b2c3d4",
          "Taspr-Group-Start": "f7e8d9c0",
          "Taspr-Group-Title": "Authentication Feature",
        }),
        makeCommit("bbb222", "Add login endpoint", { "Taspr-Commit-Id": "b2c3d4e5" }),
        makeCommit("ccc333", "Add 2FA support", {
          "Taspr-Commit-Id": "c3d4e5f6",
          "Taspr-Group-End": "f7e8d9c0",
        }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(1);
      expect(units[0]).toEqual({
        type: "group",
        id: "f7e8d9c0",
        title: "Authentication Feature",
        commitIds: ["a1b2c3d4", "b2c3d4e5", "c3d4e5f6"],
        commits: ["aaa111", "bbb222", "ccc333"],
      });
    });

    test("handles mixed singles and groups", () => {
      const commits = [
        makeCommit("aaa111", "Add user model", { "Taspr-Commit-Id": "a1b2c3d4" }),
        makeCommit("bbb222", "Start auth", {
          "Taspr-Commit-Id": "b2c3d4e5",
          "Taspr-Group-Start": "f7e8d9c0",
          "Taspr-Group-Title": "Auth Feature",
        }),
        makeCommit("ccc333", "End auth", {
          "Taspr-Commit-Id": "c3d4e5f6",
          "Taspr-Group-End": "f7e8d9c0",
        }),
        makeCommit("ddd444", "Add dashboard", { "Taspr-Commit-Id": "d4e5f6a7" }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(3);
      expect(units[0]?.type).toBe("single");
      expect(units[0]?.id).toBe("a1b2c3d4");
      expect(units[1]?.type).toBe("group");
      expect(units[1]?.id).toBe("f7e8d9c0");
      expect(units[1]?.commits).toEqual(["bbb222", "ccc333"]);
      expect(units[2]?.type).toBe("single");
      expect(units[2]?.id).toBe("d4e5f6a7");
    });

    test("handles multiple consecutive groups", () => {
      const commits = [
        makeCommit("aaa111", "Group 1 start", {
          "Taspr-Commit-Id": "a1",
          "Taspr-Group-Start": "g1",
          "Taspr-Group-Title": "Group One",
        }),
        makeCommit("bbb222", "Group 1 end", {
          "Taspr-Commit-Id": "b2",
          "Taspr-Group-End": "g1",
        }),
        makeCommit("ccc333", "Group 2 start", {
          "Taspr-Commit-Id": "c3",
          "Taspr-Group-Start": "g2",
          "Taspr-Group-Title": "Group Two",
        }),
        makeCommit("ddd444", "Group 2 end", {
          "Taspr-Commit-Id": "d4",
          "Taspr-Group-End": "g2",
        }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(2);
      expect(units[0]?.id).toBe("g1");
      expect(units[0]?.title).toBe("Group One");
      expect(units[1]?.id).toBe("g2");
      expect(units[1]?.title).toBe("Group Two");
    });

    test("uses commit subject as title when group title missing", () => {
      const commits = [
        makeCommit("aaa111", "My commit subject", {
          "Taspr-Commit-Id": "a1",
          "Taspr-Group-Start": "g1",
          // No Taspr-Group-Title
        }),
        makeCommit("bbb222", "End", {
          "Taspr-Commit-Id": "b2",
          "Taspr-Group-End": "g1",
        }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(1);
      expect(units[0]?.title).toBe("My commit subject");
    });

    test("handles commits without Taspr-Commit-Id", () => {
      const commits = [
        makeCommit("aaa111", "No ID commit", {}),
        makeCommit("bbb222", "Has ID", { "Taspr-Commit-Id": "b2c3d4e5" }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(2);
      // Uses hash prefix as fallback ID
      expect(units[0]?.id).toBe("aaa111".slice(0, 8));
      expect(units[0]?.commitIds).toEqual([]);
      expect(units[1]?.id).toBe("b2c3d4e5");
      expect(units[1]?.commitIds).toEqual(["b2c3d4e5"]);
    });

    test("handles unclosed group (includes it in output)", () => {
      const commits = [
        makeCommit("aaa111", "Start group", {
          "Taspr-Commit-Id": "a1",
          "Taspr-Group-Start": "g1",
          "Taspr-Group-Title": "Unclosed Group",
        }),
        makeCommit("bbb222", "More work", { "Taspr-Commit-Id": "b2" }),
        // No Group-End
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(1);
      expect(units[0]?.type).toBe("group");
      expect(units[0]?.id).toBe("g1");
      expect(units[0]?.commits).toEqual(["aaa111", "bbb222"]);
    });

    test("preserves commit order (oldest first)", () => {
      const commits = [
        makeCommit("first", "First commit", { "Taspr-Commit-Id": "id1" }),
        makeCommit("second", "Second commit", { "Taspr-Commit-Id": "id2" }),
        makeCommit("third", "Third commit", { "Taspr-Commit-Id": "id3" }),
      ];

      const units = detectPRUnits(commits);

      expect(units.map(u => u.commits[0])).toEqual(["first", "second", "third"]);
    });

    test("handles single-commit group (start and end on same commit)", () => {
      const commits = [
        makeCommit("aaa111", "Single-commit group", {
          "Taspr-Commit-Id": "a1",
          "Taspr-Group-Start": "g1",
          "Taspr-Group-Title": "Solo Group",
          "Taspr-Group-End": "g1",
        }),
      ];

      const units = detectPRUnits(commits);

      expect(units).toHaveLength(1);
      expect(units[0]?.type).toBe("group");
      expect(units[0]?.id).toBe("g1");
      expect(units[0]?.commits).toEqual(["aaa111"]);
    });
  });

  describe("parseStack", () => {
    test("returns success with PRUnits for valid stack without groups", () => {
      const commits = [
        makeCommit("aaa111", "First", { "Taspr-Commit-Id": "a1" }),
        makeCommit("bbb222", "Second", { "Taspr-Commit-Id": "b2" }),
      ];

      const result = parseStack(commits);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.units).toHaveLength(2);
      }
    });

    test("returns success with PRUnits for valid stack with groups", () => {
      const commits = [
        makeCommit("aaa111", "Start group", {
          "Taspr-Commit-Id": "a1",
          "Taspr-Group-Start": "g1",
          "Taspr-Group-Title": "My Group",
        }),
        makeCommit("bbb222", "End group", {
          "Taspr-Commit-Id": "b2",
          "Taspr-Group-End": "g1",
        }),
      ];

      const result = parseStack(commits);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.units).toHaveLength(1);
        expect(result.units[0]?.type).toBe("group");
      }
    });

    test("returns success for multiple non-overlapping groups", () => {
      const commits = [
        makeCommit("aaa111", "Group 1 start", {
          "Taspr-Commit-Id": "a1",
          "Taspr-Group-Start": "g1",
          "Taspr-Group-Title": "Group One",
        }),
        makeCommit("bbb222", "Group 1 end", {
          "Taspr-Commit-Id": "b2",
          "Taspr-Group-End": "g1",
        }),
        makeCommit("ccc333", "Group 2 start", {
          "Taspr-Commit-Id": "c3",
          "Taspr-Group-Start": "g2",
          "Taspr-Group-Title": "Group Two",
        }),
        makeCommit("ddd444", "Group 2 end", {
          "Taspr-Commit-Id": "d4",
          "Taspr-Group-End": "g2",
        }),
      ];

      const result = parseStack(commits);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.units).toHaveLength(2);
      }
    });

    test("returns unclosed-group error when group has no end", () => {
      const commits = [
        makeCommit("aaa111", "Start group", {
          "Taspr-Commit-Id": "a1",
          "Taspr-Group-Start": "g1",
          "Taspr-Group-Title": "Unclosed Group",
        }),
        makeCommit("bbb222", "More work", { "Taspr-Commit-Id": "b2" }),
        // No Group-End
      ];

      const result = parseStack(commits);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error === "unclosed-group") {
        expect(result.groupId).toBe("g1");
        expect(result.startCommit).toBe("aaa111");
        expect(result.groupTitle).toBe("Unclosed Group");
      }
    });

    test("returns overlapping-groups error when group starts inside another", () => {
      const commits = [
        makeCommit("aaa111", "Group 1 start", {
          "Taspr-Commit-Id": "a1",
          "Taspr-Group-Start": "g1",
          "Taspr-Group-Title": "Outer Group",
        }),
        makeCommit("bbb222", "Group 2 start (overlap!)", {
          "Taspr-Commit-Id": "b2",
          "Taspr-Group-Start": "g2",
          "Taspr-Group-Title": "Inner Group",
        }),
        makeCommit("ccc333", "Group 2 end", {
          "Taspr-Commit-Id": "c3",
          "Taspr-Group-End": "g2",
        }),
        makeCommit("ddd444", "Group 1 end", {
          "Taspr-Commit-Id": "d4",
          "Taspr-Group-End": "g1",
        }),
      ];

      const result = parseStack(commits);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error === "overlapping-groups") {
        expect(result.group1.id).toBe("g1");
        expect(result.group1.title).toBe("Outer Group");
        expect(result.group1.startCommit).toBe("aaa111");
        expect(result.group2.id).toBe("g2");
        expect(result.group2.title).toBe("Inner Group");
        expect(result.group2.startCommit).toBe("bbb222");
        expect(result.overlappingCommit).toBe("bbb222");
      }
    });

    test("returns success for empty commits", () => {
      const result = parseStack([]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.units).toEqual([]);
      }
    });

    test("ignores Group-End without matching Group-Start", () => {
      const commits = [
        makeCommit("aaa111", "Orphan end", {
          "Taspr-Commit-Id": "a1",
          "Taspr-Group-End": "g1", // No matching start
        }),
        makeCommit("bbb222", "Normal commit", { "Taspr-Commit-Id": "b2" }),
      ];

      const result = parseStack(commits);

      // Should succeed - orphan end is just ignored
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.units).toHaveLength(2);
        expect(result.units[0]?.type).toBe("single");
        expect(result.units[1]?.type).toBe("single");
      }
    });
  });
});
