import { $ } from "bun";
import { ensureGhInstalled } from "./api.ts";
import { ghExecWithLimit } from "./retry.ts";

export interface LandResult {
  sha: string;
  prClosed: boolean;
}

export class PRNotFastForwardError extends Error {
  constructor(
    public prNumber: number,
    public reason: string,
  ) {
    super(`PR #${prNumber} cannot be fast-forwarded: ${reason}`);
    this.name = "PRNotFastForwardError";
  }
}

export class PRNotFoundError extends Error {
  constructor(public prNumber: number) {
    super(`PR #${prNumber} not found`);
    this.name = "PRNotFoundError";
  }
}

export class PRNotReadyError extends Error {
  constructor(
    public prNumber: number,
    public reasons: string[],
  ) {
    super(`PR #${prNumber} is not ready to land`);
    this.name = "PRNotReadyError";
  }
}

export interface PRInfo {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
  body?: string;
  baseRefName?: string;
}

export interface CreatePROptions {
  title: string;
  head: string;
  base: string;
  body?: string;
}

export type ChecksStatus = "pending" | "passing" | "failing" | "none";
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";

export interface CommentStatus {
  total: number;
  resolved: number;
}

export interface PRMergeStatus {
  checksStatus: ChecksStatus;
  reviewDecision: ReviewDecision;
  isReady: boolean;
}

/** Raw check data from GitHub API */
export interface CheckRollupItem {
  status: string;
  conclusion: string | null;
  state: string;
}

/**
 * Determine review decision from raw GitHub reviewDecision string.
 * Returns "approved", "changes_requested", "review_required", or "none".
 * Exported for testing.
 */
