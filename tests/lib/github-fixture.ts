import { $ } from "bun";
import { withRecordLock } from "./record-lock.ts";
import { waitForValue } from "./wait-for.ts";

// Safety marker - must match the one in scripts/setup-spry-check.ts
const SAFETY_MARKER = "<!-- spry-test-repo:v1 -->";

// Configurable via environment variables (same as the setup script)
const DEFAULT_REPO_NAME = "spry-check";

const SETUP_HINT = "Run: bun run scripts/setup-spry-check.ts";

export interface CleanupReport {
  branchesDeleted: number;
  prsClosed: number;
  spryRefsDeleted: number;
  /** True when the default branch was ahead of baseline and got rolled back. */
  mainRestored: boolean;
  errors: string[];
}

export interface GitHubFixture {
  readonly owner: string;
  readonly repo: string;
  readonly repoUrl: string;

  /** Close all open PRs in the repository (deleting their source branches). */
  closeAllPRs(): Promise<number>;

  /** Delete all branches except the default/main branch. */
  deleteAllBranches(): Promise<number>;

  /**
   * Delete every custom ref under `refs/spry/*` (group records, PR cache, and
   * any legacy spry refs). These are never touched by branch/PR cleanup, so a
   * stale record from a prior run would otherwise persist forever.
   */
  purgeSpryRefs(): Promise<number>;

  /**
   * Force the default branch back to its single-commit baseline (the initial
   * commit setup-spry-check.ts establishes). `sp land`'s job is to fast-forward
   * origin/main past the baseline, so recording it advances main — and branch
   * cleanup deliberately skips the default branch, so nothing else rolls it
   * back. Returns true when main was moved (was ahead of baseline).
   */
  restoreMainToBaseline(): Promise<boolean>;

  /** Reset repository to a clean state (close PRs, delete branches, purge spry refs, restore main). */
  reset(): Promise<CleanupReport>;

  /** Merge a PR via gh (simulating a merge via the GitHub UI). */
  mergePR(prNumber: number, opts?: { deleteBranch?: boolean; squash?: boolean }): Promise<void>;
}

/**
 * Returns true only if the repo's README contains the safety marker. This is
 * the guard that makes it impossible to run a destructive op against a repo
 * that is not a dedicated spry test repo.
 */
async function verifyTestRepo(owner: string, repo: string): Promise<boolean> {
  // Read the README once and report whether it contains the safety marker.
  // Returns `undefined` (as opposed to false) when the read is *inconclusive* —
  // a gh error or empty body — so the caller can retry that case without
  // conflating it with a definitive "content present but marker absent".
  const readMarker = async (): Promise<boolean | undefined> => {
    const result = await $`gh api repos/${owner}/${repo}/contents/README.md --jq .content`
      .quiet()
      .nothrow();
    if (result.exitCode !== 0) return undefined;
    const raw = result.stdout.toString().trim();
    if (raw === "") return undefined;
    const content = Buffer.from(raw, "base64").toString("utf-8");
    return content.includes(SAFETY_MARKER);
  };

  // GitHub's Contents API lags a main rewrite: right after `sp land`/reset
  // moves the default branch, a read can transiently error or return an empty
  // body, spuriously reporting the marker missing. Retry only those
  // inconclusive reads (undefined); a decisive true/false returns immediately.
  try {
    const conclusive = await waitForValue(readMarker, (v) => v !== undefined, {
      description: `README of ${owner}/${repo} to be readable for the safety-marker check`,
    });
    return conclusive === true;
  } catch {
    // Read never became conclusive within the poll window — treat as not a test
    // repo (safe default: refuse to mutate).
    return false;
  }
}

