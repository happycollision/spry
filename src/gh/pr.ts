import type { SpryContext, CommandResult } from "../lib/context.ts";
import { GhAuthError, GhNotInstalledError } from "./errors.ts";
import { isTransientFailure, withRetry } from "./retry.ts";

export type PRState = "OPEN" | "CLOSED" | "MERGED";
export type ChecksStatus = "pending" | "passing" | "failing" | "none";
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";

export interface PRInfo {
  number: number;
  url: string;
  state: PRState;
  title: string;
  baseRefName: string;
  checksStatus: ChecksStatus;
  reviewDecision: ReviewDecision;
}

interface CheckContextNode {
  __typename?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
}

interface PRNode {
  number: number;
  url: string;
  state: PRState;
  title: string;
  baseRefName: string;
  reviewDecision: string | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          contexts?: { nodes?: CheckContextNode[] };
        } | null;
      };
    }>;
  };
}

interface GraphQLResponse {
  data?: {
    repository?: {
      pullRequests?: { nodes?: PRNode[] };
    };
  };
}

export function determineReviewDecision(raw: string | null): ReviewDecision {
  switch (raw) {
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

export function determineChecksStatus(
  rollup: Array<{ status: string; conclusion: string | null }> | null,
): ChecksStatus {
  if (!rollup || rollup.length === 0) return "none";

  const PASS_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  const FAIL_CONCLUSIONS = new Set([
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ]);

  let hasPending = false;
  let hasFailure = false;

  for (const item of rollup) {
    if (item.status !== "COMPLETED") {
      hasPending = true;
      continue;
    }
    if (item.conclusion && FAIL_CONCLUSIONS.has(item.conclusion)) {
      hasFailure = true;
    } else if (item.conclusion && !PASS_CONCLUSIONS.has(item.conclusion)) {
      hasFailure = true;
    }
  }

  if (hasFailure) return "failing";
  if (hasPending) return "pending";
  return "passing";
}

function flattenCheckContexts(
  pr: PRNode,
): Array<{ status: string; conclusion: string | null }> | null {
  const node = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!node) return null;
  const contexts = node.contexts?.nodes ?? [];
  if (contexts.length === 0) return [];

  return contexts.map((c) => {
    if (c.__typename === "StatusContext") {
      switch (c.state) {
        case "SUCCESS":
          return { status: "COMPLETED", conclusion: "SUCCESS" };
        case "FAILURE":
        case "ERROR":
          return { status: "COMPLETED", conclusion: "FAILURE" };
        case "PENDING":
        case "EXPECTED":
        default:
          return { status: "IN_PROGRESS", conclusion: null };
      }
    }
    return {
      status: c.status ?? "QUEUED",
      conclusion: c.conclusion ?? null,
    };
  });
}

export function parsePRResponse(json: string): PRInfo | null {
  const parsed = JSON.parse(json) as GraphQLResponse;
  const node = parsed.data?.repository?.pullRequests?.nodes?.[0];
  if (!node) return null;

  return {
    number: node.number,
    url: node.url,
    state: node.state,
    title: node.title,
    baseRefName: node.baseRefName,
    checksStatus: determineChecksStatus(flattenCheckContexts(node)),
    reviewDecision: determineReviewDecision(node.reviewDecision),
  };
}

const PR_QUERY = `
query($branch: String!) {
  repository(owner: $REPOSITORY_OWNER, name: $REPOSITORY_NAME) {
    pullRequests(headRefName: $branch, first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        url
        state
        title
        baseRefName
        reviewDecision
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { status conclusion }
                    ... on StatusContext { state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export interface FindPRsOptions {
  cwd?: string;
}

const NOT_INSTALLED_PATTERNS = [
  /command not found/i,
  /\bgh\s*:\s*not found\b/i,
  /no such file or directory.*gh/i,
];

const AUTH_PATTERNS = [
  /not logged into/i,
  /authentication required/i,
  /HTTP 401/i,
  /bad credentials/i,
];

function classifyError(stderr: string): "not-installed" | "auth" | "other" {
  if (NOT_INSTALLED_PATTERNS.some((p) => p.test(stderr))) return "not-installed";
  if (AUTH_PATTERNS.some((p) => p.test(stderr))) return "auth";
  return "other";
}

function throwForFailure(result: CommandResult): never {
  const kind = classifyError(result.stderr);
  if (kind === "not-installed") throw new GhNotInstalledError();
  if (kind === "auth") throw new GhAuthError(result.stderr.trim());
  throw new Error(`gh failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

async function lookupOne(
  ctx: SpryContext,
  branch: string,
  options?: FindPRsOptions,
): Promise<PRInfo | null> {
  const args = ["api", "graphql", "-F", `branch=${branch}`, "-f", `query=${PR_QUERY}`];
  const result = await withRetry(
    () => ctx.gh.run(args, { cwd: options?.cwd }),
    (r) => {
      if (r.exitCode === 0) return false;
      if (classifyError(r.stderr) !== "other") return false;
      return isTransientFailure(r);
    },
  );

  if (result.exitCode !== 0) throwForFailure(result);
  return parsePRResponse(result.stdout);
}

export async function findPRsForBranches(
  ctx: SpryContext,
  branches: string[],
  options?: FindPRsOptions,
): Promise<Map<string, PRInfo | null>> {
  const result = new Map<string, PRInfo | null>();
  for (const branch of branches) {
    result.set(branch, await lookupOne(ctx, branch, options));
  }
  return result;
}
