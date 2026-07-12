import { $ } from "bun";

// Safety marker - must match the one in scripts/setup-spry-check.ts
const SAFETY_MARKER = "<!-- spry-test-repo:v1 -->";

// Configurable via environment variables (same as the setup script)
const DEFAULT_REPO_NAME = "spry-check";

const SETUP_HINT = "Run: bun run scripts/setup-spry-check.ts";

export interface CleanupReport {
  branchesDeleted: number;
  prsClosed: number;
  spryRefsDeleted: number;
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

  /** Reset repository to a clean state (close PRs, delete branches, purge spry refs). */
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
  const result = await $`gh api repos/${owner}/${repo}/contents/README.md --jq .content`
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    return false;
  }

  const content = Buffer.from(result.stdout.toString().trim(), "base64").toString("utf-8");
  return content.includes(SAFETY_MARKER);
}

/**
 * Defensive re-check used by every destructive method. Throws if the target
 * repo is missing the safety marker, so a destructive op can never run against
 * a non-test repo even if the constructor-time check is somehow bypassed.
 */
async function assertSafeToMutate(owner: string, repo: string): Promise<void> {
  const isTestRepo = await verifyTestRepo(owner, repo);
  if (!isTestRepo) {
    throw new Error(
      `Refusing to mutate ${owner}/${repo}: it is missing the safety marker ` +
        `"${SAFETY_MARKER}".\n${SETUP_HINT}`,
    );
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
  // a fixture that can mutate it.
  const isTestRepo = await verifyTestRepo(owner, repo);
  if (!isTestRepo) {
    throw new Error(
      `Repository ${fullRepoName} exists but does not appear to be a spry test repo.\n` +
        `The README is missing the safety marker "${SAFETY_MARKER}".\n${SETUP_HINT}`,
    );
  }

  async function closeAllPRs(): Promise<number> {
    await assertSafeToMutate(owner, repo);

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
    await assertSafeToMutate(owner, repo);

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
    await assertSafeToMutate(owner, repo);

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

  async function reset(): Promise<CleanupReport> {
    await assertSafeToMutate(owner, repo);

    const report: CleanupReport = {
      branchesDeleted: 0,
      prsClosed: 0,
      spryRefsDeleted: 0,
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

    return report;
  }

  async function mergePR(
    prNumber: number,
    opts?: { deleteBranch?: boolean; squash?: boolean },
  ): Promise<void> {
    await assertSafeToMutate(owner, repo);

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
    reset,
    mergePR,
  };
}

// Exported for tests so they can assert the marker check independently.
export { verifyTestRepo, SAFETY_MARKER };