export function determineReviewDecision(reviewDecision: string | null): ReviewDecision {
  switch (reviewDecision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

/**
 * Determine checks status from raw GitHub statusCheckRollup data.
 * Returns "none" if no checks configured, otherwise "pending", "passing", or "failing".
 * Exported for testing.
 */
export function determineChecksStatus(checks: CheckRollupItem[] | null): ChecksStatus {
  if (!checks || checks.length === 0) {
    return "none";
  }

  const hasFailure = checks.some(
    (c) => c.conclusion === "FAILURE" || c.conclusion === "ERROR" || c.state === "FAILURE",
  );
  const allComplete = checks.every(
    (c) => c.status === "COMPLETED" || c.state === "SUCCESS" || c.state === "FAILURE",
  );

  if (hasFailure) {
    return "failing";
  } else if (allComplete) {
    return "passing";
  } else {
    return "pending";
  }
}

/**
 * Find an existing PR for a branch.
 * Returns null if no PR exists for the branch.
 * By default only searches open PRs; use includeAll to also find merged/closed PRs.
 */
export async function findPRByBranch(
  branchName: string,
  options?: { includeAll?: boolean },
): Promise<PRInfo | null> {
  await ensureGhInstalled();

  // Use --limit to handle branches with multiple PRs (gh defaults to 30)
  const args = ["gh", "pr", "list", "--head", branchName, "--json", "number,url,state,title", "--limit", "100"];
  if (options?.includeAll) {
    args.push("--state", "all");
  }

  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    return null;
  }

  const prs = JSON.parse(result.stdout.toString()) as PRInfo[];

  if (prs.length === 0) {
    return null;
  }

  // Return first open PR, or first PR if none are open
  const openPR = prs.find((pr) => pr.state === "OPEN");
  return openPR || prs[0] || null;
}

/** Extended PR info including head branch name for batch lookups */
interface PRInfoWithHead extends PRInfo {
  headRefName: string;
  body: string;
}

/**
 * Find existing PRs for multiple branches in a single API call.
 * Returns a Map from branch name to PRInfo (or null if no PR exists).
 * By default only searches open PRs; use includeAll to also find merged/closed PRs.
 *
 * This is much more efficient than calling findPRByBranch in a loop,
 * as it makes only one GitHub API call regardless of the number of branches.
 */
export async function findPRsByBranches(
  branchNames: string[],
  options?: { includeAll?: boolean },
): Promise<Map<string, PRInfo | null>> {
  await ensureGhInstalled();

  const result: Map<string, PRInfo | null> = new Map();

  // Initialize all branches as null (no PR found)
  for (const branch of branchNames) {
    result.set(branch, null);
  }

  if (branchNames.length === 0) {
    return result;
  }

  // Fetch all PRs in a single call (no --head filter)
  // Use --limit to handle repos with many PRs (gh defaults to 30)
  const args = ["gh", "pr", "list", "--json", "number,url,state,title,body,headRefName", "--limit", "500"];
  if (options?.includeAll) {
    args.push("--state", "all");
  }

  const ghResult = await ghExecWithLimit(args);

  if (ghResult.exitCode !== 0) {
    // Return all nulls on error
    return result;
  }

  const prs = JSON.parse(ghResult.stdout.toString()) as PRInfoWithHead[];

  // Build a set for O(1) lookup
  const branchSet = new Set(branchNames);

  // Group PRs by branch, preferring open PRs
  for (const pr of prs) {
    if (!branchSet.has(pr.headRefName)) {
      continue;
    }

    const existing = result.get(pr.headRefName);
    // Prefer open PRs over closed/merged
    if (!existing || (existing.state !== "OPEN" && pr.state === "OPEN")) {
      // Strip headRefName from the result to match PRInfo interface
      const { headRefName: _, ...prInfo } = pr;
      result.set(pr.headRefName, prInfo);
    }
  }

  return result;
}

/**
 * Create a new PR.
 */
export async function createPR(options: CreatePROptions): Promise<{ number: number; url: string }> {
  await ensureGhInstalled();

  // Validate PR title before calling GitHub API
  const { validatePRTitle } = await import("../core/validation.ts");
  const titleValidation = validatePRTitle(options.title);
  if (!titleValidation.ok) {
    throw new Error(titleValidation.error);
  }

  const args = [
    "gh",
    "pr",
    "create",
    "--title",
    options.title,
    "--head",
    options.head,
    "--base",
    options.base,
  ];

  // Use --body="" syntax for empty body to avoid shell parsing issues
  if (options.body) {
    args.push("--body", options.body);
  } else {
    args.push("--body=");
  }

  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create PR: ${result.stderr.toString()}`);
  }

  // gh pr create outputs the PR URL on success
  const url = result.stdout.toString().trim();

  // Extract PR number from URL (e.g., https://github.com/owner/repo/pull/123)
  const match = url.match(/\/pull\/(\d+)$/);
  if (!match?.[1]) {
    throw new Error(`Failed to parse PR URL: ${url}`);
  }

  return {
    number: parseInt(match[1], 10),
    url,
  };
}

/**
 * Get the CI checks status for a PR.
 * Returns "none" if no checks are configured, "pending" if checks are running,
 * "passing" if all checks passed, or "failing" if any check failed.
 *
 * @param prNumber - The PR number to check
 * @param repo - Optional owner/repo string (e.g., "owner/repo"). If not provided, uses current git context.
 */
export async function getPRChecksStatus(prNumber: number, repo?: string): Promise<ChecksStatus> {
  await ensureGhInstalled();

  const args = ["gh", "pr", "view", String(prNumber), "--json", "statusCheckRollup"];
  if (repo) {
    args.push("--repo", repo);
  }

  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (stderr.includes("not found") || stderr.includes("Could not resolve")) {
      throw new PRNotFoundError(prNumber);
    }
    throw new Error(`Failed to get PR #${prNumber} checks: ${stderr}`);
  }

  const data = JSON.parse(result.stdout.toString()) as {
    statusCheckRollup: CheckRollupItem[] | null;
  };

  return determineChecksStatus(data.statusCheckRollup);
}

/**
 * Get the review status for a PR.
 * Returns the current review decision: "approved", "changes_requested", "review_required", or "none".
 *
 * @param prNumber - The PR number to check
 * @param repo - Optional owner/repo string (e.g., "owner/repo"). If not provided, uses current git context.
 */
