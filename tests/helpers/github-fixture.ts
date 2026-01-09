import { $ } from "bun";
import { ensureGhInstalled, DependencyError } from "../../src/github/api.ts";

// Safety marker - must match the one in setup-spry-check.ts
const SAFETY_MARKER = "<!-- spry-test-repo:v1 -->";

// Configurable via environment variables (same as setup script)
const DEFAULT_REPO_NAME = "spry-check";

export interface BranchProtectionOptions {
  requireStatusChecks?: boolean;
  requiredStatusChecks?: string[];
  requirePullRequestReviews?: boolean;
  requiredApprovingReviewCount?: number;
  dismissStaleReviews?: boolean;
  enforceAdmins?: boolean;
}

export interface BranchProtectionStatus {
  enabled: boolean;
  requireStatusChecks: boolean;
  requiredStatusChecks: string[];
  requirePullRequestReviews: boolean;
  requiredApprovingReviewCount: number;
}

export interface CIStatus {
  state: "pending" | "success" | "failure" | "error";
  checks: Array<{
    name: string;
    state: string;
  }>;
}

export interface CleanupReport {
  branchesDeleted: number;
  prsClosed: number;
  errors: string[];
}

export interface GitHubFixture {
  readonly owner: string;
  readonly repo: string;
  readonly repoUrl: string;

  /** Close all open PRs in the repository */
  closeAllPRs(): Promise<number>;

  /** Delete all branches except main */
  deleteAllBranches(): Promise<number>;

  /** Reset repository to clean state (close PRs, delete branches) */
  reset(): Promise<CleanupReport>;

  /** Enable branch protection on a branch */
  enableBranchProtection(branch: string, options?: BranchProtectionOptions): Promise<void>;

  /** Disable branch protection on a branch */
  disableBranchProtection(branch: string): Promise<void>;

  /** Get current branch protection status */
  getBranchProtection(branch: string): Promise<BranchProtectionStatus | null>;

  /** Wait for CI to complete on a PR */
  waitForCI(prNumber: number, opts?: { timeout?: number }): Promise<CIStatus>;

  /** Wait for CI to start reporting (at least one check queued) */
  waitForCIToStart(prNumber: number, opts?: { timeout?: number }): Promise<void>;

  /** Get current CI status for a PR */
  getCIStatus(prNumber: number): Promise<CIStatus>;

  /** Merge a PR via GitHub API (simulating merge via GitHub UI) */
  mergePR(prNumber: number, opts?: { deleteBranch?: boolean; squash?: boolean }): Promise<void>;
}

async function verifyTestRepo(owner: string, repo: string): Promise<boolean> {
  // Try to fetch the README and check for safety marker
  const result = await $`gh api repos/${owner}/${repo}/contents/README.md --jq .content`.nothrow();

  if (result.exitCode !== 0) {
    return false;
  }

  const content = Buffer.from(result.stdout.toString().trim(), "base64").toString("utf-8");
  return content.includes(SAFETY_MARKER);
}

