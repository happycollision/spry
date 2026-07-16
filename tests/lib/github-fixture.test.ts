import { test, expect } from "bun:test";
import { $ } from "bun";
import {
  createGitHubFixture,
  verifyTestRepo,
  runWithRetry,
  buildSetupHint,
} from "./github-fixture.ts";
import { waitForValue } from "./wait-for.ts";
import { serialChain } from "./serial.ts";

/**
 * Offline unit tests for the two building blocks the suite-start `reset()`
 * relies on to surface failures instead of silently swallowing them:
 *
 * - `runWithRetry`: the generic "attempt, retry failures once, recheck a
 *   persistent failure against an already-done predicate" helper shared by
 *   `closeAllPRs` and `deleteAllBranches`. No `gh`/network involved — `attempt`
 *   and `isAlreadyDone` are injected fakes, so these run in the normal offline
 *   suite (no SPRY_RECORD gate).
 * - `buildSetupHint`: pure string construction, no network.
 */
test("runWithRetry: item fails once then succeeds on retry counts as success, no failures", async () => {
  let calls = 0;
  const result = await runWithRetry(
    [{ id: "1" }, { id: "2" }],
    async (item) => {
      if (item.id === "1") {
        calls++;
        if (calls === 1) return { ok: false, stderr: "transient 403" };
        return { ok: true, stderr: "" };
      }
      return { ok: true, stderr: "" };
    },
    { sleep: async () => {} },
  );
  expect(result.succeeded.map((i) => i.id).sort()).toEqual(["1", "2"]);
  expect(result.failed).toEqual([]);
});

test("runWithRetry: item fails twice lands in failed with operation context", async () => {
  const result = await runWithRetry(
    [{ id: "1" }],
    async () => ({ ok: false, stderr: "still rate limited" }),
    { sleep: async () => {} },
  );
  expect(result.succeeded).toEqual([]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]?.item.id).toBe("1");
  expect(result.failed[0]?.stderr).toContain("still rate limited");
});

test("runWithRetry: a brief pause precedes the retry pass", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await runWithRetry(
    [{ id: "1" }],
    async () => {
      calls++;
      if (calls === 1) return { ok: false, stderr: "nope" };
      return { ok: true, stderr: "" };
    },
    { sleep: async (ms) => void sleeps.push(ms) },
  );
  expect(sleeps.length).toBeGreaterThanOrEqual(1);
  expect(sleeps[0]).toBeGreaterThan(0);
});

test("runWithRetry: isAlreadyDone treats a persistent failure as success (auto-close cascade)", async () => {
  // Simulates: `gh pr close` fails on retry because GitHub already auto-closed
  // the PR when its head branch was deleted concurrently. The recheck
  // confirms the PR is already in the desired (closed) state, so the
  // persistent "failure" must not be reported as an error.
  const result = await runWithRetry(
    [{ id: "42" }],
    async () => ({ ok: false, stderr: "pull request is already closed" }),
    {
      sleep: async () => {},
      isAlreadyDone: async (item) => item.id === "42",
    },
  );
  expect(result.succeeded.map((i) => i.id)).toEqual(["42"]);
  expect(result.failed).toEqual([]);
});

test("runWithRetry: isAlreadyDone false still reports the persistent failure", async () => {
  const result = await runWithRetry(
    [{ id: "42" }],
    async () => ({ ok: false, stderr: "some other error" }),
    {
      sleep: async () => {},
      isAlreadyDone: async () => false,
    },
  );
  expect(result.succeeded).toEqual([]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]?.stderr).toContain("some other error");
});

