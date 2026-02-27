import { test, expect, describe } from "bun:test";
import { trunkRef, checkGitVersion } from "../../src/git/config.ts";
import type { SpryConfig } from "../../src/git/config.ts";
import { createRealGitRunner } from "../../tests/lib/index.ts";
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
