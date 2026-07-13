import { test, expect } from "bun:test";
import { $ } from "bun";
import { createGitHubFixture, verifyTestRepo, withSpryCheckRecordLock } from "./github-fixture.ts";
import { waitForValue } from "./wait-for.ts";

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

// These tests drive real `gh` against the live spry-check test repo. They
// require gh auth + network, so they share the SPRY_RECORD gate with cassette
// recording (the one moment we're already online with gh auth) and skip
// entirely in the normal offline suite. Running them under SPRY_RECORD also
// verifies the fixture reset machinery that recording itself depends on.
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
  async () => {
    // Serialize on the shared spry-check lock so a concurrent doc test's
    // main rewrite / reset cannot race this test's reset + assertions.
    await withSpryCheckRecordLock(async () => {
      const fixture = await createGitHubFixture();

      const report = await fixture.reset();
      expect(report.errors).toEqual([]);

      // After reset, no PRs should be open.
      const remaining = await fixture.closeAllPRs();
      expect(remaining).toBe(0);
    });
  },
  // Real gh round-trips (close PRs + delete branches + purge refs + restore
  // main) exceed the 5s default, like the other reset-driving tests.
  60000,
);

test.skipIf(SKIP)(
  "reset purges all refs/spry/* custom refs",
  async () => {
    await withSpryCheckRecordLock(async () => {
      const fixture = await createGitHubFixture();

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
    });
  },
  // Real gh round-trips (seed + list + delete + verify) exceed the 5s default.
  60000,
);

test.skipIf(SKIP)(
  "reset restores main to the single-commit baseline",
  async () => {
    await withSpryCheckRecordLock(async () => {
      const fixture = await createGitHubFixture();
      const { owner, repo } = fixture;

      // Start clean so the seeded advance is the only thing above baseline.
      await fixture.reset();

      // Simulate the residue a prior `sp land` recording leaves behind: land's
      // whole job is to fast-forward origin/main past the baseline, and neither
      // closeAllPRs nor deleteAllBranches (which skips the default branch) rolls
      // main back. Advance main by one empty commit to stand in for that.
      const baseTip = await headSha(owner, repo);
      const treeSha = (
        await $`gh api repos/${owner}/${repo}/git/commits/${baseTip} --jq .tree.sha`
          .quiet()
          .nothrow()
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
    });
  },
  // Real gh round-trips (advance + reset + verify) exceed the 5s default.
  60000,
);