export async function getPRReviewStatus(prNumber: number, repo?: string): Promise<ReviewDecision> {
  await ensureGhInstalled();

  const args = ["gh", "pr", "view", String(prNumber), "--json", "reviewDecision"];
  if (repo) {
    args.push("--repo", repo);
  }

  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (stderr.includes("not found") || stderr.includes("Could not resolve")) {
      throw new PRNotFoundError(prNumber);
    }
    throw new Error(`Failed to get PR #${prNumber} review status: ${stderr}`);
  }

  const data = JSON.parse(result.stdout.toString()) as {
    reviewDecision: string | null;
  };

  return determineReviewDecision(data.reviewDecision);
}

/** Raw review thread data from GraphQL API */
export interface ReviewThread {
  isResolved: boolean;
}

/**
 * Compute comment status from raw review threads.
 * Returns total thread count and resolved count.
 * Exported for testing.
 */
export function computeCommentStatus(threads: ReviewThread[]): CommentStatus {
  const total = threads.length;
  const resolved = threads.filter((t) => t.isResolved).length;
  return { total, resolved };
}

/**
 * Get the comment thread resolution status for a PR.
 * Uses GraphQL API to fetch review thread resolution status.
 *
 * @param prNumber - The PR number to check
 * @param repo - Optional owner/repo string (e.g., "owner/repo"). If not provided, uses current git context.
 */
export async function getPRCommentStatus(prNumber: number, repo?: string): Promise<CommentStatus> {
  await ensureGhInstalled();

  // Get owner/repo from git remote if not provided
  let owner: string;
  let repoName: string;

  if (repo) {
    const parts = repo.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid repo format: ${repo}. Expected "owner/repo"`);
    }
    owner = parts[0];
    repoName = parts[1];
  } else {
    const remoteResult = await $`git remote get-url origin`.quiet().nothrow();
    if (remoteResult.exitCode !== 0) {
      throw new Error("Failed to get git remote URL");
    }
    const remoteUrl = remoteResult.stdout.toString().trim();
    // Parse owner/repo from git remote URL
    // Supports: git@github.com:owner/repo.git or https://github.com/owner/repo.git
    const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match || !match[1] || !match[2]) {
      throw new Error(`Failed to parse owner/repo from remote URL: ${remoteUrl}`);
    }
    owner = match[1];
    repoName = match[2];
  }

  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              isResolved
            }
          }
        }
      }
    }
  `;

  const args = [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${repoName}`,
    "-F",
    `prNumber=${prNumber}`,
  ];

  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (stderr.includes("not found") || stderr.includes("Could not resolve")) {
      throw new PRNotFoundError(prNumber);
    }
    throw new Error(`Failed to get PR #${prNumber} comment status: ${stderr}`);
  }

  const data = JSON.parse(result.stdout.toString()) as {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: ReviewThread[];
          };
        } | null;
      } | null;
    };
  };

  if (!data.data.repository?.pullRequest) {
    throw new PRNotFoundError(prNumber);
  }

  const threads = data.data.repository.pullRequest.reviewThreads.nodes;
  return computeCommentStatus(threads);
}

/**
 * Get both checks and review status for a PR in a single API call.
 * More efficient than calling getPRChecksStatus and getPRReviewStatus separately.
 */
export async function getPRChecksAndReviewStatus(
  prNumber: number,
  repo?: string,
): Promise<{ checks: ChecksStatus; review: ReviewDecision }> {
  await ensureGhInstalled();

  const args = ["gh", "pr", "view", String(prNumber), "--json", "statusCheckRollup,reviewDecision"];
  if (repo) {
    args.push("--repo", repo);
  }

  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (stderr.includes("not found") || stderr.includes("Could not resolve")) {
      throw new PRNotFoundError(prNumber);
    }
    throw new Error(`Failed to get PR #${prNumber} status: ${stderr}`);
  }

  const data = JSON.parse(result.stdout.toString()) as {
    statusCheckRollup: CheckRollupItem[] | null;
    reviewDecision: string | null;
  };

  return {
    checks: determineChecksStatus(data.statusCheckRollup),
    review: determineReviewDecision(data.reviewDecision),
  };
}

