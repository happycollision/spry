import { test, expect, describe } from "bun:test";
import { trunkRef, checkGitVersion, readConfig, loadConfig } from "../../src/git/config.ts";
import type { SpryConfig } from "../../src/git/config.ts";
import { createRealGitRunner, repoManager } from "../../tests/lib/index.ts";
import { serialChain } from "../lib/serial.ts";
import type { GitRunner } from "../../tests/lib/context.ts";

const git = createRealGitRunner();
// Shared manager: repos are cleaned up in afterAll, which is safe under
// --concurrent (each test owns a local `const repo`).
const repos = repoManager();

// Serialize every async test body in this file: under --concurrent, Bun
// 1.3.11 flakily loses a subprocess completion when this file runs its tests
// concurrently (reproduced with both Bun.$ and Bun.spawn, at low
// --max-concurrency, and with describe.serial — which the runner ignores).
// Chaining the bodies (spry-ojjj) sidesteps the hang; the file runs ~3s.
const serial = serialChain();

describe("trunkRef", () => {
  test("combines remote and trunk into ref", () => {
    const config: SpryConfig = {
      trunk: "main",
      remote: "origin",
      branchPrefix: "spry/test",
      autoDeleteOnLand: false,
    };
    expect(trunkRef(config)).toBe("origin/main");
  });

  test("works with non-standard remote and trunk", () => {
    const config: SpryConfig = {
      trunk: "develop",
      remote: "upstream",
      branchPrefix: "spry/test",
      autoDeleteOnLand: false,
    };
    expect(trunkRef(config)).toBe("upstream/develop");
  });
});

describe("checkGitVersion", () => {
  test(
    "returns version string when git >= 2.40",
    serial(async () => {
      const version = await checkGitVersion(git);
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    }),
  );

  test(
    "throws for git < 2.40",
    serial(async () => {
      const fakeGit: GitRunner = {
        async run() {
          return { stdout: "git version 2.39.0\n", stderr: "", exitCode: 0 };
        },
      };
      await expect(checkGitVersion(fakeGit)).rejects.toThrow("2.40");
    }),
  );

  test(
    "throws for unparseable version",
    serial(async () => {
      const fakeGit: GitRunner = {
        async run() {
          return { stdout: "not a version\n", stderr: "", exitCode: 0 };
        },
      };
      await expect(checkGitVersion(fakeGit)).rejects.toThrow();
    }),
  );
});

describe("readConfig", () => {
  test(
    "reads trunk and remote and branchPrefix when set",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.trunk).toBe("main");
      expect(config.remote).toBe("origin");
      expect(config.branchPrefix).toBe("spry/test");
    }),
  );

  test(
    "autoDeleteOnLand defaults to false when unset",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.autoDeleteOnLand).toBe(false);
    }),
  );

  test(
    "autoDeleteOnLand is true when set to true",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);
      await repo.git.run(["config", "spry.autoDeleteOnLand", "true"]);

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.autoDeleteOnLand).toBe(true);
    }),
  );

  test(
    "autoDeleteOnLand is false when set to false",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);
      await repo.git.run(["config", "spry.autoDeleteOnLand", "false"]);

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.autoDeleteOnLand).toBe(false);
    }),
  );

  test(
    "autoDeleteOnLand is false (not throwing) for a garbage value",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);
      await repo.git.run(["config", "spry.autoDeleteOnLand", "notabool"]);

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.autoDeleteOnLand).toBe(false);
    }),
  );

  test(
    "resolves owner/repo from the spry.repo override",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);
      await repo.git.run(["config", "spry.repo", "acme/widgets"]);

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.owner).toBe("acme");
      expect(config.repo).toBe("widgets");
    }),
  );

  test(
    "parses owner/repo from a GitHub remote URL when no override",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);
      await repo.git.run(["remote", "set-url", "origin", "https://github.com/acme/widgets.git"]);

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.owner).toBe("acme");
      expect(config.repo).toBe("widgets");
    }),
  );

  test(
    "leaves owner/repo undefined for a non-GitHub remote with no override",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);
      // origin is a local /tmp bare path — not parseable as owner/repo.

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.owner).toBeUndefined();
      expect(config.repo).toBeUndefined();
    }),
  );

  test(
    "reads branchPrefix when set",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.branchPrefix).toBe("spry/dondenton");
    }),
  );

  test(
    'throws mentioning "spry.branchPrefix" when not set',
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);

      await expect(readConfig(git, { cwd: repo.path })).rejects.toThrow("spry.branchPrefix");
    }),
  );

  test(
    "error suggests prefix format with username",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);

      try {
        await readConfig(git, { cwd: repo.path });
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.message).toContain("spry.branchPrefix");
        expect(e.message).toContain("git config spry.branchPrefix");
      }
    }),
  );

  test(
    'throws mentioning "spry.trunk" when trunk not set',
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.remote", "origin"]);

      await expect(readConfig(git, { cwd: repo.path })).rejects.toThrow("spry.trunk");
    }),
  );

  test(
    'throws mentioning "spry.remote" when remote not set',
    serial(async () => {
      const repo = await repos.create();
      await expect(readConfig(git, { cwd: repo.path })).rejects.toThrow("spry.remote");
    }),
  );

  test(
    'error suggests "main" when origin/main exists and trunk missing',
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.remote", "origin"]);
      // Fetch so remote branches are visible
      await repo.fetch();

      try {
        await readConfig(git, { cwd: repo.path });
        expect(true).toBe(false); // should not reach here
      } catch (e: any) {
        expect(e.message).toContain("spry.trunk");
        expect(e.message).toContain("main");
      }
    }),
  );
});

describe("loadConfig", () => {
  test(
    "returns config when all three set",
    serial(async () => {
      const repo = await repos.create();
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);

      const config = await loadConfig(git, { cwd: repo.path });
      expect(config.trunk).toBe("main");
      expect(config.remote).toBe("origin");
      expect(config.branchPrefix).toBe("spry/test");
    }),
  );

  test(
    "throws about version for old git",
    serial(async () => {
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
      await expect(loadConfig(fakeGit)).rejects.toThrow("2.40");
    }),
  );

  test(
    "throws about config when config missing",
    serial(async () => {
      const repo = await repos.create();
      await expect(loadConfig(git, { cwd: repo.path })).rejects.toThrow("spry.remote");
    }),
  );
});
