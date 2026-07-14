import { test, expect } from "bun:test";
import { setupDocRepo } from "./doc-repo.ts";
import { createDocScrubber } from "./doc.ts";
import { cassettePath } from "./cassette-harness.ts";
import type { DocContext } from "./doc-types.ts";
import type { DocScrubber } from "./doc.ts";
import type { TestRepo, CreateRepoOptions } from "./repo.ts";

/**
 * A DocContext whose scrub() is the REAL doc-pipeline scrubber (same
 * registration + substitution semantics as docTest), so applying it to sample
 * text reproduces exactly what would land in a generated fragment.
 */
function makeScrubbingDoc(): { doc: DocContext; scrubber: DocScrubber } {
  const scrubber = createDocScrubber();
  const doc: DocContext = {
    prose() {},
    command() {},
    output() {},
    screen() {},
    scrub: scrubber.scrub,
  };
  return { doc, scrubber };
}

const FAKE_BASELINE = "f".repeat(40);

/** Fake repo whose git runner records every call and never touches disk. */
function makeFakeRepo(originPath: string, gitLog: string[][]): TestRepo {
  return {
    path: "/tmp/spry-test-fake-doc-repo",
    originPath,
    uniqueId: "zzfakezz",
    defaultBranch: "main",
    git: {
      async run(args) {
        gitLog.push(args);
        // setupDocRepo resolves the baseline (root) commit via rev-list.
        const stdout = args[0] === "rev-list" ? `${FAKE_BASELINE}\n` : "";
        return { stdout, stderr: "", exitCode: 0 };
      },
    },
    commit: async () => "",
    commitFiles: async () => "",
    branch: async () => "",
    checkout: async () => {},
    fetch: async () => {},
    currentBranch: async () => "main",
    cleanup: async () => {},
  };
}

/** The `git config` writes from a recorded git log, as a key→value map (order is not load-bearing). */
function configMap(gitLog: string[][]): Record<string, string> {
  return Object.fromEntries(
    gitLog.filter((args) => args[0] === "config").map((args) => [args[1]!, args[2]!]),
  );
}

test("fake-record mode: spry-check PR URL canonicalizes to owner/repo (scrub-order regression)", async () => {
  // In record mode repo.originPath IS the fixture URL. If setupDocRepo ever
  // registered doc.scrub(repo) BEFORE the github-host canonicalization, the
  // repo scrub would rewrite the URL prefix to /tmp/repo-origin and the host
  // scrub would never match — leaking a divergent PR URL into the docs.
  const gitLog: string[][] = [];
  let seenOrigin: CreateRepoOptions["origin"];
  const { doc, scrubber } = makeScrubbingDoc();
  const { repoSlug, env, trunkName, branchPrefix } = await setupDocRepo(doc, {
    recording: true,
    section: "commands/sync",
    order: 20,
    createRepoFn: async (options) => {
      seenOrigin = options?.origin;
      return makeFakeRepo("https://github.com/happycollision/spry-check", gitLog);
    },
  });

  expect(seenOrigin).toBe("github");

  const sample = [
    "✓ Created PR #1234: Add login",
    "  https://github.com/happycollision/spry-check/pull/1234",
    "",
  ].join("\n");
  const scrubbed = scrubber.apply(sample);
  expect(scrubbed).toBe(
    ["✓ Created PR #42: Add login", "  https://github.com/owner/repo/pull/42", ""].join("\n"),
  );
  // The ordering bug's signature: the repo scrub won and rewrote the URL.
  expect(scrubbed).not.toContain("/tmp/repo-origin");

  // The invariant config block, pinned to the spry-check slug and this test's
  // namespace (order of the config writes is not load-bearing).
  expect(repoSlug).toBe(
    `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`,
  );
  expect(configMap(gitLog)).toEqual({
    "spry.trunk": "trunk/sync-020",
    "spry.remote": "origin",
    "spry.branchPrefix": "spry/t-sync-020",
    "spry.repo": repoSlug,
  });

  // The env key derives from THIS call's `recording: true` — a fixed key,
  // regardless of whether the suite itself runs under SPRY_RECORD. The env
  // also namespaces the remote side of the shared bookkeeping refs
  // (refs/spry/{prs,groups}) so concurrent record-mode tests never contend.
  expect(env).toEqual({
    SPRY_GH_CASSETTE_RECORD: cassettePath({ section: "commands/sync", order: 20 }),
    SPRY_REMOTE_REFS_PREFIX: "refs/spry/t-sync-020",
  });
  expect(trunkName).toBe("trunk/sync-020");
  expect(branchPrefix).toBe("spry/t-sync-020");
});