test("runWithRetry: success counts include both first-pass and retry-pass successes", async () => {
  let attempts = 0;
  const result = await runWithRetry(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    async (item) => {
      attempts++;
      if (item.id === "b") {
        // "b" fails first pass, succeeds on retry.
        return attempts <= 3 ? { ok: false, stderr: "boom" } : { ok: true, stderr: "" };
      }
      return { ok: true, stderr: "" };
    },
    { sleep: async () => {} },
  );
  expect(result.succeeded.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  expect(result.failed).toEqual([]);
});

test("buildSetupHint: default repo name and no owner override yields the plain command", () => {
  expect(buildSetupHint({ repo: "spry-check", defaultRepo: "spry-check" })).toBe(
    "Run: bun run scripts/setup-spry-check.ts",
  );
});

test("buildSetupHint: non-default repo name prefixes SPRY_TEST_REPO_NAME", () => {
  expect(buildSetupHint({ repo: "spry-check-fixture", defaultRepo: "spry-check" })).toBe(
    "Run: SPRY_TEST_REPO_NAME=spry-check-fixture bun run scripts/setup-spry-check.ts",
  );
});

test("buildSetupHint: owner override is included alongside a non-default repo name", () => {
  expect(
    buildSetupHint({
      repo: "spry-check-fixture",
      defaultRepo: "spry-check",
      ownerOverride: "someorg",
    }),
  ).toBe(
    "Run: SPRY_TEST_REPO_NAME=spry-check-fixture SPRY_TEST_REPO_OWNER=someorg bun run scripts/setup-spry-check.ts",
  );
});

test("buildSetupHint: owner override alone (default repo name) still includes it", () => {
  expect(
    buildSetupHint({
      repo: "spry-check",
      defaultRepo: "spry-check",
      ownerOverride: "someorg",
    }),
  ).toBe("Run: SPRY_TEST_REPO_OWNER=someorg bun run scripts/setup-spry-check.ts");
});

/**
 * The destructive tests below exercise repo-wide ops — `reset()`,
 * `deleteAllBranches`, `restoreMainToBaseline` — that bulldoze EVERYTHING on
 * their target repo regardless of the per-test namespacing the doc tests use.
 * They therefore run against a second, dedicated repo (`spry-check-fixture`,
 * bootstrapped with `SPRY_TEST_REPO_NAME=spry-check-fixture bun run
 * scripts/setup-spry-check.ts`) instead of the `spry-check` repo the doc tests
 * record on. That split is what lets the doc tests record lock-free in
 * parallel: nothing here can touch their repo.
 */
const FIXTURE_REPO_NAME = process.env.SPRY_TEST_FIXTURE_REPO_NAME || "spry-check-fixture";

// The three destructive tests still bulldoze EACH OTHER on the shared
// spry-check-fixture repo, so serialize their bodies within this file (Bun
// interleaves in-file tests under --concurrent).
const serial = serialChain();

/** Resolve the default branch's tip SHA — a valid target for a new ref. */
async function headSha(owner: string, repo: string): Promise<string> {
  const result = await $`gh api repos/${owner}/${repo}/commits/HEAD --jq .sha`.quiet().nothrow();
  return result.stdout.toString().trim();
}

/**
 * Poll until `ref` appears under refs/spry/ (GitHub's git-refs API is eventually
 * consistent, so a freshly-created ref may not be immediately listable).
 */
async function waitForSpryRef(owner: string, repo: string, ref: string): Promise<void> {
  await waitForValue(
    async () => {
      const result = await $`gh api repos/${owner}/${repo}/git/matching-refs/spry/ --jq '.[].ref'`
        .quiet()
        .nothrow();
      return result.stdout.toString();
    },
    (refs) => refs.includes(ref),
    { description: `seeded ref ${ref} to become visible under refs/spry/` },
  );
}

/** Count of commits reachable from the default branch tip. */
async function mainCommitCount(owner: string, repo: string): Promise<number> {
  const result =
    await $`gh api ${`repos/${owner}/${repo}/commits?sha=main&per_page=100`} --jq length`
      .quiet()
      .nothrow();
  return Number(result.stdout.toString().trim());
}

/**
 * Poll until the default branch reports exactly `expected` commits. GitHub's
 * commits endpoint lags behind a ref PATCH, so a single read right after
 * `reset()` can still see the pre-restore listing. This waits for the endpoint
 * to converge rather than asserting one racy read.
 */
async function waitForMainCommitCount(
  owner: string,
  repo: string,
  expected: number,
): Promise<number> {
  return waitForValue(
    () => mainCommitCount(owner, repo),
    (count) => count === expected,
    {
      description: `main to report ${expected} commit(s)`,
    },
  );
}

// These tests drive real `gh` against live test repos. They require gh auth +
// network, so they share the SPRY_RECORD gate with cassette recording (the one
// moment we're already online with gh auth) and skip entirely in the normal
// offline suite. Running them under SPRY_RECORD also verifies the fixture
// reset machinery that recording's suite-start reset depends on.
const SKIP = !process.env.SPRY_RECORD;

test.skipIf(SKIP)("createGitHubFixture resolves the spry-check test repo", async () => {
  const fixture = await createGitHubFixture();

  expect(fixture.repo).toBe(process.env.SPRY_TEST_REPO_NAME || "spry-check");
  expect(fixture.owner.length).toBeGreaterThan(0);
  expect(fixture.repoUrl).toBe(`https://github.com/${fixture.owner}/${fixture.repo}`);
});

test.skipIf(SKIP)("verifyTestRepo passes against the real spry-check repo", async () => {
  const fixture = await createGitHubFixture();
  const isTestRepo = await verifyTestRepo(fixture.owner, fixture.repo);
  expect(isTestRepo).toBe(true);
});

test.skipIf(SKIP)(
  "reset leaves zero open PRs",
  serial(async () => {
    const fixture = await createGitHubFixture({ repo: FIXTURE_REPO_NAME });

    const report = await fixture.reset();
    expect(report.errors).toEqual([]);

    // After reset, no PRs should be open.
    const remaining = await fixture.closeAllPRs();
    expect(remaining).toBe(0);
  }),
  // Real gh round-trips (close PRs + delete branches + purge refs + restore
  // main) exceed the 5s default, like the other reset-driving tests.
  60000,
);

test.skipIf(SKIP)(
  "reset purges all refs/spry/* custom refs",
  serial(async () => {
    const fixture = await createGitHubFixture({ repo: FIXTURE_REPO_NAME });

    // Seed a stale spry ref to simulate leftover state from a prior record run
    // (e.g. a refs/spry/groups blob that survives across runs because the test
    // commit-ids are deterministic).
    await $`gh api -X POST repos/${fixture.owner}/${fixture.repo}/git/refs -f ref=refs/spry/test-purge -f sha=${await headSha(fixture.owner, fixture.repo)}`
      .quiet()
      .nothrow();

    // GitHub's git-refs API is eventually consistent — wait until the seeded ref
    // is actually visible before asking reset() to purge it, so we test the
    // purge and not the create-propagation window.
    await waitForSpryRef(fixture.owner, fixture.repo, "refs/spry/test-purge");

    const report = await fixture.reset();
    expect(report.errors).toEqual([]);
    // The seeded ref must have been counted among the purged refs.
    expect(report.spryRefsDeleted).toBeGreaterThanOrEqual(1);

    // No refs/spry/* refs should remain after reset.
    const remaining =
      await $`gh api repos/${fixture.owner}/${fixture.repo}/git/matching-refs/spry/ --jq '.[].ref'`
        .quiet()
        .nothrow();
    const refs = remaining.stdout.toString().trim();
    expect(refs).toBe("");
  }),
  // Real gh round-trips (seed + list + delete + verify) exceed the 5s default.
  60000,
);

test.skipIf(SKIP)(
  "reset restores main to the single-commit baseline",
  serial(async () => {
    const fixture = await createGitHubFixture({ repo: FIXTURE_REPO_NAME });
    const { owner, repo } = fixture;

    // Start clean so the seeded advance is the only thing above baseline.
    await fixture.reset();

    // Simulate the residue a prior `sp land` recording leaves behind: land's
    // whole job is to fast-forward origin/main past the baseline, and neither
    // closeAllPRs nor deleteAllBranches (which skips the default branch) rolls
    // main back. Advance main by one empty commit to stand in for that.
    const baseTip = await headSha(owner, repo);
    const treeSha = (
      await $`gh api repos/${owner}/${repo}/git/commits/${baseTip} --jq .tree.sha`.quiet().nothrow()
    ).stdout
      .toString()
      .trim();
    const commit =
      await $`gh api -X POST repos/${owner}/${repo}/git/commits -f message=${"stale land residue"} -f tree=${treeSha} -f parents[]=${baseTip} --jq .sha`
        .quiet()
        .nothrow();
    const advancedSha = commit.stdout.toString().trim();
    await $`gh api -X PATCH repos/${owner}/${repo}/git/refs/heads/main -f sha=${advancedSha} -F force=true`
      .quiet()
      .nothrow();
    // Wait for the commits endpoint to reflect the advance (it lags the PATCH).
    expect(await waitForMainCommitCount(owner, repo, 2)).toBe(2);

    const report = await fixture.reset();
    expect(report.errors).toEqual([]);

    // Baseline is the single initial commit setup-spry-check.ts force-pushes.
    // Poll rather than a single read: the commits endpoint lags the reset PATCH.
    expect(await waitForMainCommitCount(owner, repo, 1)).toBe(1);
  }),
  // Real gh round-trips (advance + reset + verify) exceed the 5s default.
  60000,
);