/**
 * Get the merge status of a PR (CI checks and review decision).
 */
export async function getPRMergeStatus(prNumber: number): Promise<PRMergeStatus> {
  await ensureGhInstalled();

  // Get PR status checks and review decision
  const args = ["gh", "pr", "view", String(prNumber), "--json", "statusCheckRollup,reviewDecision"];
  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    throw new PRNotFoundError(prNumber);
  }

  const data = JSON.parse(result.stdout.toString()) as {
    statusCheckRollup: CheckRollupItem[] | null;
    reviewDecision: string | null;
  };

  // Determine checks status and review decision using shared helpers
  const checksStatus = determineChecksStatus(data.statusCheckRollup);
  const reviewDecision = determineReviewDecision(data.reviewDecision);

  // PR is ready if checks are passing (or none configured) and reviews are approved (or not required)
  const isReady =
    (checksStatus === "passing" || checksStatus === "none") &&
    (reviewDecision === "approved" || reviewDecision === "none");

  return { checksStatus, reviewDecision, isReady };
}

/**
 * Land a PR by fast-forwarding the target branch to the PR's head commit.
 * This preserves commit hashes (no merge commits or squashing).
 *
 * The PR will be automatically closed by GitHub when the commits appear on the base branch.
 */
export async function landPR(prNumber: number, targetBranch: string = "main"): Promise<LandResult> {
  await ensureGhInstalled();

  // Get PR details
  const args = [
    "gh",
    "pr",
    "view",
    String(prNumber),
    "--json",
    "headRefName,headRefOid,baseRefName,state",
  ];
  const prResult = await ghExecWithLimit(args);

  if (prResult.exitCode !== 0) {
    const stderr = prResult.stderr.toString();
    if (stderr.includes("not found") || stderr.includes("Could not resolve")) {
      throw new PRNotFoundError(prNumber);
    }
    throw new Error(`Failed to get PR #${prNumber}: ${stderr}`);
  }

  const prData = JSON.parse(prResult.stdout.toString());

  if (prData.state !== "OPEN") {
    throw new PRNotFastForwardError(prNumber, `PR is ${prData.state.toLowerCase()}, not open`);
  }

  const headSha = prData.headRefOid;

  // Check if fast-forward is possible by verifying target branch is ancestor of head
  const canFF = await canFastForward(targetBranch, headSha);
  if (!canFF) {
    throw new PRNotFastForwardError(
      prNumber,
      `${targetBranch} is not an ancestor of the PR head. Rebase may be required.`,
    );
  }

  // Push the head commit to the target branch (fast-forward)
  const pushResult = await $`git push origin ${headSha}:refs/heads/${targetBranch}`
    .quiet()
    .nothrow();

  if (pushResult.exitCode !== 0) {
    const stderr = pushResult.stderr.toString();
    if (stderr.includes("non-fast-forward")) {
      throw new PRNotFastForwardError(prNumber, `${targetBranch} has diverged. Pull and retry.`);
    }
    throw new Error(`Failed to push to ${targetBranch}: ${stderr}`);
  }

  // GitHub automatically closes the PR when its commits appear on the base branch
  return { sha: headSha, prClosed: true };
}

/**
 * Check if a fast-forward merge is possible.
 * Returns true if targetBranch is an ancestor of headSha.
 */
async function canFastForward(targetBranch: string, headSha: string): Promise<boolean> {
  // Fetch latest from origin first
  await $`git fetch origin ${targetBranch}`.quiet().nothrow();

  // Check if origin/targetBranch is an ancestor of headSha
  const result = await $`git merge-base --is-ancestor origin/${targetBranch} ${headSha}`
    .quiet()
    .nothrow();

  return result.exitCode === 0;
}

