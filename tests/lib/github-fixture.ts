import { $ } from "bun";
import { withRecordLock } from "./record-lock.ts";
import { waitForValue } from "./wait-for.ts";

// Safety marker - must match the one in scripts/setup-spry-check.ts
const SAFETY_MARKER = "<!-- spry-test-repo:v1 -->";

// Configurable via environment variables (same as the setup script)
const DEFAULT_REPO_NAME = "spry-check";

/**
 * Builds the "how to fix this" hint for repo-not-found / missing-safety-marker
 * errors. `scripts/setup-spry-check.ts` bootstraps `SPRY_TEST_REPO_NAME` (repo
 * name) and `SPRY_TEST_REPO_OWNER` (owner) from the environment — so a hint
 * that always says the bare `bun run scripts/setup-spry-check.ts` command
 * bootstraps the WRONG repo whenever either override is in play (e.g. the
 * fixture unit tests' dedicated `spry-check-fixture` repo). This builds the
 * command with exactly the env prefixes that are actually needed, so
 * following it verbatim bootstraps the right repo.
 */
export function buildSetupHint(opts: {
  repo: string;
  defaultRepo: string;
  ownerOverride?: string;
}): string {
  const prefixes: string[] = [];
  if (opts.repo !== opts.defaultRepo) {
    prefixes.push(`SPRY_TEST_REPO_NAME=${opts.repo}`);
  }
  if (opts.ownerOverride) {
    prefixes.push(`SPRY_TEST_REPO_OWNER=${opts.ownerOverride}`);
  }
  const envPrefix = prefixes.length > 0 ? `${prefixes.join(" ")} ` : "";
  return `Run: ${envPrefix}bun run scripts/setup-spry-check.ts`;
}

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

/** An item `runWithRetry` can operate over — just needs a stable identifier for error context. */
export interface RetryableItem {
  /** Human-readable identifier used in error context (PR number, branch name, ...). */
  id: string;
}

export interface RetryResult<T> {
  /** Items whose op succeeded, either on the first pass or the retry pass. */
  succeeded: T[];
  /** Items whose op failed on both the first pass AND the retry pass. */
  failed: { item: T; stderr: string }[];
}

/**
 * Runs `attempt` over every item CONCURRENTLY (matches the existing
 * `Promise.all` cost model — the suite-start reset's cost scales with prior
 * session residue), then retries any failures ONCE, sequentially (this is the
 * recovery path, not the hot path — no need for concurrency there, and
 * sequential keeps `isAlreadyDone` rechecks simple to reason about).
 *
 * Before the retry pass, sleeps `retryDelayMs` (default 1500ms) to let
 * transient causes (secondary rate limits, close/delete cascades) settle.
 *
 * A failure that persists after the retry is checked against the optional
 * `isAlreadyDone` predicate: if the item is already in the desired end state
 * (e.g. a PR that GitHub auto-closed when its head branch was deleted by a
 * concurrent `deleteAllBranches`-style call, so the retry's own `pr close`
 * fails against an already-closed PR), it counts as a SUCCESS rather than a
 * reported failure. Only a failure that is both persistent and NOT already
 * done is returned in `failed` — this is what lets a genuine failure (e.g. a
 * sustained rate limit) surface instead of being silently absorbed.
 */