export async function createGitHubFixture(): Promise<GitHubFixture> {
  await ensureGhInstalled();

  // Get owner from env or authenticated user
  let owner: string;
  if (process.env.SPRY_TEST_REPO_OWNER) {
    owner = process.env.SPRY_TEST_REPO_OWNER;
  } else {
    const ownerResult = await $`gh api user --jq .login`.nothrow();
    if (ownerResult.exitCode !== 0) {
      throw new DependencyError(
        "Failed to get GitHub username. Ensure gh CLI is authenticated.\nRun: gh auth login",
      );
    }
    owner = ownerResult.stdout.toString().trim();
  }

  const repo = process.env.SPRY_TEST_REPO_NAME || DEFAULT_REPO_NAME;
  const fullRepoName = `${owner}/${repo}`;

  // Verify repo exists
  const repoCheck = await $`gh repo view ${fullRepoName} --json name`.nothrow();
  if (repoCheck.exitCode !== 0) {
    throw new DependencyError(
      `Test repository ${fullRepoName} not found.\n` + `Run: bun run scripts/setup-spry-check.ts`,
    );
  }

  // Safety check: verify this is actually a spry test repo
  const isTestRepo = await verifyTestRepo(owner, repo);
  if (!isTestRepo) {
    throw new DependencyError(
      `Repository ${fullRepoName} exists but does not appear to be a spry test repo.\n` +
        `The README is missing the safety marker.\n` +
        `Run: bun run scripts/setup-spry-check.ts`,
    );
  }

  const repoUrl = `https://github.com/${fullRepoName}`;

  async function closeAllPRs(): Promise<number> {
    const listResult =
      await $`gh pr list --repo ${owner}/${repo} --state open --json number --jq '.[].number'`.nothrow();

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
      const closeResult =
        await $`gh pr close ${prNumber} --repo ${owner}/${repo} --delete-branch`.nothrow();
      if (closeResult.exitCode === 0) {
        closed++;
      }
    }

    return closed;
  }

  async function deleteAllBranches(): Promise<number> {
    const listResult = await $`gh api repos/${owner}/${repo}/branches --jq '.[].name'`.nothrow();

    if (listResult.exitCode !== 0 || !listResult.stdout.toString().trim()) {
      return 0;
    }

    const branches = listResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((b) => b && b !== "main");

    let deleted = 0;

    for (const branch of branches) {
      const deleteResult =
        await $`gh api -X DELETE repos/${owner}/${repo}/git/refs/heads/${branch}`.nothrow();
      if (deleteResult.exitCode === 0) {
        deleted++;
      }
    }

    return deleted;
  }

  async function reset(): Promise<CleanupReport> {
    const report: CleanupReport = {
      branchesDeleted: 0,
      prsClosed: 0,
      errors: [],
    };

    // Close PRs first (this also deletes their source branches)
    try {
      report.prsClosed = await closeAllPRs();
    } catch (err: unknown) {
      report.errors.push(
        `Failed to close PRs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Delete any remaining branches
    try {
      report.branchesDeleted = await deleteAllBranches();
    } catch (err: unknown) {
      report.errors.push(
        `Failed to delete branches: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return report;
  }

  async function enableBranchProtection(
    branch: string,
    options?: BranchProtectionOptions,
  ): Promise<void> {
    const protection: Record<string, unknown> = {
      required_status_checks: options?.requireStatusChecks
        ? {
            strict: true,
            contexts: options.requiredStatusChecks || [],
          }
        : null,
      enforce_admins: options?.enforceAdmins ?? false,
      required_pull_request_reviews: options?.requirePullRequestReviews
        ? {
            dismiss_stale_reviews: options.dismissStaleReviews ?? false,
            require_code_owner_reviews: false,
            required_approving_review_count: options.requiredApprovingReviewCount ?? 1,
          }
        : null,
      restrictions: null,
    };

    const jsonInput = JSON.stringify(protection);
    const result =
      await $`echo ${jsonInput} | gh api --method PUT repos/${owner}/${repo}/branches/${branch}/protection --input -`.nothrow();

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to enable branch protection on ${branch}: ${result.stderr.toString()}`,
      );
    }
  }

  async function disableBranchProtection(branch: string): Promise<void> {
    await $`gh api -X DELETE repos/${owner}/${repo}/branches/${branch}/protection`.nothrow();
  }

  async function getBranchProtection(branch: string): Promise<BranchProtectionStatus | null> {
    const result = await $`gh api repos/${owner}/${repo}/branches/${branch}/protection`.nothrow();

    if (result.exitCode !== 0) {
      return null;
    }

    const data = JSON.parse(result.stdout.toString());
    return {
      enabled: true,
      requireStatusChecks: !!data.required_status_checks,
      requiredStatusChecks: data.required_status_checks?.contexts || [],
      requirePullRequestReviews: !!data.required_pull_request_reviews,
      requiredApprovingReviewCount:
        data.required_pull_request_reviews?.required_approving_review_count || 0,
    };
  }

  async function getCIStatus(prNumber: number): Promise<CIStatus> {
    const result =
      await $`gh pr checks ${prNumber} --repo ${owner}/${repo} --json name,state`.nothrow();

    if (result.exitCode !== 0) {
      return { state: "pending", checks: [] };
    }

    const checks = JSON.parse(result.stdout.toString()) as Array<{
      name: string;
      state: string;
    }>;

    // gh pr checks --json state returns: SUCCESS, FAILURE, PENDING, etc.
    const hasFailure = checks.some(
      (c) => c.state === "FAILURE" || c.state === "ERROR" || c.state === "CANCELLED",
    );
    const allComplete = checks.every(
      (c) => c.state === "SUCCESS" || c.state === "FAILURE" || c.state === "ERROR",
    );

    let state: CIStatus["state"];
    if (hasFailure) {
      state = "failure";
    } else if (allComplete && checks.length > 0) {
      state = "success";
    } else {
      state = "pending";
    }

    return { state, checks };
  }

  async function waitForCI(prNumber: number, opts?: { timeout?: number }): Promise<CIStatus> {
    const timeout = opts?.timeout || 120000; // 2 minutes default
    const pollInterval = 5000; // 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const status = await getCIStatus(prNumber);
      if (status.state !== "pending") {
        return status;
      }
      await Bun.sleep(pollInterval);
    }

    throw new Error(`CI timed out after ${timeout}ms for PR #${prNumber}`);
  }

  async function waitForCIToStart(prNumber: number, opts?: { timeout?: number }): Promise<void> {
    const timeout = opts?.timeout || 30000; // 30 seconds default
    const pollInterval = 2000; // 2 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const status = await getCIStatus(prNumber);
      if (status.checks.length > 0) {
        return; // CI has started
      }
      await Bun.sleep(pollInterval);
    }

    throw new Error(`CI did not start within ${timeout}ms for PR #${prNumber}`);
  }

  async function mergePR(
    prNumber: number,
    opts?: { deleteBranch?: boolean; squash?: boolean },
  ): Promise<void> {
    // Merge the PR via gh CLI (simulates merging via GitHub UI)
    const mergeMethod = opts?.squash ? "--squash" : "--merge";
    const result =
      await $`gh pr merge ${prNumber} --repo ${owner}/${repo} ${mergeMethod}`.nothrow();

    if (result.exitCode !== 0) {
      throw new Error(`Failed to merge PR #${prNumber}: ${result.stderr.toString()}`);
    }

    // Optionally delete the branch (GitHub UI has this as an option)
    // By default, we do NOT delete to simulate the case where branch remains
    if (opts?.deleteBranch) {
      // Get the branch name first
      const prInfo =
        await $`gh pr view ${prNumber} --repo ${owner}/${repo} --json headRefName`.nothrow();
      if (prInfo.exitCode === 0) {
        const { headRefName } = JSON.parse(prInfo.stdout.toString());
        await $`gh api -X DELETE repos/${owner}/${repo}/git/refs/heads/${headRefName}`.nothrow();
      }
    }
  }

  return {
    owner,
    repo,
    repoUrl,
    closeAllPRs,
    deleteAllBranches,
    reset,
    enableBranchProtection,
    disableBranchProtection,
    getBranchProtection,
    waitForCI,
    waitForCIToStart,
    getCIStatus,
    mergePR,
  };
}