/**
 * Delete a remote branch after landing.
 */
export async function deleteRemoteBranch(branchName: string): Promise<void> {
  await $`git push origin --delete ${branchName}`.quiet().nothrow();
}

/**
 * Get the base branch of a PR.
 */
export async function getPRBaseBranch(prNumber: number): Promise<string> {
  await ensureGhInstalled();

  const args = ["gh", "pr", "view", String(prNumber), "--json", "baseRefName"];
  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    throw new PRNotFoundError(prNumber);
  }

  const data = JSON.parse(result.stdout.toString()) as { baseRefName: string };
  return data.baseRefName;
}

/**
 * Retarget a PR to a new base branch.
 * Used when landing stacked PRs to update dependent PRs.
 */
export async function retargetPR(prNumber: number, newBase: string): Promise<void> {
  await ensureGhInstalled();

  const args = ["gh", "pr", "edit", String(prNumber), "--base", newBase];
  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to retarget PR #${prNumber} to ${newBase}: ${result.stderr.toString()}`,
    );
  }
}

/**
 * Close a PR without merging it.
 * Used when grouping commits causes a PR to be superseded by a group PR.
 */
export async function closePR(prNumber: number, comment?: string): Promise<void> {
  await ensureGhInstalled();

  // Add a comment explaining why the PR is being closed (if provided)
  if (comment) {
    const commentArgs = ["gh", "pr", "comment", String(prNumber), "--body", comment];
    await ghExecWithLimit(commentArgs);
  }

  const args = ["gh", "pr", "close", String(prNumber)];
  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (stderr.includes("not found") || stderr.includes("Could not resolve")) {
      throw new PRNotFoundError(prNumber);
    }
    throw new Error(`Failed to close PR #${prNumber}: ${stderr}`);
  }
}

/**
 * Get the current state of a PR.
 */
export async function getPRState(prNumber: number): Promise<"OPEN" | "CLOSED" | "MERGED"> {
  await ensureGhInstalled();

  const args = ["gh", "pr", "view", String(prNumber), "--json", "state"];
  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    throw new PRNotFoundError(prNumber);
  }

  const data = JSON.parse(result.stdout.toString()) as { state: "OPEN" | "CLOSED" | "MERGED" };
  return data.state;
}

/**
 * Get the body content of a PR.
 *
 * @param prNumber - The PR number
 * @returns The PR body as a string, or empty string if not set
 */
export async function getPRBody(prNumber: number): Promise<string> {
  await ensureGhInstalled();

  const args = ["gh", "pr", "view", String(prNumber), "--json", "body"];
  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (stderr.includes("not found") || stderr.includes("Could not resolve")) {
      throw new PRNotFoundError(prNumber);
    }
    throw new Error(`Failed to get PR #${prNumber} body: ${stderr}`);
  }

  const data = JSON.parse(result.stdout.toString()) as { body: string };
  return data.body || "";
}

/**
 * Update the body content of a PR.
 *
 * @param prNumber - The PR number
 * @param body - The new body content
 */
export async function updatePRBody(prNumber: number, body: string): Promise<void> {
  await ensureGhInstalled();

  const args = ["gh", "pr", "edit", String(prNumber), "--body", body];
  const result = await ghExecWithLimit(args);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (stderr.includes("not found") || stderr.includes("Could not resolve")) {
      throw new PRNotFoundError(prNumber);
    }
    throw new Error(`Failed to update PR #${prNumber} body: ${stderr}`);
  }
}

/**
 * Wait for a PR to reach a specific state (e.g., MERGED).
 * GitHub may take a moment to update PR state after a push.
 */
export async function waitForPRState(
  prNumber: number,
  expectedState: "OPEN" | "CLOSED" | "MERGED",
  maxWaitMs: number = 10000,
  pollIntervalMs: number = 1000,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const state = await getPRState(prNumber);
    if (state === expectedState) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return false;
}
