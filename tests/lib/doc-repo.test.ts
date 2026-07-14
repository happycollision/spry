import { test, expect } from "bun:test";
import { setupDocRepo } from "./doc-repo.ts";
import { createDocScrubber } from "./doc.ts";
import { cassettePath, isRecording } from "./cassette-harness.ts";
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

/** Fake repo whose git runner records config writes and never touches disk. */
function makeFakeRepo(originPath: string, configLog: string[][]): TestRepo {
  return {
    path: "/tmp/spry-test-fake-doc-repo",
    originPath,
    uniqueId: "zzfakezz",
    defaultBranch: "main",
    git: {
      async run(args) {
        configLog.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
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

// The gh-seam env key cassetteEnv hands back is keyed off the REAL SPRY_RECORD
// env (isRecording), so these assertions stay valid when the whole suite runs
// under `SPRY_RECORD=1` (the pre-merge record gate).
const ENV_KEY = isRecording() ? "SPRY_GH_CASSETTE_RECORD" : "SPRY_GH_CASSETTE";

test("fake-record mode: spry-check PR URL canonicalizes to owner/repo (scrub-order regression)", async () => {
  // In record mode repo.originPath IS the fixture URL. If setupDocRepo ever
  // registered doc.scrub(repo) BEFORE the github-host canonicalization, the
  // repo scrub would rewrite the URL prefix to /tmp/repo-origin and the host
  // scrub would never match — leaking a divergent PR URL into the docs.
  const configLog: string[][] = [];
  let seenOrigin: CreateRepoOptions["origin"];
  const { doc, scrubber } = makeScrubbingDoc();
  const { repoSlug, env } = await setupDocRepo(doc, {
    recording: true,
    section: "commands/sync",
    order: 20,
    createRepoFn: async (options) => {
      seenOrigin = options?.origin;
      return makeFakeRepo("https://github.com/happycollision/spry-check", configLog);
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

  // The invariant config block, pinned to the spry-check slug.
  expect(repoSlug).toBe(
    `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`,
  );
  expect(configLog).toEqual([
    ["config", "spry.trunk", "main"],
    ["config", "spry.remote", "origin"],
    ["config", "spry.branchPrefix", "spry/dondenton"],
    ["config", "spry.repo", repoSlug],
  ]);

  expect(env).toEqual({ [ENV_KEY]: cassettePath({ section: "commands/sync", order: 20 }) });
});

test("replay mode: creates a local-origin repo and hands back the cassette env", async () => {
  let seenOrigin: CreateRepoOptions["origin"];
  const { doc, scrubber } = makeScrubbingDoc();
  const { repo, env } = await setupDocRepo(doc, {
    recording: false,
    section: "commands/land",
    order: 10,
    createRepoFn: async (options) => {
      seenOrigin = options?.origin;
      return makeFakeRepo("/tmp/spry-test-origin-fake", []);
    },
  });

  expect(seenOrigin).toBe("local");
  expect(repo.originPath).toBe("/tmp/spry-test-origin-fake");
  // Local paths scrub as usual; the github-host scrub is inert but registered.
  expect(scrubber.apply("pushed to /tmp/spry-test-origin-fake")).toBe("pushed to /tmp/repo-origin");
  expect(env).toEqual({ [ENV_KEY]: cassettePath({ section: "commands/land", order: 10 }) });
});