export async function runWithRetry<T extends RetryableItem>(
  items: T[],
  attempt: (item: T) => Promise<{ ok: boolean; stderr: string }>,
  options?: {
    /** Recheck run on a persistent failure before it is reported (see doc comment). */
    isAlreadyDone?: (item: T) => Promise<boolean>;
    /** Delay before the retry pass, ms. Default 1500. */
    retryDelayMs?: number;
    /** Injectable delay (tests pass a no-op). Default sleeps `retryDelayMs`. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<RetryResult<T>> {
  const retryDelayMs = options?.retryDelayMs ?? 1500;
  const sleep = options?.sleep ?? ((ms: number) => Bun.sleep(ms));

  if (items.length === 0) return { succeeded: [], failed: [] };

  const firstPass = await Promise.all(
    items.map(async (item) => ({ item, result: await attempt(item) })),
  );

  const succeeded: T[] = [];
  const toRetry: { item: T; stderr: string }[] = [];
  for (const { item, result } of firstPass) {
    if (result.ok) succeeded.push(item);
    else toRetry.push({ item, stderr: result.stderr });
  }

  if (toRetry.length === 0) return { succeeded, failed: [] };

  await sleep(retryDelayMs);

  const failed: { item: T; stderr: string }[] = [];
  // Sequential: this is the recovery path, not the hot path, and it keeps the
  // isAlreadyDone recheck below simple to reason about.
  for (const { item, stderr: firstStderr } of toRetry) {
    const retryResult = await attempt(item);
    if (retryResult.ok) {
      succeeded.push(item);
      continue;
    }
    if (options?.isAlreadyDone && (await options.isAlreadyDone(item))) {
      succeeded.push(item);
      continue;
    }
    failed.push({ item, stderr: retryResult.stderr || firstStderr });
  }

  return { succeeded, failed };
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

export interface CreateGitHubFixtureOptions {
  /**
   * Target repo name. Defaults to `SPRY_TEST_REPO_NAME` / "spry-check". The
   * fixture's own unit tests pass a dedicated second repo here (see
   * `github-fixture.test.ts`) so their repo-wide destructive ops never touch
   * the repo the doc tests record against. An option rather than an env
   * mutation because setting `process.env` mid-run would race concurrent
   * tests.
   */
  repo?: string;
}

export async function createGitHubFixture(
  options?: CreateGitHubFixtureOptions,
): Promise<GitHubFixture> {
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

  const repo = options?.repo || process.env.SPRY_TEST_REPO_NAME || DEFAULT_REPO_NAME;
  const fullRepoName = `${owner}/${repo}`;
  const repoUrl = `https://github.com/${fullRepoName}`;

  // Dynamic hint: include exactly the env prefixes needed to bootstrap THIS
  // repo/owner (see buildSetupHint doc comment) — a hint that always says the
  // bare command bootstraps the wrong repo whenever an override is in play.
  const setupHint = buildSetupHint({
    repo,
    defaultRepo: DEFAULT_REPO_NAME,
    ownerOverride: process.env.SPRY_TEST_REPO_OWNER,
  });

  // Verify the repo exists.
  const repoCheck = await $`gh repo view ${fullRepoName} --json name`.quiet().nothrow();
  if (repoCheck.exitCode !== 0) {
    throw new Error(`Test repository ${fullRepoName} not found.\n${setupHint}`);
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
        `The README is missing the safety marker "${SAFETY_MARKER}".\n${setupHint}`,
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
          `"${SAFETY_MARKER}".\n${setupHint}`,
      );
    }
  }

  /**
   * Checks whether PR `prNumber` is already closed (or merged) — used to
   * absorb the auto-close cascade: GitHub auto-closes an open PR when its
   * head branch is deleted, and `deleteAllBranches` runs concurrently with
   * (or just before, on a retry) `closeAllPRs`, so a `gh pr close` retry can
   * legitimately fail with the PR already in the desired end state. This is a
   * real state query (not a stderr-message guess), so it's correct regardless
   * of gh's exact wording for "already closed".
   */
  async function isPRAlreadyClosed(prNumber: string): Promise<boolean> {
    const result = await $`gh pr view ${prNumber} --repo ${owner}/${repo} --json state --jq .state`
      .quiet()
      .nothrow();
    if (result.exitCode !== 0) return false;
    const state = result.stdout.toString().trim();
    return state === "CLOSED" || state === "MERGED";
  }

  /**
   * Internal variant that also surfaces persistent per-item failures, so
   * `reset()` can report them instead of only lowering a count (see
   * `runWithRetry` doc comment for the retry + cascade-absorption design).
   */
  async function closeAllPRsWithFailures(): Promise<RetryResult<{ id: string }>> {
    assertSafeToMutate();

    const listResult =
      await $`gh pr list --repo ${owner}/${repo} --state open --json number --jq '.[].number'`
        .quiet()
        .nothrow();

    if (listResult.exitCode !== 0 || !listResult.stdout.toString().trim()) {
      return { succeeded: [], failed: [] };
    }

    const prNumbers = listResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((n) => n)
      .map((id) => ({ id }));

    // Independent gh calls — run them concurrently on the first pass. The
    // suite-start reset's cost scales with prior-session residue (a dozen PRs
    // is routine), and it sits inside every waiting test's timeout budget
    // under `--concurrent`. Failures (e.g. a secondary rate limit under
    // concurrent writes) are retried once, sequentially, by runWithRetry.
    return runWithRetry(
      prNumbers,
      async ({ id: prNumber }) => {
        const result = await $`gh pr close ${prNumber} --repo ${owner}/${repo} --delete-branch`
          .quiet()
          .nothrow();
        return { ok: result.exitCode === 0, stderr: result.stderr.toString() };
      },
      { isAlreadyDone: ({ id: prNumber }) => isPRAlreadyClosed(prNumber) },
    );
  }

  async function closeAllPRs(): Promise<number> {
    const { succeeded } = await closeAllPRsWithFailures();
    return succeeded.length;
  }

  /**
   * Internal variant that also surfaces persistent per-item failures (see
   * closeAllPRsWithFailures).
   */
  async function deleteAllBranchesWithFailures(): Promise<RetryResult<{ id: string }>> {
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
      return { succeeded: [], failed: [] };
    }

    const branches = listResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((b) => b && b !== defaultBranch)
      .map((id) => ({ id }));

    // Independent gh calls — run them concurrently on the first pass (see
    // closeAllPRsWithFailures). No isAlreadyDone recheck here: unlike PR
    // close, there is no known benign cascade that deletes a branch out from
    // under this call, so a persistent branch-delete failure is always a
    // genuine failure worth reporting.
    return runWithRetry(branches, async ({ id: branch }) => {
      const result = await $`gh api -X DELETE repos/${owner}/${repo}/git/refs/heads/${branch}`
        .quiet()
        .nothrow();
      return { ok: result.exitCode === 0, stderr: result.stderr.toString() };
    });
  }

  async function deleteAllBranches(): Promise<number> {
    const { succeeded } = await deleteAllBranchesWithFailures();
    return succeeded.length;
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

    // Close PRs first (this also deletes their source branches). Per-item
    // failures that survive the retry (see runWithRetry) are pushed into
    // report.errors with enough context to act on — operation, PR number,
    // stderr excerpt — instead of only lowering prsClosed. This is what lets
    // ensureSessionFixture's `if (report.errors.length > 0) throw` guard
    // actually fire on a stale PR that outlives the suite-start reset.
    try {
      const { succeeded, failed } = await closeAllPRsWithFailures();
      report.prsClosed = succeeded.length;
      for (const { item, stderr } of failed) {
        report.errors.push(`Failed to close PR #${item.id}: ${stderr.trim()}`);
      }
    } catch (err: unknown) {
      report.errors.push(
        `Failed to close PRs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Delete any remaining branches. Same failure-surfacing as closeAllPRs.
    try {
      const { succeeded, failed } = await deleteAllBranchesWithFailures();
      report.branchesDeleted = succeeded.length;
      for (const { item, stderr } of failed) {
        report.errors.push(`Failed to delete branch ${item.id}: ${stderr.trim()}`);
      }
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
let fixtureFactory: () => Promise<GitHubFixture> = () => createGitHubFixture();

/**
 * Test-only: swap the fixture factory (pass `undefined` to restore the real
 * one). Also clears the memoized session fixture, since a fixture minted by a
 * previous factory must not survive a factory swap.
 */
export function __setFixtureFactoryForTest(
  factory: (() => Promise<GitHubFixture>) | undefined,
): void {
  fixtureFactory = factory ?? (() => createGitHubFixture());
  sessionFixturePromise = undefined;
}

/**
 * The record-lock key. Every actor that mutates REPO-WIDE state on the shared
 * `spry-check` repo (the suite-start reset, the canonical land test) must
 * contend on this one key — the value is arbitrary as long as it's identical
 * across all such callers.
 */
const SPRY_CHECK_LOCK_KEY = "spry-check-record";

/**
 * Run `body` under the shared `spry-check` record lock. Since the per-test
 * namespacing work (per-test trunks + branch prefixes), most record-mode doc
 * tests are mutually independent and run WITHOUT this lock; the only remaining
 * holders are the two actors that touch repo-wide state on `spry-check`: the
 * once-per-process suite-start `reset()` and the canonical land test's
 * default-branch ff-push + restore (both via {@link withGitHubFixture}). Any
 * new actor that mutates state outside its own namespace MUST contend on the
 * same key. (The fixture's own unit tests no longer qualify — they run their
 * repo-wide ops against the dedicated `spry-check-fixture` repo instead.)
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

/**
 * Memoized suite-start reset. The FIRST record-mode fixture test in this
 * process triggers one fixture creation + one repo-wide `reset()` (under the
 * record lock); every other record-mode test awaits the same promise, so all
 * of them start after exactly one reset. This is what handles cross-run
 * staleness (branches/PRs/trunks left by a previous recording session) now
 * that the tests themselves are namespaced and no longer reset per-test.
 *
 * One process is the supported recording topology: record the whole suite with
 * a single `SPRY_RECORD=1 bun test --concurrent` (Bun runs all test files in
 * one process). Two concurrent recording *processes* would each run their own
 * suite-start reset and bulldoze each other — don't do that.
 */
let sessionFixturePromise: Promise<GitHubFixture> | undefined;

function ensureSessionFixture(lockDir?: string): Promise<GitHubFixture> {
  // Note: lockDir is first-caller-wins — only the call that creates the memo
  // uses it. Fine in practice: real callers never pass one, and the unit
  // tests reset the memo between cases.
  if (!sessionFixturePromise) {
    const promise = (async () => {
      const fixture = await fixtureFactory();
      // Hold the record lock across the reset so it cannot interleave with an
      // exclusive body (e.g. the canonical land test) from another process.
      const startedAt = Date.now();
      await withSpryCheckRecordLock(() => fixture.reset(), lockDir ? { lockDir } : undefined).then(
        (report) => {
          if (report.errors.length > 0) {
            throw new Error(`Suite-start fixture reset failed:\n${report.errors.join("\n")}`);
          }
          // The reset runs inside every waiting test's timeout budget, so log
          // its cost: a future record-mode timeout flake should be diagnosable
          // as reset-cost from the test output alone.
          console.log(
            `[github-fixture] suite-start reset of ${fixture.owner}/${fixture.repo} took ` +
              `${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
              `(${report.prsClosed} PRs closed, ${report.branchesDeleted} branches deleted, ` +
              `${report.spryRefsDeleted} spry refs purged, main restored: ${report.mainRestored})`,
          );
        },
      );
      return fixture;
    })();
    sessionFixturePromise = promise;
    // A failed suite-start reset must not be sticky-memoized as a rejected
    // promise that poisons an unrelated later call — clear the memo so the
    // next caller retries (each awaiting caller still sees the rejection).
    // Guard against clearing a NEWER memo installed after this one failed.
    promise.catch(() => {
      if (sessionFixturePromise === promise) {
        sessionFixturePromise = undefined;
      }
    });
  }
  return sessionFixturePromise;
}

