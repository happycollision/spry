import { test, expect, afterEach, describe, beforeEach } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import { getTasprConfig, detectDefaultBranch, getDefaultBranchRef } from "./config.ts";

const repos = repoManager();
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await repos.cleanup();
});

describe("git/config", () => {
  describe("getTasprConfig", () => {
    test("returns default values when no config is set", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      const config = await getTasprConfig();

      expect(config.branchPrefix).toBe("taspr");
      expect(config.defaultBranch).toBe("main");
    });

    test("reads custom branchPrefix from git config", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      await $`git config taspr.branchPrefix jaspr`.quiet();

      const config = await getTasprConfig();

      expect(config.branchPrefix).toBe("jaspr");
    });

    test("reads custom defaultBranch from git config", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      await $`git config taspr.defaultBranch develop`.quiet();

      const config = await getTasprConfig();

      expect(config.defaultBranch).toBe("develop");
    });

    test("caches config for subsequent calls", async () => {
      const repo = await repos.create();
      process.chdir(repo.path);

      const config1 = await getTasprConfig();
      await $`git config taspr.branchPrefix changed`.quiet();
      const config2 = await getTasprConfig();

      // Should return cached value, not the changed value
      expect(config1).toBe(config2);
      expect(config2.branchPrefix).toBe("taspr");
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

      await $`git config taspr.defaultBranch develop`.quiet();

      const ref = await getDefaultBranchRef();

      expect(ref).toBe("origin/develop");
    });
  });
});
