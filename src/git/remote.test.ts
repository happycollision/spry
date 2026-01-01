import { describe, test, expect, afterEach } from "bun:test";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import {
  getRemoteBranchCommit,
  getSyncStatus,
  getAllSyncStatuses,
  hasChanges,
  getSyncSummary,
} from "./remote.ts";
import { pushBranch, type BranchNameConfig } from "../github/branches.ts";
import type { PRUnit } from "../types.ts";

const repos = repoManager();
afterEach(() => repos.cleanup());

const testConfig: BranchNameConfig = { prefix: "taspr", username: "testuser" };

describe("git/remote", () => {
  describe("getRemoteBranchCommit", () => {
    test("returns null for non-existent branch", async () => {
      const repo = await repos.create();

      const result = await getRemoteBranchCommit("nonexistent/branch", { cwd: repo.path });

      expect(result).toBeNull();
    });

    test("returns commit hash for existing branch", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const commitHash = await repo.commit("Test commit");
      await pushBranch(commitHash, "taspr/testuser/abc123", false, { cwd: repo.path });

      await repo.fetch();

      const result = await getRemoteBranchCommit("taspr/testuser/abc123", { cwd: repo.path });

      expect(result).toBe(commitHash);
    });
  });

  describe("getSyncStatus", () => {
    test("returns needsCreate=true for new branch", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const commitHash = await repo.commit("New commit");

      const unit: PRUnit = {
        type: "single",
        id: "newbranch",
        title: "New feature",
        commitIds: ["newbranch"],
        commits: [commitHash],
      };

      const status = await getSyncStatus(unit, testConfig, { cwd: repo.path });

      expect(status.branchName).toBe("taspr/testuser/newbranch");
      expect(status.localCommit).toBe(commitHash);
      expect(status.remoteCommit).toBeNull();
      expect(status.needsCreate).toBe(true);
      expect(status.needsUpdate).toBe(false);
    });

    test("returns needsUpdate=true when local differs from remote", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const firstCommit = await repo.commit("First commit");
      await pushBranch(firstCommit, "taspr/testuser/updateme", false, { cwd: repo.path });

      // Make a new local commit (simulating amend/rebase)
      const secondCommit = await repo.commit("Second commit");

      await repo.fetch();

      const unit: PRUnit = {
        type: "single",
        id: "updateme",
        title: "Updated feature",
        commitIds: ["updateme"],
        commits: [secondCommit],
      };

      const status = await getSyncStatus(unit, testConfig, { cwd: repo.path });

      expect(status.branchName).toBe("taspr/testuser/updateme");
      expect(status.localCommit).toBe(secondCommit);
      expect(status.remoteCommit).toBe(firstCommit);
      expect(status.needsCreate).toBe(false);
      expect(status.needsUpdate).toBe(true);
    });

    test("returns both false when already in sync", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const commitHash = await repo.commit("Synced commit");
      await pushBranch(commitHash, "taspr/testuser/synced", false, { cwd: repo.path });

      await repo.fetch();

      const unit: PRUnit = {
        type: "single",
        id: "synced",
        title: "Synced feature",
        commitIds: ["synced"],
        commits: [commitHash],
      };

      const status = await getSyncStatus(unit, testConfig, { cwd: repo.path });

      expect(status.branchName).toBe("taspr/testuser/synced");
      expect(status.localCommit).toBe(commitHash);
      expect(status.remoteCommit).toBe(commitHash);
      expect(status.needsCreate).toBe(false);
      expect(status.needsUpdate).toBe(false);
    });
  });

  describe("getAllSyncStatuses", () => {
    test("returns statuses for all units", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const commit1 = await repo.commit("Commit 1");
      const commit2 = await repo.commit("Commit 2");

      // Push only the first commit's branch
      await pushBranch(commit1, "taspr/testuser/unit1", false, { cwd: repo.path });

      const units: PRUnit[] = [
        {
          type: "single",
          id: "unit1",
          title: "Unit 1",
          commitIds: ["unit1"],
          commits: [commit1],
        },
        {
          type: "single",
          id: "unit2",
          title: "Unit 2",
          commitIds: ["unit2"],
          commits: [commit2],
        },
      ];

      const statuses = await getAllSyncStatuses(units, testConfig, { cwd: repo.path });

      expect(statuses.size).toBe(2);

      const status1 = statuses.get("unit1");
      expect(status1).toBeDefined();
      expect(status1?.needsCreate).toBe(false);
      expect(status1?.needsUpdate).toBe(false);

      const status2 = statuses.get("unit2");
      expect(status2).toBeDefined();
      expect(status2?.needsCreate).toBe(true);
      expect(status2?.needsUpdate).toBe(false);
    });
  });

  describe("hasChanges", () => {
    test("returns false when all up to date", () => {
      const statuses = new Map([
        [
          "unit1",
          {
            branchName: "b1",
            localCommit: "abc",
            remoteCommit: "abc",
            needsCreate: false,
            needsUpdate: false,
          },
        ],
      ]);

      expect(hasChanges(statuses)).toBe(false);
    });

    test("returns true when branch needs creation", () => {
      const statuses = new Map([
        [
          "unit1",
          {
            branchName: "b1",
            localCommit: "abc",
            remoteCommit: null,
            needsCreate: true,
            needsUpdate: false,
          },
        ],
      ]);

      expect(hasChanges(statuses)).toBe(true);
    });

    test("returns true when branch needs update", () => {
      const statuses = new Map([
        [
          "unit1",
          {
            branchName: "b1",
            localCommit: "abc",
            remoteCommit: "def",
            needsCreate: false,
            needsUpdate: true,
          },
        ],
      ]);

      expect(hasChanges(statuses)).toBe(true);
    });
  });

  describe("getSyncSummary", () => {
    test("counts statuses correctly", () => {
      const statuses = new Map([
        [
          "unit1",
          {
            branchName: "b1",
            localCommit: "a",
            remoteCommit: "a",
            needsCreate: false,
            needsUpdate: false,
          },
        ],
        [
          "unit2",
          {
            branchName: "b2",
            localCommit: "b",
            remoteCommit: null,
            needsCreate: true,
            needsUpdate: false,
          },
        ],
        [
          "unit3",
          {
            branchName: "b3",
            localCommit: "c",
            remoteCommit: "d",
            needsCreate: false,
            needsUpdate: true,
          },
        ],
        [
          "unit4",
          {
            branchName: "b4",
            localCommit: "e",
            remoteCommit: null,
            needsCreate: true,
            needsUpdate: false,
          },
        ],
      ]);

      const summary = getSyncSummary(statuses);

      expect(summary.toCreate).toBe(2);
      expect(summary.toUpdate).toBe(1);
      expect(summary.upToDate).toBe(1);
    });
  });
});
