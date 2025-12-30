import { describe, test, expect, afterEach } from "bun:test";
import { $ } from "bun";
import { createGitFixture, type GitFixture } from "../../tests/helpers/git-fixture.ts";
import {
  getRemoteBranchCommit,
  getSyncStatus,
  getAllSyncStatuses,
  hasChanges,
  getSyncSummary,
} from "./remote.ts";
import { pushBranch, type BranchNameConfig } from "../github/branches.ts";
import type { PRUnit } from "../types.ts";

let fixture: GitFixture | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.cleanup();
    fixture = null;
  }
});

const testConfig: BranchNameConfig = { prefix: "taspr", username: "testuser" };

describe("git/remote", () => {
  describe("getRemoteBranchCommit", () => {
    test("returns null for non-existent branch", async () => {
      fixture = await createGitFixture();

      const result = await getRemoteBranchCommit("nonexistent/branch", { cwd: fixture.path });

      expect(result).toBeNull();
    });

    test("returns commit hash for existing branch", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-test", { create: true });

      const commitHash = await fixture.commit("Test commit");
      await pushBranch(commitHash, "taspr/testuser/abc123", false, { cwd: fixture.path });

      // Fetch to update remote refs
      await $`git -C ${fixture.path} fetch origin`.quiet();

      const result = await getRemoteBranchCommit("taspr/testuser/abc123", { cwd: fixture.path });

      expect(result).toBe(commitHash);
    });
  });

  describe("getSyncStatus", () => {
    test("returns needsCreate=true for new branch", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-new", { create: true });

      const commitHash = await fixture.commit("New commit");

      const unit: PRUnit = {
        type: "single",
        id: "newbranch",
        title: "New feature",
        commitIds: ["newbranch"],
        commits: [commitHash],
      };

      const status = await getSyncStatus(unit, testConfig, { cwd: fixture.path });

      expect(status.branchName).toBe("taspr/testuser/newbranch");
      expect(status.localCommit).toBe(commitHash);
      expect(status.remoteCommit).toBeNull();
      expect(status.needsCreate).toBe(true);
      expect(status.needsUpdate).toBe(false);
    });

    test("returns needsUpdate=true when local differs from remote", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-update", { create: true });

      const firstCommit = await fixture.commit("First commit");
      await pushBranch(firstCommit, "taspr/testuser/updateme", false, { cwd: fixture.path });

      // Make a new local commit (simulating amend/rebase)
      const secondCommit = await fixture.commit("Second commit");

      // Fetch to update remote refs
      await $`git -C ${fixture.path} fetch origin`.quiet();

      const unit: PRUnit = {
        type: "single",
        id: "updateme",
        title: "Updated feature",
        commitIds: ["updateme"],
        commits: [secondCommit],
      };

      const status = await getSyncStatus(unit, testConfig, { cwd: fixture.path });

      expect(status.branchName).toBe("taspr/testuser/updateme");
      expect(status.localCommit).toBe(secondCommit);
      expect(status.remoteCommit).toBe(firstCommit);
      expect(status.needsCreate).toBe(false);
      expect(status.needsUpdate).toBe(true);
    });

    test("returns both false when already in sync", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-sync", { create: true });

      const commitHash = await fixture.commit("Synced commit");
      await pushBranch(commitHash, "taspr/testuser/synced", false, { cwd: fixture.path });

      // Fetch to update remote refs
      await $`git -C ${fixture.path} fetch origin`.quiet();

      const unit: PRUnit = {
        type: "single",
        id: "synced",
        title: "Synced feature",
        commitIds: ["synced"],
        commits: [commitHash],
      };

      const status = await getSyncStatus(unit, testConfig, { cwd: fixture.path });

      expect(status.branchName).toBe("taspr/testuser/synced");
      expect(status.localCommit).toBe(commitHash);
      expect(status.remoteCommit).toBe(commitHash);
      expect(status.needsCreate).toBe(false);
      expect(status.needsUpdate).toBe(false);
    });
  });

  describe("getAllSyncStatuses", () => {
    test("returns statuses for all units", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-multi", { create: true });

      const commit1 = await fixture.commit("Commit 1");
      const commit2 = await fixture.commit("Commit 2");

      // Push only the first commit's branch
      await pushBranch(commit1, "taspr/testuser/unit1", false, { cwd: fixture.path });

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

      const statuses = await getAllSyncStatuses(units, testConfig, { cwd: fixture.path });

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
