import { test, expect, describe, beforeEach, mock, spyOn } from "bun:test";
import { detectExistingPRs } from "./pr-detection.ts";
import * as prModule from "../github/pr.ts";
import type { BranchNameConfig } from "../github/branches.ts";

describe("pr-detection", () => {
  const mockBranchConfig: BranchNameConfig = {
    prefix: "spry",
    username: "testuser",
  };

  describe("detectExistingPRs", () => {
    beforeEach(() => {
      // Reset mocks
      mock.restore();
    });

    test("returns empty array when no commits have IDs", async () => {
      const commits = [
        { hash: "abc123", commitId: "", subject: "No ID commit" },
        { hash: "def456", commitId: "", subject: "Another no ID" },
      ];

      const result = await detectExistingPRs(commits, mockBranchConfig);
      expect(result).toEqual([]);
    });

    test("returns empty array when no commits have PRs", async () => {
      const findPRSpy = spyOn(prModule, "findPRByBranch").mockResolvedValue(null);

      const commits = [
        { hash: "abc123", commitId: "id-123", subject: "Commit 1" },
        { hash: "def456", commitId: "id-456", subject: "Commit 2" },
      ];

      const result = await detectExistingPRs(commits, mockBranchConfig);

      expect(result).toEqual([]);
      expect(findPRSpy).toHaveBeenCalledTimes(2);
    });

    test("returns commits that have open PRs", async () => {
      spyOn(prModule, "findPRByBranch").mockImplementation(async (branchName: string) => {
        if (branchName === "spry/testuser/id-123") {
          return {
            number: 42,
            url: "https://github.com/owner/repo/pull/42",
            state: "OPEN" as const,
            title: "PR Title",
          };
        }
        return null;
      });

      const commits = [
        { hash: "abc123", commitId: "id-123", subject: "Commit with PR" },
        { hash: "def456", commitId: "id-456", subject: "Commit without PR" },
      ];

      const result = await detectExistingPRs(commits, mockBranchConfig);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        hash: "abc123",
        commitId: "id-123",
        subject: "Commit with PR",
        pr: { number: 42, state: "OPEN" },
        branchName: "spry/testuser/id-123",
      });
    });

    test("excludes closed PRs", async () => {
      spyOn(prModule, "findPRByBranch").mockImplementation(async (_branchName: string) => {
        return {
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          state: "CLOSED" as const,
          title: "Closed PR",
        };
      });

      const commits = [{ hash: "abc123", commitId: "id-123", subject: "Commit" }];

      const result = await detectExistingPRs(commits, mockBranchConfig);
      expect(result).toEqual([]);
    });

    test("excludes merged PRs", async () => {
      spyOn(prModule, "findPRByBranch").mockImplementation(async (_branchName: string) => {
        return {
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          state: "MERGED" as const,
          title: "Merged PR",
        };
      });

      const commits = [{ hash: "abc123", commitId: "id-123", subject: "Commit" }];

      const result = await detectExistingPRs(commits, mockBranchConfig);
      expect(result).toEqual([]);
    });

    test("returns multiple commits with open PRs", async () => {
      spyOn(prModule, "findPRByBranch").mockImplementation(async (branchName: string) => {
        return {
          number: branchName.includes("id-123") ? 42 : 43,
          url: `https://github.com/owner/repo/pull/${branchName.includes("id-123") ? 42 : 43}`,
          state: "OPEN" as const,
          title: `PR for ${branchName}`,
        };
      });

      const commits = [
        { hash: "abc123", commitId: "id-123", subject: "Commit 1" },
        { hash: "def456", commitId: "id-456", subject: "Commit 2" },
      ];

      const result = await detectExistingPRs(commits, mockBranchConfig);

      expect(result).toHaveLength(2);
      expect(result[0]?.pr.number).toBe(42);
      expect(result[1]?.pr.number).toBe(43);
    });
  });
});
