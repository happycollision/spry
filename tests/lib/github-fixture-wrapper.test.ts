import { test, expect } from "bun:test";
import {
  withGitHubFixture,
  __setFixtureFactoryForTest,
  __resetSessionFixtureForTest,
} from "./github-fixture.ts";
import type { GitHubFixture } from "./github-fixture.ts";
import { isRecording } from "./cassette-harness.ts";
import { serialChain } from "./serial.ts";

// These tests swap the module-global fixture factory AND the module-global
// memoized session fixture, so they must not interleave under
// `bun test --concurrent` (serialChain) and must not run at all under
// SPRY_RECORD=1: in a record run the REAL doc tests share the same process
// globals, and a fake session fixture memoized here (or a memo reset between
// their tests) would corrupt the real suite-start reset. The control flow is
// fully exercised by the offline suite, which the pre-merge gate replays twice.
const SKIP = isRecording();

const serial = serialChain();

const LOCK_DIR = `${import.meta.dir}/../../.test-tmp/wrapper-lock`;

function makeFakeFixture(log: string[]): GitHubFixture {
  return {
    owner: "owner",
    repo: "repo",
    repoUrl: "url",
    closeAllPRs: async () => 0,
    deleteAllBranches: async () => 0,
    purgeSpryRefs: async () => 0,
    restoreMainToBaseline: async () => {
      log.push("restore-main");
      return false;
    },
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

test.skipIf(SKIP)(
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

test.skipIf(SKIP)(
  "record mode: one suite-start reset shared by every body, no per-body reset",
  serial(async () => {
    const log: string[] = [];
    let factoryCalls = 0;
    __setFixtureFactoryForTest(async () => {
      factoryCalls++;
      return makeFakeFixture(log);
    });
    try {
      await withGitHubFixture({ recording: true, lockDir: LOCK_DIR }, async (fixture) => {
        expect(fixture).toBeDefined();
        log.push("body-1");
      });
      await withGitHubFixture({ recording: true, lockDir: LOCK_DIR }, async () => {
        log.push("body-2");
      });
      // Exactly one fixture + one reset for the whole session; the bodies are
      // namespaced (per-test trunks) and need no per-body reset or lock.
      expect(factoryCalls).toBe(1);
      expect(log).toEqual(["reset", "body-1", "body-2"]);
    } finally {
      __setFixtureFactoryForTest(undefined);
    }
  }),
);

test.skipIf(SKIP)(
  "record mode: concurrent first callers share a single suite-start reset",
  serial(async () => {
    const log: string[] = [];
    __setFixtureFactoryForTest(async () => makeFakeFixture(log));
    try {
      await Promise.all([
        withGitHubFixture({ recording: true, lockDir: LOCK_DIR }, async () => {
          log.push("body-a");
        }),
        withGitHubFixture({ recording: true, lockDir: LOCK_DIR }, async () => {
          log.push("body-b");
        }),
      ]);
      expect(log.filter((e) => e === "reset")).toEqual(["reset"]);
      // Both bodies ran strictly after the shared reset.
      expect(log[0]).toBe("reset");
      expect(log.slice(1).sort()).toEqual(["body-a", "body-b"]);
    } finally {
      __setFixtureFactoryForTest(undefined);
    }
  }),
);

test.skipIf(SKIP)(
  "record mode: no trailing cleanup even when the body throws",
  serial(async () => {
    const log: string[] = [];
    __setFixtureFactoryForTest(async () => makeFakeFixture(log));
    try {
      await expect(
        withGitHubFixture({ recording: true, lockDir: LOCK_DIR }, async () => {
          log.push("body");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      // A thrown body leaves its namespace dirty by design — the next
      // recording session's suite-start reset is the cleanup path.
      expect(log).toEqual(["reset", "body"]);
    } finally {
      __setFixtureFactoryForTest(undefined);
    }
  }),
);

test.skipIf(SKIP)(
  "record mode: a failed suite-start reset rejects and is retried by the next caller",
  serial(async () => {
    let resetCalls = 0;
    __setFixtureFactoryForTest(async () => {
      const fixture = makeFakeFixture([]);
      return {
        ...fixture,
        reset: async () => {
          resetCalls++;
          if (resetCalls === 1) throw new Error("reset exploded");
          return {
            branchesDeleted: 0,
            prsClosed: 0,
            spryRefsDeleted: 0,
            mainRestored: false,
            errors: [],
          };
        },
      };
    });
    try {
      await expect(
        withGitHubFixture({ recording: true, lockDir: LOCK_DIR }, async () => "unreachable"),
      ).rejects.toThrow("reset exploded");
      // The failure is not sticky: the memo was cleared, so the next caller
      // retries the suite-start reset instead of inheriting the rejection.
      const result = await withGitHubFixture(
        { recording: true, lockDir: LOCK_DIR },
        async () => "ok",
      );
      expect(result).toBe("ok");
      expect(resetCalls).toBe(2);
    } finally {
      __setFixtureFactoryForTest(undefined);
    }
  }),
);

test.skipIf(SKIP)(
  "record mode: reset errors in the cleanup report fail the suite-start reset",
  serial(async () => {
    __setFixtureFactoryForTest(async () => {
      const fixture = makeFakeFixture([]);
      return {
        ...fixture,
        reset: async () => ({
          branchesDeleted: 0,
          prsClosed: 0,
          spryRefsDeleted: 0,
          mainRestored: false,
          errors: ["Failed to close PRs: nope"],
        }),
      };
    });
    try {
      await expect(
        withGitHubFixture({ recording: true, lockDir: LOCK_DIR }, async () => "unreachable"),
      ).rejects.toThrow("Suite-start fixture reset failed");
    } finally {
      __setFixtureFactoryForTest(undefined);
    }
  }),
);

test.skipIf(SKIP)(
  "exclusive: restores the default branch after the body, even when it throws",
  serial(async () => {
    const log: string[] = [];
    __setFixtureFactoryForTest(async () => makeFakeFixture(log));
    try {
      const result = await withGitHubFixture(
        { recording: true, exclusive: true, lockDir: LOCK_DIR },
        async (fixture) => {
          expect(fixture).toBeDefined();
          log.push("body");
          return "landed";
        },
      );
      expect(result).toBe("landed");
      expect(log).toEqual(["reset", "body", "restore-main"]);

      __resetSessionFixtureForTest();
      log.length = 0;
      await expect(
        withGitHubFixture({ recording: true, exclusive: true, lockDir: LOCK_DIR }, async () => {
          log.push("body");
          throw new Error("land failed");
        }),
      ).rejects.toThrow("land failed");
      expect(log).toEqual(["reset", "body", "restore-main"]);
    } finally {
      __setFixtureFactoryForTest(undefined);
    }
  }),
);

test.skipIf(SKIP)(
  "exclusive: a failed main-restore does not mask the body's result",
  serial(async () => {
    const log: string[] = [];
    __setFixtureFactoryForTest(async () => {
      const fixture = makeFakeFixture(log);
      return {
        ...fixture,
        restoreMainToBaseline: async () => {
          log.push("restore-main");
          throw new Error("restore exploded");
        },
      };
    });
    try {
      const result = await withGitHubFixture(
        { recording: true, exclusive: true, lockDir: LOCK_DIR },
        async () => "landed",
      );
      // Best-effort restore: its failure is warned, not thrown — the next
      // session's suite-start reset restores main regardless.
      expect(result).toBe("landed");
      expect(log).toEqual(["reset", "restore-main"]);
    } finally {
      __setFixtureFactoryForTest(undefined);
    }
  }),
);
