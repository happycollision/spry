import { test, expect, afterEach, describe, beforeEach } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import {
  getSpryConfig,
  detectDefaultBranch,
  getDefaultBranchRef,
  isTempCommit,
  DEFAULT_TEMP_COMMIT_PREFIXES,
} from "./config.ts";

const repos = repoManager();
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
});

describe("git/config", () => {
  describe("getSpryConfig", () => {
    test("returns default values when no config is set", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      const config = await getSpryConfig();

      expect(config.branchPrefix).toBe("spry");
      expect(config.defaultBranch).toBe("main");
    });

    test("reads custom branchPrefix from git config", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      await $`git config spry.branchPrefix jaspr`.quiet();

      const config = await getSpryConfig();

      expect(config.branchPrefix).toBe("jaspr");
    });

    test("reads custom defaultBranch from git config", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      await $`git config spry.defaultBranch develop`.quiet();

      const config = await getSpryConfig();

      expect(config.defaultBranch).toBe("develop");
    });

    test("caches config for subsequent calls", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      const config1 = await getSpryConfig();
      await $`git config spry.branchPrefix changed`.quiet();
      const config2 = await getSpryConfig();

      // Should return cached value, not the changed value
      expect(config1).toBe(config2);
      expect(config2.branchPrefix).toBe("spry");
    });
  });

  describe("detectDefaultBranch", () => {
    test("detects main branch from origin", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      const branch = await detectDefaultBranch();

      expect(branch).toBe("main");
    });

    test("detects master branch when main does not exist", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      // Rename main to master
      await $`git -C ${repo.originPath} branch -m main master`.quiet();
      await $`git fetch origin`.quiet();
      await $`git branch -m main master`.quiet();
      await $`git branch -u origin/master master`.quiet();

      const branch = await detectDefaultBranch();

      expect(branch).toBe("master");
    });

    test("throws error when no default branch can be detected", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      // Remove origin remote
      await $`git remote remove origin`.quiet();

      expect(detectDefaultBranch()).rejects.toThrow("Could not detect default branch");
    });

    test("detects develop branch from origin", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      // Rename main to develop
      await $`git -C ${repo.originPath} branch -m main develop`.quiet();
      await $`git -C ${repo.originPath} symbolic-ref HEAD refs/heads/develop`.quiet();
      await $`git fetch origin`.quiet();
      await $`git branch -m main develop`.quiet();
      await $`git branch -u origin/develop develop`.quiet();

      const branch = await detectDefaultBranch();

      expect(branch).toBe("develop");
    });

    test("detects trunk branch from origin (SVN migration repos)", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      // Rename main to trunk
      await $`git -C ${repo.originPath} branch -m main trunk`.quiet();
      await $`git -C ${repo.originPath} symbolic-ref HEAD refs/heads/trunk`.quiet();
      await $`git fetch origin`.quiet();
      await $`git branch -m main trunk`.quiet();
      await $`git branch -u origin/trunk trunk`.quiet();

      const branch = await detectDefaultBranch();

      expect(branch).toBe("trunk");
    });

    test("detects default branch from repo created with custom default branch", async () => {
      // Use the new defaultBranch option to create a repo with "master" as default
      const repo = await repos.create({ defaultBranch: "master" });
      process.chdir(repo.path);

      const branch = await detectDefaultBranch();

      expect(branch).toBe("master");
      expect(repo.defaultBranch).toBe("master");
    });

    test("detects default branch from repo created with develop branch", async () => {
      // Use the new defaultBranch option to create a repo with "develop" as default
      const repo = await repos.create({ defaultBranch: "develop" });
      process.chdir(repo.path);

      const branch = await detectDefaultBranch();

      expect(branch).toBe("develop");
      expect(repo.defaultBranch).toBe("develop");
    });
  });

  describe("getDefaultBranchRef", () => {
    test("returns origin/main by default", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      const ref = await getDefaultBranchRef();

      expect(ref).toBe("origin/main");
    });

    test("returns custom default branch ref when configured", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      await $`git config spry.defaultBranch develop`.quiet();

      const ref = await getDefaultBranchRef();

      expect(ref).toBe("origin/develop");
    });
  });

  describe("tempCommitPrefixes config", () => {
    test("returns default prefixes when not configured", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      const config = await getSpryConfig();

      expect(config.tempCommitPrefixes).toEqual(DEFAULT_TEMP_COMMIT_PREFIXES);
    });

    test("reads custom prefixes from git config", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      await $`git config spry.tempCommitPrefixes "DRAFT,TODO"`.quiet();

      const config = await getSpryConfig();

      expect(config.tempCommitPrefixes).toEqual(["DRAFT", "TODO"]);
    });

    test("returns empty array when set to empty string (disabled)", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      // Use Bun.spawn to set empty string (shell template doesn't handle empty args well)
      Bun.spawnSync(["git", "config", "spry.tempCommitPrefixes", ""]);

      const config = await getSpryConfig();

      expect(config.tempCommitPrefixes).toEqual([]);
    });

    test("trims whitespace from prefixes", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      await $`git config spry.tempCommitPrefixes "WIP , fixup! , amend!"`.quiet();

      const config = await getSpryConfig();

      expect(config.tempCommitPrefixes).toEqual(["WIP", "fixup!", "amend!"]);
    });
  });

  describe("isTempCommit", () => {
    test("matches WIP prefix (case-insensitive)", () => {
      expect(isTempCommit("WIP: work in progress", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(true);
      expect(isTempCommit("wip: lowercase", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(true);
      expect(isTempCommit("Wip: mixed case", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(true);
    });

    test("matches fixup! prefix", () => {
      expect(isTempCommit("fixup! original commit", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(true);
      expect(isTempCommit("FIXUP! uppercase", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(true);
    });

    test("matches amend! prefix", () => {
      expect(isTempCommit("amend! original commit", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(true);
      expect(isTempCommit("AMEND! uppercase", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(true);
    });

    test("matches squash! prefix", () => {
      expect(isTempCommit("squash! original commit", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(true);
      expect(isTempCommit("SQUASH! uppercase", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(true);
    });

    test("does not match regular commits", () => {
      expect(isTempCommit("Add new feature", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(false);
      expect(isTempCommit("Fix bug in wipHandler", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(false);
      expect(isTempCommit("Update workflow", DEFAULT_TEMP_COMMIT_PREFIXES)).toBe(false);
    });

    test("returns false when prefixes array is empty", () => {
      expect(isTempCommit("WIP: work in progress", [])).toBe(false);
      expect(isTempCommit("fixup! something", [])).toBe(false);
    });

    test("uses custom prefixes", () => {
      const customPrefixes = ["DRAFT", "TODO"];
      expect(isTempCommit("DRAFT: not ready", customPrefixes)).toBe(true);
      expect(isTempCommit("TODO: implement later", customPrefixes)).toBe(true);
      expect(isTempCommit("WIP: not in custom list", customPrefixes)).toBe(false);
    });
  });
});
