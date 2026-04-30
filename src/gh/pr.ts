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
