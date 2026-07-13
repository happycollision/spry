import { test, expect } from "bun:test";
import { withGitHubFixture, __setFixtureFactoryForTest } from "./github-fixture.ts";
import type { GitHubFixture } from "./github-fixture.ts";
import { serialChain } from "./serial.ts";

// These tests swap the module-global fixture factory (and the record-mode ones
// share a lock dir), so they must not interleave under `bun test --concurrent`.
const serial = serialChain();

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

test(
  "replay mode: body runs with undefined fixture, no factory call",
  serial(async () => {
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
  }),
);

test(
  "record mode: resets before the body, with no trailing reset",
  serial(async () => {
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
      // No trailing reset: the next record-mode test's leading reset (or the
      // next recording session's) cleans up, so each test pays one reset.
      expect(log).toEqual(["reset", "body"]);
    } finally {
      __setFixtureFactoryForTest(undefined);
    }
  }),
);

test(
  "record mode: no trailing reset even when the body throws",
  serial(async () => {
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
      // A thrown body leaves the repo dirty by design — the next test's
      // leading reset is the cleanup path.
      expect(log).toEqual(["reset", "body"]);
    } finally {
      __setFixtureFactoryForTest(undefined);
    }
  }),
);