/** Test-only: clear the memoized session fixture/reset. */
export function __resetSessionFixtureForTest(): void {
  sessionFixturePromise = undefined;
}

export interface WithGitHubFixtureOptions {
  /** True under `SPRY_RECORD=1` (pass `isRecording()`). */
  recording: boolean;
  /**
   * Serialize this body under the exclusive spry-check record lock and restore
   * the default branch to its baseline afterward (best-effort). Reserved for
   * the ONE canonical land test that ff-pushes the real default branch — the
   * standing validation of the real MERGED transition on a true default
   * branch (see beads spry-tm2l) and the only record-mode body allowed to
   * move `main`. Everything else runs lock-free in parallel on its own
   * per-test trunk namespace.
   */
  exclusive?: boolean;
  /** Override the lock directory (test-only). */
  lockDir?: string;
}

/**
 * Run a live-fixture doc-test body with correct record/replay behavior.
 *
 * - **Replay (`recording: false`)**: calls `body(undefined)` immediately, with
 *   NO lock and NO fixture — replay is offline and must stay fully parallel.
 * - **Record (`recording: true`)**: awaits the once-per-process suite-start
 *   `reset()` (see {@link ensureSessionFixture}), then runs `body(fixture)`
 *   with NO per-test lock — record-mode tests are namespaced (per-test trunk +
 *   branch prefix via `setupDocRepo`) and mutually independent, so they run in
 *   parallel and the record wall clock is the slowest test, not the sum of CI
 *   waits. The one exception is `exclusive: true` (the canonical land test),
 *   which takes the record lock and gets a best-effort default-branch restore
 *   when its body finishes.
 *
 * There is deliberately NO trailing cleanup for non-exclusive bodies: each
 * test's namespace (its trunk branch, spry branches, and PRs) is left on the
 * fixture repo after a recording session. That residue is harmless — nothing
 * reads the repo between sessions, and the next session's suite-start reset
 * clears it.
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

  const fixture = await ensureSessionFixture(options.lockDir);

  if (!options.exclusive) {
    return body(fixture);
  }

  const lockOpts = options.lockDir ? { lockDir: options.lockDir } : undefined;
  return withSpryCheckRecordLock(async () => {
    try {
      return await body(fixture);
    } finally {
      // The exclusive body is the only mover of the default branch; put it
      // back so every namespaced test keeps seeing the baseline. Best-effort:
      // a restore failure must not mask the body's own result/error (the next
      // session's suite-start reset restores main regardless).
      try {
        await fixture.restoreMainToBaseline();
      } catch (err) {
        console.warn(
          `withGitHubFixture: failed to restore ${fixture.owner}/${fixture.repo} default branch to baseline: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }, lockOpts);
}

// Exported for tests so they can assert the marker check independently.
export { verifyTestRepo, SAFETY_MARKER };
