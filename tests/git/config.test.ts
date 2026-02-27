import { test, expect, describe, afterAll } from "bun:test";
import { trunkRef, checkGitVersion, readConfig, loadConfig } from "../../src/git/config.ts";
import type { SpryConfig } from "../../src/git/config.ts";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import type { GitRunner } from "../../tests/lib/context.ts";

const git = createRealGitRunner();

describe("trunkRef", () => {
  test("combines remote and trunk into ref", () => {
    const config: SpryConfig = { trunk: "main", remote: "origin" };
    expect(trunkRef(config)).toBe("origin/main");
  });

  test("works with non-standard remote and trunk", () => {
    const config: SpryConfig = { trunk: "develop", remote: "upstream" };
    expect(trunkRef(config)).toBe("upstream/develop");
  });
});

describe("checkGitVersion", () => {
  test("returns version string when git >= 2.40", async () => {
    const version = await checkGitVersion(git);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("throws for git < 2.40", async () => {
    const fakeGit: GitRunner = {
      async run() {
        return { stdout: "git version 2.39.0\n", stderr: "", exitCode: 0 };
      },
    };
    expect(checkGitVersion(fakeGit)).rejects.toThrow("2.40");
  });

  test("throws for unparseable version", async () => {
    const fakeGit: GitRunner = {
      async run() {
        return { stdout: "not a version\n", stderr: "", exitCode: 0 };
      },
    };
    expect(checkGitVersion(fakeGit)).rejects.toThrow();
  });
});

describe("readConfig", () => {
  let repo: Awaited<ReturnType<typeof createRepo>>;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("reads trunk and remote when both set", async () => {
    repo = await createRepo();
    const { $ } = await import("bun");
    await $`git config spry.trunk main`.cwd(repo.path).quiet();
    await $`git config spry.remote origin`.cwd(repo.path).quiet();

    const config = await readConfig(git, { cwd: repo.path });
    expect(config.trunk).toBe("main");
    expect(config.remote).toBe("origin");
  });

  test('throws mentioning "spry.trunk" when trunk not set', async () => {
    repo = await createRepo();
    const { $ } = await import("bun");
    await $`git config spry.remote origin`.cwd(repo.path).quiet();

    expect(readConfig(git, { cwd: repo.path })).rejects.toThrow("spry.trunk");
  });

  test('throws mentioning "spry.remote" when remote not set', async () => {
    repo = await createRepo();
    expect(readConfig(git, { cwd: repo.path })).rejects.toThrow("spry.remote");
  });

  test('error suggests "main" when origin/main exists and trunk missing', async () => {
    repo = await createRepo();
    const { $ } = await import("bun");
    await $`git config spry.remote origin`.cwd(repo.path).quiet();
    // Fetch so remote branches are visible
    await repo.fetch();

    try {
      await readConfig(git, { cwd: repo.path });
      expect(true).toBe(false); // should not reach here
    } catch (e: any) {
      expect(e.message).toContain("spry.trunk");
      expect(e.message).toContain("main");
    }
  });
});

describe("loadConfig", () => {
  let repo: Awaited<ReturnType<typeof createRepo>>;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns config when both set", async () => {
    repo = await createRepo();
    const { $ } = await import("bun");
    await $`git config spry.trunk main`.cwd(repo.path).quiet();
    await $`git config spry.remote origin`.cwd(repo.path).quiet();

    const config = await loadConfig(git, { cwd: repo.path });
    expect(config.trunk).toBe("main");
    expect(config.remote).toBe("origin");
  });

  test("throws about version for old git", async () => {
    const callLog: string[][] = [];
    const fakeGit: GitRunner = {
      async run(args) {
        callLog.push(args);
        if (args[0] === "--version") {
          return { stdout: "git version 2.39.0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };
    expect(loadConfig(fakeGit)).rejects.toThrow("2.40");
  });

  test("throws about config when config missing", async () => {
    repo = await createRepo();
    expect(loadConfig(git, { cwd: repo.path })).rejects.toThrow("spry.remote");
  });
});