test("per-test trunk: pushed from the baseline root commit and scrubbed back to the main story", async () => {
  const gitLog: string[][] = [];
  const { doc, scrubber } = makeScrubbingDoc();
  const { trunkName, branchPrefix } = await setupDocRepo(doc, {
    recording: true,
    section: "commands/land",
    order: 20,
    createRepoFn: async () => makeFakeRepo("https://github.com/happycollision/spry-check", gitLog),
  });

  expect(trunkName).toBe("trunk/land-020");
  expect(branchPrefix).toBe("spry/t-land-020");

  // The trunk is established at the repo's ROOT commit — invariant even when
  // the canonical land test has transiently advanced the default branch — and
  // the local working branch is rebuilt on the same baseline.
  expect(gitLog).toContainEqual(["rev-list", "--max-parents=0", "origin/main"]);
  expect(gitLog).toContainEqual(["reset", "--hard", FAKE_BASELINE]);
  expect(gitLog).toContainEqual(["push", "origin", `${FAKE_BASELINE}:refs/heads/trunk/land-020`]);
  expect(gitLog).toContainEqual([
    "update-ref",
    "refs/remotes/origin/trunk/land-020",
    FAKE_BASELINE,
  ]);

  // The docs keep telling the `main` + `spry/dondenton` story: the per-test
  // namespace never leaks into a generated fragment.
  expect(scrubber.apply("✓ Landed 2 PRs to trunk/land-020")).toBe("✓ Landed 2 PRs to main");
  expect(scrubber.apply("↑ pushed spry/t-land-020/aaa11111")).toBe(
    "↑ pushed spry/dondenton/aaa11111",
  );
});

test("default-branch trunk: no side branch is pushed and spry.trunk stays on main (canonical land)", async () => {
  const gitLog: string[][] = [];
  const { doc, scrubber } = makeScrubbingDoc();
  const { trunkName, branchPrefix } = await setupDocRepo(doc, {
    recording: true,
    section: "commands/land",
    order: 10,
    trunk: "default-branch",
    createRepoFn: async () => makeFakeRepo("https://github.com/happycollision/spry-check", gitLog),
  });

  expect(trunkName).toBe("main");
  // The branch prefix is still per-test — only the trunk is the real default
  // branch (MERGED-reachability fidelity).
  expect(branchPrefix).toBe("spry/t-land-010");
  expect(configMap(gitLog)["spry.trunk"]).toBe("main");
  // No trunk branch is created or pushed.
  expect(gitLog.some((args) => args[0] === "push" || args[0] === "rev-list")).toBe(false);
  expect(scrubber.apply("↑ pushed spry/t-land-010/aaa11111")).toBe(
    "↑ pushed spry/dondenton/aaa11111",
  );
});

test("replay mode: creates a local-origin repo, per-test trunk on the local origin, cassette env", async () => {
  const gitLog: string[][] = [];
  let seenOrigin: CreateRepoOptions["origin"];
  const { doc, scrubber } = makeScrubbingDoc();
  const { repo, env, trunkName } = await setupDocRepo(doc, {
    recording: false,
    section: "commands/land",
    order: 10,
    createRepoFn: async (options) => {
      seenOrigin = options?.origin;
      return makeFakeRepo("/tmp/spry-test-origin-fake", gitLog);
    },
  });

  expect(seenOrigin).toBe("local");
  expect(repo.originPath).toBe("/tmp/spry-test-origin-fake");
  // The trunk name is pinned PER TEST (a cassette key), so replay uses the
  // same name as record and creates it on the local bare origin.
  expect(trunkName).toBe("trunk/land-010");
  expect(gitLog).toContainEqual(["push", "origin", `${FAKE_BASELINE}:refs/heads/trunk/land-010`]);
  // Local paths scrub as usual; the github-host scrub is inert but registered.
  expect(scrubber.apply("pushed to /tmp/spry-test-origin-fake")).toBe("pushed to /tmp/repo-origin");
  // Fixed replay env key, derived from this call's `recording: false`. The
  // refs namespace is set in replay too, so both modes run identical commands.
  expect(env).toEqual({
    SPRY_GH_CASSETTE: cassettePath({ section: "commands/land", order: 10 }),
    SPRY_REMOTE_REFS_PREFIX: "refs/spry/t-land-010",
  });
});
