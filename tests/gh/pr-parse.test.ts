import { describe, test, expect } from "bun:test";
import {
  parsePRResponse,
  determineChecksStatus,
  determineReviewDecision,
} from "../../src/gh/pr.ts";

describe("determineReviewDecision", () => {
  test("maps GitHub review decision strings", () => {
    expect(determineReviewDecision("APPROVED")).toBe("approved");
    expect(determineReviewDecision("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(determineReviewDecision("REVIEW_REQUIRED")).toBe("review_required");
  });

  test("maps null and unknown values to 'none'", () => {
    expect(determineReviewDecision(null)).toBe("none");
    expect(determineReviewDecision("FOOBAR")).toBe("none");
  });
});

describe("determineChecksStatus", () => {
  test("'none' for null or empty rollup", () => {
    expect(determineChecksStatus(null)).toBe("none");
    expect(determineChecksStatus([])).toBe("none");
  });

  test("'pending' when any check is in_progress or queued", () => {
    expect(
      determineChecksStatus([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toBe("pending");

    expect(determineChecksStatus([{ status: "QUEUED", conclusion: null }])).toBe("pending");
  });

  test("'failing' when any completed check is failure/cancelled/timed_out", () => {
    expect(
      determineChecksStatus([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("failing");

    expect(determineChecksStatus([{ status: "COMPLETED", conclusion: "CANCELLED" }])).toBe(
      "failing",
    );

    expect(determineChecksStatus([{ status: "COMPLETED", conclusion: "TIMED_OUT" }])).toBe(
      "failing",
    );
  });

  test("'passing' when all completed checks are success/skipped/neutral", () => {
    expect(
      determineChecksStatus([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
        { status: "COMPLETED", conclusion: "NEUTRAL" },
      ]),
    ).toBe("passing");
  });
});

describe("parsePRResponse", () => {
  function makeResponse(pr: object | null) {
    return JSON.stringify({
      data: {
        repository: {
          pullRequests: { nodes: pr === null ? [] : [pr] },
        },
      },
    });
  }

  test("returns null when no PRs match", () => {
    expect(parsePRResponse(makeResponse(null))).toBeNull();
  });

  test("parses an open PR with passing checks and approved review", () => {
    const json = makeResponse({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "OPEN",
      title: "Add login page",
      baseRefName: "main",
      reviewDecision: "APPROVED",
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });
    const pr = parsePRResponse(json);
    expect(pr).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "OPEN",
      title: "Add login page",
      baseRefName: "main",
      checksStatus: "passing",
      reviewDecision: "approved",
      reviewThreads: { resolved: 0, total: 0 },
    });
  });

  test("parses a merged PR", () => {
    const json = makeResponse({
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      state: "MERGED",
      title: "Old work",
      baseRefName: "main",
      reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    const pr = parsePRResponse(json);
    expect(pr?.state).toBe("MERGED");
    expect(pr?.checksStatus).toBe("none");
    expect(pr?.reviewDecision).toBe("none");
  });

  test("parses a PR with StatusContext entries (legacy commit statuses)", () => {
    const json = makeResponse({
      number: 11,
      url: "https://github.com/owner/repo/pull/11",
      state: "OPEN",
      title: "Legacy CI",
      baseRefName: "main",
      reviewDecision: "REVIEW_REQUIRED",
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [{ __typename: "StatusContext", state: "FAILURE" }],
                },
              },
            },
          },
        ],
      },
    });
    expect(parsePRResponse(json)?.checksStatus).toBe("failing");
  });

  test("parses a PR with no commits.nodes entries", () => {
    const json = makeResponse({
      number: 3,
      url: "https://github.com/owner/repo/pull/3",
      state: "OPEN",
      title: "No commits in response",
      baseRefName: "main",
      reviewDecision: null,
      commits: { nodes: [] },
    });
    expect(parsePRResponse(json)?.checksStatus).toBe("none");
  });

  test("counts reviewThreads as { resolved, total }", () => {
    const json = makeResponse({
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      state: "OPEN",
      title: "T",
      baseRefName: "main",
      reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      reviewThreads: {
        totalCount: 3,
        nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: true }],
      },
    });
    expect(parsePRResponse(json)?.reviewThreads).toEqual({ resolved: 2, total: 3 });
  });

  test("reviewThreads defaults to 0/0 when missing", () => {
    const json = makeResponse({
      number: 2,
      url: "https://github.com/owner/repo/pull/2",
      state: "OPEN",
      title: "T",
      baseRefName: "main",
      reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      // reviewThreads field intentionally omitted
    });
    expect(parsePRResponse(json)?.reviewThreads).toEqual({ resolved: 0, total: 0 });
  });

  test("reviewThreads with totalCount but no nodes counts resolved as 0", () => {
    const json = makeResponse({
      number: 3,
      url: "https://github.com/owner/repo/pull/3",
      state: "OPEN",
      title: "T",
      baseRefName: "main",
      reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      reviewThreads: { totalCount: 5, nodes: [] },
    });
    expect(parsePRResponse(json)?.reviewThreads).toEqual({ resolved: 0, total: 5 });
  });
});
