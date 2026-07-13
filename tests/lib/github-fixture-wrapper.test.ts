import { test, expect } from "bun:test";
import { withGitHubFixture, __setFixtureFactoryForTest } from "./github-fixture.ts";
import type { GitHubFixture } from "./github-fixture.ts";

function makeFakeFixture(log: string[]): GitHubFixture {
  return {
    owner: "owner",
    repo: "repo",
    repoUrl: "url",
    closeAllPRs: async () => 0,
    deleteAllBranches: async () => 0,
    purgeSpryRefs: async () => 0,
    restoreMainToBaseline: async () => false,
    reset: async () => {
      log.push("reset");
      return {
        branchesDeleted: 0,
        prsClosed: 0,
        spryRefsDeleted: 0,
        mainRestored: false,
        errors: [],
      };
    },
    mergePR: async () => {},
  };
}

test("replay mode: body runs with undefined fixture, no factory call", async () => {
  let factoryCalls = 0;
  __setFixtureFactoryForTest(async () => {
    factoryCalls++;
    return makeFakeFixture([]);
  });
  try {
    let seen: unknown = "unset";
    const result = await withGitHubFixture({ recording: false }, async (fixture) => {
      seen = fixture;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toBeUndefined();
    expect(factoryCalls).toBe(0);
  } finally {
    __setFixtureFactoryForTest(undefined);
  }
});

test("record mode: resets before and after the body", async () => {
  const log: string[] = [];
  __setFixtureFactoryForTest(async () => makeFakeFixture(log));
  try {
    await withGitHubFixture(
      { recording: true, lockDir: `${import.meta.dir}/../../.test-tmp/wrapper-lock` },
      async (fixture) => {
        expect(fixture).toBeDefined();
        log.push("body");
      },
    );
    expect(log).toEqual(["reset", "body", "reset"]);
  } finally {
    __setFixtureFactoryForTest(undefined);
  }
});

test("record mode: still resets (cleanup) when the body throws", async () => {
  const log: string[] = [];
  __setFixtureFactoryForTest(async () => makeFakeFixture(log));
  try {
    await expect(
      withGitHubFixture(
        { recording: true, lockDir: `${import.meta.dir}/../../.test-tmp/wrapper-lock` },
        async () => {
          log.push("body");
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(log).toEqual(["reset", "body", "reset"]);
  } finally {
    __setFixtureFactoryForTest(undefined);
  }
});
