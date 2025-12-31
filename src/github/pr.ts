import { $ } from "bun";
import { ensureGhInstalled } from "./api.ts";

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
  baseRefName?: string;
}

export interface CreatePROptions {
  title: string;
  head: string;
  base: string;
  body?: string;
}

export type ChecksStatus = "pending" | "passing" | "failing";
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";

export interface PRMergeStatus {
  checksStatus: ChecksStatus;
  reviewDecision: ReviewDecision;
  isReady: boolean;
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

  const stateArg = options?.includeAll ? "--state" : "";
  const stateVal = options?.includeAll ? "all" : "";

  const result =
    await $`gh pr list --head ${branchName} ${stateArg} ${stateVal} --json number,url,state,title`
      .quiet()
      .nothrow();

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

/**
 * Create a new PR.
 */
export async function createPR(options: CreatePROptions): Promise<{ number: number; url: string }> {
  await ensureGhInstalled();

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

  const result = await $`${args}`;
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
 * Get the merge status of a PR (CI checks and review decision).
 */
export async function getPRMergeStatus(prNumber: number): Promise<PRMergeStatus> {
  await ensureGhInstalled();

  // Get PR status checks and review decision
  const result = await $`gh pr view ${prNumber} --json statusCheckRollup,reviewDecision`
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    throw new PRNotFoundError(prNumber);
  }

  const data = JSON.parse(result.stdout.toString()) as {
    statusCheckRollup: Array<{
      status: string;
      conclusion: string | null;
      state: string;
    }>;
    reviewDecision: string;
  };

  // Determine checks status
  let checksStatus: ChecksStatus;
  const checks = data.statusCheckRollup || [];

  if (checks.length === 0) {
    // No checks configured - consider it passing
    checksStatus = "passing";
  } else {
    const hasFailure = checks.some(
      (c) => c.conclusion === "FAILURE" || c.conclusion === "ERROR" || c.state === "FAILURE",
    );
    const allComplete = checks.every(
      (c) => c.status === "COMPLETED" || c.state === "SUCCESS" || c.state === "FAILURE",
    );

    if (hasFailure) {
      checksStatus = "failing";
    } else if (allComplete) {
      checksStatus = "passing";
    } else {
      checksStatus = "pending";
    }
  }

  // Determine review decision
  let reviewDecision: ReviewDecision;
  switch (data.reviewDecision) {
    case "APPROVED":
      reviewDecision = "approved";
      break;
    case "CHANGES_REQUESTED":
      reviewDecision = "changes_requested";
      break;
    case "REVIEW_REQUIRED":
      reviewDecision = "review_required";
      break;
    default:
      // Empty string or null means no review required by branch protection
      reviewDecision = "none";
  }

  // PR is ready if checks are passing and reviews are approved (or not required)
  const isReady =
    checksStatus === "passing" && (reviewDecision === "approved" || reviewDecision === "none");

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
  const prResult = await $`gh pr view ${prNumber} --json headRefName,headRefOid,baseRefName,state`
    .quiet()
    .nothrow();

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

  const result = await $`gh pr view ${prNumber} --json baseRefName`.quiet().nothrow();

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

  const result = await $`gh pr edit ${prNumber} --base ${newBase}`.quiet().nothrow();

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to retarget PR #${prNumber} to ${newBase}: ${result.stderr.toString()}`,
    );
  }
}

/**
 * Get the current state of a PR.
 */
export async function getPRState(prNumber: number): Promise<"OPEN" | "CLOSED" | "MERGED"> {
  await ensureGhInstalled();

  const result = await $`gh pr view ${prNumber} --json state`.quiet().nothrow();

  if (result.exitCode !== 0) {
    throw new PRNotFoundError(prNumber);
  }

  const data = JSON.parse(result.stdout.toString()) as { state: "OPEN" | "CLOSED" | "MERGED" };
  return data.state;
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
