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
  reviewThreads: { resolved: number; total: number };
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
  reviewThreads?: {
    totalCount?: number;
    nodes?: Array<{ isResolved?: boolean }>;
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
  const nodes = parsed.data?.repository?.pullRequests?.nodes ?? [];
  // A head branch can carry several PR records (GitHub never deletes a PR, so a
  // reused branch keeps its stale CLOSED/MERGED records). Only one can be OPEN
  // at a time, and that one is the branch's live PR — prefer it over any stale
  // record, even if the stale one sorts first by UPDATED_AT (closing a PR bumps
  // its timestamp). With no OPEN record, the newest node reflects the branch's
  // outcome so sp view can still render MERGED/CLOSED.
  const node = nodes.find((n) => n.state === "OPEN") ?? nodes[0];
  if (!node) return null;

  const threads = node.reviewThreads;
  const total = threads?.totalCount ?? 0;
  const resolved = (threads?.nodes ?? []).filter((t) => t.isResolved === true).length;

  return {
    number: node.number,
    url: node.url,
    state: node.state,
    title: node.title,
    baseRefName: node.baseRefName,
    checksStatus: determineChecksStatus(flattenCheckContexts(node)),
    reviewDecision: determineReviewDecision(node.reviewDecision),
    reviewThreads: { resolved, total },
  };
}

const PR_QUERY = `
query($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(headRefName: $branch, first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        url
        state
        title
        baseRefName
        reviewDecision
        reviewThreads(first: 100) {
          totalCount
          nodes { isResolved }
        }
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
  /** GitHub repo owner/name for the GraphQL query. gh does not auto-populate
   *  these for `api graphql`, so callers must supply them (from SpryConfig). */
  owner?: string;
  repo?: string;
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

function ghRetryPredicate(r: CommandResult): boolean {
  if (r.exitCode === 0) return false;
  if (classifyError(r.stderr) !== "other") return false;
  return isTransientFailure(r);
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
  const args = [
    "api",
    "graphql",
    "-F",
    `owner=${options?.owner ?? ""}`,
    "-F",
    `repo=${options?.repo ?? ""}`,
    "-F",
    `branch=${branch}`,
    "-f",
    `query=${PR_QUERY}`,
  ];
  const result = await withRetry(() => ctx.gh.run(args, { cwd: options?.cwd }), ghRetryPredicate);

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

export interface CreatePRParams {
  title: string;
  head: string;
  base: string;
  body: string;
}

export interface CreatePRResult {
  number: number;
  url: string;
}

export interface CreatePROptions {
  cwd?: string;
}

const PR_URL_PATTERN = /https:\/\/[^\s]+\/pull\/(\d+)/;

export async function createPR(
  ctx: SpryContext,
  params: CreatePRParams,
  options?: CreatePROptions,
): Promise<CreatePRResult> {
  const args = [
    "pr",
    "create",
    "--title",
    params.title,
    "--head",
    params.head,
    "--base",
    params.base,
    "--body-file",
    "-",
  ];
  const result = await withRetry(
    () => ctx.gh.run(args, { cwd: options?.cwd, stdin: params.body }),
    ghRetryPredicate,
  );
  if (result.exitCode !== 0) throwForFailure(result);
  const match = result.stdout.match(PR_URL_PATTERN);
  if (!match) {
    throw new Error(`createPR: could not parse PR URL from gh output: ${result.stdout}`);
  }
  return { number: Number(match[1]), url: match[0] };
}

export async function retargetPR(
  ctx: SpryContext,
  prNumber: number,
  newBase: string,
  options?: { cwd?: string },
): Promise<void> {
  const args = ["pr", "edit", String(prNumber), "--base", newBase];
  const result = await withRetry(() => ctx.gh.run(args, { cwd: options?.cwd }), ghRetryPredicate);
  if (result.exitCode !== 0) throwForFailure(result);
}

/**
 * Fetch a single PR's current body text. Uses `--jq .body` so gh emits the raw
 * body string (not wrapped in JSON), giving us exactly what GitHub stored.
 */
export async function fetchPRBody(
  ctx: SpryContext,
  prNumber: number,
  options?: { cwd?: string },
): Promise<string> {
  const args = ["pr", "view", String(prNumber), "--json", "body", "--jq", ".body"];
  const result = await withRetry(() => ctx.gh.run(args, { cwd: options?.cwd }), ghRetryPredicate);
  if (result.exitCode !== 0) throwForFailure(result);
  // gh --jq emits the value followed by a trailing newline; strip exactly one.
  return result.stdout.replace(/\n$/, "");
}

/**
 * Replace a PR's body. Sends the new body on stdin via `--body-file -` so bodies
 * with any content (quotes, markdown, newlines) are passed safely.
 */
export async function updatePRBody(
  ctx: SpryContext,
  prNumber: number,
  body: string,
  options?: { cwd?: string },
): Promise<void> {
  const args = ["pr", "edit", String(prNumber), "--body-file", "-"];
  const result = await withRetry(
    () => ctx.gh.run(args, { cwd: options?.cwd, stdin: body }),
    ghRetryPredicate,
  );
  if (result.exitCode !== 0) throwForFailure(result);
}