export async function createGitHubFixture(): Promise<GitHubFixture> {
  // Resolve owner from env or the authenticated user.
  let owner: string;
  if (process.env.SPRY_TEST_REPO_OWNER) {
    owner = process.env.SPRY_TEST_REPO_OWNER;
  } else {
    const ownerResult = await $`gh api user --jq .login`.quiet().nothrow();
    if (ownerResult.exitCode !== 0) {
      throw new Error(
        "Failed to get GitHub username. Ensure gh CLI is authenticated.\nRun: gh auth login",
      );
    }
    owner = ownerResult.stdout.toString().trim();
  }

  const repo = process.env.SPRY_TEST_REPO_NAME || DEFAULT_REPO_NAME;
  const fullRepoName = `${owner}/${repo}`;
  const repoUrl = `https://github.com/${fullRepoName}`;

  // Verify the repo exists.
  const repoCheck = await $`gh repo view ${fullRepoName} --json name`.quiet().nothrow();
  if (repoCheck.exitCode !== 0) {
    throw new Error(`Test repository ${fullRepoName} not found.\n${SETUP_HINT}`);
  }

  // Safety check: verify this is actually a spry test repo before handing back
  // a fixture that can mutate it. This is the one network read of the safety
  // marker per fixture instance: owner/repo are fixed for the instance's
  // lifetime, so the verdict is cached and every destructive method asserts
  // the cached flag instead of re-reading the README (which, right after a
  // reset moved main, is exactly the eventually-consistent read that used to
  // flake).
  const safetyVerified = await verifyTestRepo(owner, repo);
  if (!safetyVerified) {
    throw new Error(
      `Repository ${fullRepoName} exists but does not appear to be a spry test repo.\n` +
        `The README is missing the safety marker "${SAFETY_MARKER}".\n${SETUP_HINT}`,
    );
  }

  /**
   * Defensive re-check used by every destructive method: asserts the cached
   * constructor-time verdict, so a destructive op can never run if the check
   * above is somehow bypassed. No network — the target repo cannot change
   * identity mid-fixture.
   */
  function assertSafeToMutate(): void {
    if (!safetyVerified) {
      throw new Error(
        `Refusing to mutate ${owner}/${repo}: it is missing the safety marker ` +
          `"${SAFETY_MARKER}".\n${SETUP_HINT}`,
      );
    }
  }

  async function closeAllPRs(): Promise<number> {
    assertSafeToMutate();

    const listResult =
      await $`gh pr list --repo ${owner}/${repo} --state open --json number --jq '.[].number'`
        .quiet()
        .nothrow();

    if (listResult.exitCode !== 0 || !listResult.stdout.toString().trim()) {
      return 0;
    }

    const prNumbers = listResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((n) => n);
    let closed = 0;

    for (const prNumber of prNumbers) {
      const closeResult = await $`gh pr close ${prNumber} --repo ${owner}/${repo} --delete-branch`
        .quiet()
        .nothrow();
      if (closeResult.exitCode === 0) {
        closed++;
      }
    }

    return closed;
  }

  async function deleteAllBranches(): Promise<number> {
    assertSafeToMutate();

    // Determine the default branch so we never delete it.
    const defaultResult =
      await $`gh repo view ${owner}/${repo} --json defaultBranchRef --jq .defaultBranchRef.name`
        .quiet()
        .nothrow();
    const defaultBranch =
      defaultResult.exitCode === 0 ? defaultResult.stdout.toString().trim() || "main" : "main";

    const listResult = await $`gh api repos/${owner}/${repo}/branches --jq '.[].name'`
      .quiet()
      .nothrow();

    if (listResult.exitCode !== 0 || !listResult.stdout.toString().trim()) {
      return 0;
    }

    const branches = listResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((b) => b && b !== defaultBranch);

    let deleted = 0;

    for (const branch of branches) {
      const deleteResult = await $`gh api -X DELETE repos/${owner}/${repo}/git/refs/heads/${branch}`
        .quiet()
        .nothrow();
      if (deleteResult.exitCode === 0) {
        deleted++;
      }
    }

    return deleted;
  }

  /** List every ref under refs/spry/ (empty array when there are none). */
  async function listSpryRefs(): Promise<string[]> {
    const listResult = await $`gh api repos/${owner}/${repo}/git/matching-refs/spry/ --jq '.[].ref'`
      .quiet()
      .nothrow();
    if (listResult.exitCode !== 0 || !listResult.stdout.toString().trim()) {
      return [];
    }
    return listResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((r) => r);
  }

  async function purgeSpryRefs(): Promise<number> {
    assertSafeToMutate();

    // GitHub's git-refs API is eventually consistent, and `gh api -X DELETE`
    // exits 0 even on a 422 "reference does not exist" — so a delete can appear
    // to succeed while the ref survives (the delete hit a replica that hadn't
    // seen the ref yet). We therefore can't trust the delete's exit code: we
    // re-list and retry until refs/spry/ is actually empty, then count how many
    // of the refs we first observed are genuinely gone.
    const MAX_PASSES = 5;

    // Track every ref we ever observe so the count reflects real deletions even
    // if new listings appear/disappear across passes due to replica lag.
    const observed = new Set<string>(await listSpryRefs());

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const refs = await listSpryRefs();
      for (const ref of refs) observed.add(ref);
      if (refs.length === 0) break;

      for (const ref of refs) {
        // ref is like "refs/spry/groups"; the DELETE endpoint wants the path
        // after "refs/", e.g. "spry/groups".
        const refPath = ref.replace(/^refs\//, "");
        await $`gh api -X DELETE repos/${owner}/${repo}/git/refs/${refPath}`.quiet().nothrow();
      }
    }

    // Count only refs that are genuinely gone. If any survived every pass, the
    // caller (reset) surfaces the leftover via a later list.
    const survivors = new Set(await listSpryRefs());
    let deleted = 0;
    for (const ref of observed) {
      if (!survivors.has(ref)) deleted++;
    }
    return deleted;
  }

  async function restoreMainToBaseline(): Promise<boolean> {
    assertSafeToMutate();

    // Determine the default branch (never assume "main").
    const defaultResult =
      await $`gh repo view ${owner}/${repo} --json defaultBranchRef --jq .defaultBranchRef.name`
        .quiet()
        .nothrow();
    const defaultBranch =
      defaultResult.exitCode === 0 ? defaultResult.stdout.toString().trim() || "main" : "main";

    // Current tip of the default branch.
    const tipResult =
      await $`gh api repos/${owner}/${repo}/git/refs/heads/${defaultBranch} --jq .object.sha`
        .quiet()
        .nothrow();
    const tip = tipResult.stdout.toString().trim();

    // The baseline is the single root commit (setup-spry-check.ts force-pushes
    // exactly one commit). Find the commit with no parents on the branch.
    const rootResult =
      await $`gh api ${`repos/${owner}/${repo}/commits?sha=${defaultBranch}&per_page=100`} --jq 'map(select(.parents | length == 0)) | .[0].sha'`
        .quiet()
        .nothrow();
    const root = rootResult.stdout.toString().trim();

    if (!root || root === "null") {
      throw new Error(`Could not find a root commit on ${defaultBranch} of ${owner}/${repo}`);
    }

    // Already at baseline — nothing to roll back.
    if (tip === root) return false;

    // Force the default branch ref back to the root commit.
    await $`gh api -X PATCH repos/${owner}/${repo}/git/refs/heads/${defaultBranch} -f sha=${root} -F force=true`
      .quiet()
      .nothrow();
    return true;
  }

  async function reset(): Promise<CleanupReport> {
    assertSafeToMutate();

    const report: CleanupReport = {
      branchesDeleted: 0,
      prsClosed: 0,
      spryRefsDeleted: 0,
      mainRestored: false,
      errors: [],
    };

    // Close PRs first (this also deletes their source branches).
    try {
      report.prsClosed = await closeAllPRs();
    } catch (err: unknown) {
      report.errors.push(
        `Failed to close PRs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Delete any remaining branches.
    try {
      report.branchesDeleted = await deleteAllBranches();
    } catch (err: unknown) {
      report.errors.push(
        `Failed to delete branches: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Purge stale custom refs (refs/spry/*). Without this, a group record or PR
    // cache pushed by any prior run persists forever and can corrupt a later
    // record run (deterministic commit-ids re-match the stale record).
    try {
      report.spryRefsDeleted = await purgeSpryRefs();
    } catch (err: unknown) {
      report.errors.push(
        `Failed to purge spry refs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Roll the default branch back to its baseline. `sp land` fast-forwards
    // origin/main past baseline, and nothing above rolls it back (branch
    // cleanup skips the default branch), so without this a prior land recording
    // leaves main advanced and the next record run parses a corrupted stack.
    try {
      report.mainRestored = await restoreMainToBaseline();
    } catch (err: unknown) {
      report.errors.push(
        `Failed to restore main to baseline: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return report;
  }

  async function mergePR(
    prNumber: number,
    opts?: { deleteBranch?: boolean; squash?: boolean },
  ): Promise<void> {
    assertSafeToMutate();

    // Merge the PR via gh CLI (simulates merging via the GitHub UI).
    const mergeMethod = opts?.squash ? "--squash" : "--merge";
    const result = await $`gh pr merge ${prNumber} --repo ${owner}/${repo} ${mergeMethod}`
      .quiet()
      .nothrow();

    if (result.exitCode !== 0) {
      throw new Error(`Failed to merge PR #${prNumber}: ${result.stderr.toString()}`);
    }

    // Optionally delete the branch (the GitHub UI offers this as an option).
    // By default we do NOT delete, to simulate the case where a branch remains.
    if (opts?.deleteBranch) {
      const prInfo = await $`gh pr view ${prNumber} --repo ${owner}/${repo} --json headRefName`
        .quiet()
        .nothrow();
      if (prInfo.exitCode === 0) {
        const { headRefName } = JSON.parse(prInfo.stdout.toString()) as { headRefName: string };
        await $`gh api -X DELETE repos/${owner}/${repo}/git/refs/heads/${headRefName}`
          .quiet()
          .nothrow();
      }
    }
  }

  return {
    owner,
    repo,
    repoUrl,
    closeAllPRs,
    deleteAllBranches,
    purgeSpryRefs,
    restoreMainToBaseline,
    reset,
    mergePR,
  };
}

/**
 * Factory used by {@link withGitHubFixture}. Overridable in unit tests via
 * {@link __setFixtureFactoryForTest} so the wrapper's control flow can be
 * exercised without touching real GitHub.
 */
let fixtureFactory: () => Promise<GitHubFixture> = createGitHubFixture;

/** Test-only: swap the fixture factory (pass `undefined` to restore the real one). */
export function __setFixtureFactoryForTest(
  factory: (() => Promise<GitHubFixture>) | undefined,
): void {
  fixtureFactory = factory ?? createGitHubFixture;
}

/**
 * The record-lock key. Every live-fixture doc test contends on the SAME shared
 * `spry-check` repo, so they must share one lock key — the value is arbitrary
 * as long as it's identical across all callers.
 */
const SPRY_CHECK_LOCK_KEY = "spry-check-record";

/**
 * Run `body` under the shared `spry-check` record lock. This is the mutual
 * exclusion primitive that keeps every live-fixture actor — the doc tests via
 * {@link withGitHubFixture} AND the fixture's own unit tests
 * (`github-fixture.test.ts`) — from mutating the one shared repo concurrently.
 * They MUST all contend on the same key, or an unlocked actor's `main` rewrite
 * or `reset()` races a locked one (the class of bug this whole module fights).
 *
 * Unlike {@link withGitHubFixture} this adds no reset/fixture wrapper — it is
 * pure serialization, for callers that manage their own fixture and assertions.
 */
export async function withSpryCheckRecordLock<T>(
  body: () => Promise<T>,
  options?: { lockDir?: string },
): Promise<T> {
  const lockOpts = options?.lockDir ? { dir: options.lockDir } : {};
  return withRecordLock(SPRY_CHECK_LOCK_KEY, lockOpts, body);
}

export interface WithGitHubFixtureOptions {
  /** True under `SPRY_RECORD=1` (pass `isRecording()`). */
  recording: boolean;
  /** Override the lock directory (test-only). */
  lockDir?: string;
}

/**
 * Run a live-fixture doc-test body with correct record/replay behavior.
 *
 * - **Replay (`recording: false`)**: calls `body(undefined)` immediately, with
 *   NO lock and NO fixture — replay is offline and must stay fully parallel.
 * - **Record (`recording: true`)**: acquires a cross-process advisory lock on
 *   the shared `spry-check` repo (see {@link withRecordLock}), creates the
 *   fixture, `reset()`s it, then runs `body(fixture)` — all inside the lock.
 *   The entire body is the critical section, which is why the reset-then-run
 *   sequence lives here rather than in each test.
 *
 * There is deliberately NO trailing reset: every record-mode body starts with
 * its own reset, so a leading reset alone guarantees each test a clean repo
 * (including after a previous body threw). The trade-off is that `spry-check`
 * is left dirty after the last record-mode test of a session — that residue is
 * harmless because the next recording session's first reset clears it, and
 * nothing else reads the repo between sessions.
 *
 * This is the single uniform entry point the three live-fixture doc-test files
 * (`sync`, `land`, `group`) use, replacing the hand-rolled
 * `isRecording()` + `createGitHubFixture()` + `reset()` boilerplate.
 */
export async function withGitHubFixture<T>(
  options: WithGitHubFixtureOptions,
  body: (fixture: GitHubFixture | undefined) => Promise<T>,
): Promise<T> {
  if (!options.recording) {
    return body(undefined);
  }

  const lockOpts = options.lockDir ? { lockDir: options.lockDir } : undefined;
  return withSpryCheckRecordLock(async () => {
    const fixture = await fixtureFactory();
    await fixture.reset();
    return body(fixture);
  }, lockOpts);
}

// Exported for tests so they can assert the marker check independently.
export { verifyTestRepo, SAFETY_MARKER };
