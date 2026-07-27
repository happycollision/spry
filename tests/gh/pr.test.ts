import { describe, test, expect } from "bun:test";
import {
  findPRsForBranches,
  buildBatchedPRQuery,
  parseBatchedPRResponse,
  branchAlias,
  PR_QUERY_CHUNK_SIZE,
} from "../../src/gh/pr.ts";
import { GhAuthError, GhNotInstalledError } from "../../src/gh/errors.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  SpryContext,
  GitRunner,
} from "../../src/lib/context.ts";

/**
 * gh stub driven by a per-call handler (args → result). The batched lookup
 * builds each call's args from the branches in the chunk, so responses must be
 * derived from args, not a fixed positional list. A handler that returns a
 * function of the attempt index enables retry sequences.
 */
function stubGh(handler: (args: string[], attempt: number) => CommandResult): {
  ctx: SpryContext;
  calls: Array<{ args: string[]; options?: CommandOptions }>;
} {
  const calls: Array<{ args: string[]; options?: CommandOptions }> = [];
  let attempt = 0;
  const gh: GhClient = {
    async run(args, options) {
      calls.push({ args, options });
      return handler(args, attempt++);
    },
  };
  const git: GitRunner = {
    async run() {
      throw new Error("findPRsForBranches should not call git");
    },
  };
  return { ctx: { git, gh }, calls };
}

/**
 * Build a batched (aliased) gh response for one chunk call. `perBranch` maps
 * each branch name to its PR JSON (or null). The stub reads the `bK=<branch>`
 * args to learn which branches this chunk carried, then emits the matching
 * alias fields — mirroring how the real batched query resolves.
 */
function ghBatchFrom(args: string[], perBranch: (branch: string) => object | null): CommandResult {
  const repository: Record<string, { nodes: object[] }> = {};
  for (const a of args) {
    const m = /^(b\d+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, alias, branch] = m;
    const pr = perBranch(branch!);
    repository[alias!] = { nodes: pr === null ? [] : [pr] };
  }
  return { stdout: JSON.stringify({ data: { repository } }), stderr: "", exitCode: 0 };
}

/** Convenience: a batched stub whose branches all resolve via a lookup table. */
function ghBatchTable(table: Record<string, object | null>): (args: string[]) => CommandResult {
  return (args) => ghBatchFrom(args, (branch) => (branch in table ? table[branch]! : null));
}

const samplePR = {
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  state: "OPEN",
  title: "T",
  baseRefName: "main",
  reviewDecision: null,
  reviewThreads: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
};

const err = (stderr: string, exitCode = 1): CommandResult => ({ stdout: "", stderr, exitCode });

describe("findPRsForBranches (batched)", () => {
  test("returns empty Map for empty branches array without calling gh", async () => {
    const { ctx, calls } = stubGh(() => {
      throw new Error("should not call gh");
    });
    const result = await findPRsForBranches(ctx, []);
    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("looks up a whole chunk in ONE gh call", async () => {
    const { ctx, calls } = stubGh((args) => ghBatchTable({})(args));
    await findPRsForBranches(ctx, ["a", "b", "c"]);
    // Batched: 3 branches → 1 subprocess (the whole point of spry-b5wn.1).
    expect(calls).toHaveLength(1);
  });

  test("returns null entry for branch with no matching PR", async () => {
    const { ctx } = stubGh((args) => ghBatchTable({})(args));
    const result = await findPRsForBranches(ctx, ["feature/x"]);
    expect(result.get("feature/x")).toBeNull();
    expect(result.size).toBe(1);
  });

  test("returns PRInfo for branch with a matching PR", async () => {
    const { ctx } = stubGh((args) => ghBatchTable({ "feature/x": samplePR })(args));
    const result = await findPRsForBranches(ctx, ["feature/x"]);
    expect(result.get("feature/x")?.number).toBe(1);
    expect(result.get("feature/x")?.state).toBe("OPEN");
  });

  test("pairs each branch with its own PR and preserves input order", async () => {
    const { ctx } = stubGh((args) =>
      ghBatchTable({
        a: { ...samplePR, number: 1 },
        b: null,
        c: { ...samplePR, number: 3 },
      })(args),
    );
    const result = await findPRsForBranches(ctx, ["a", "b", "c"]);
    expect([...result.keys()]).toEqual(["a", "b", "c"]);
    expect(result.get("a")?.number).toBe(1);
    expect(result.get("b")).toBeNull();
    expect(result.get("c")?.number).toBe(3);
  });

  test("chunks branches beyond PR_QUERY_CHUNK_SIZE into multiple gh calls", async () => {
    const n = PR_QUERY_CHUNK_SIZE + 5;
    const branches = Array.from({ length: n }, (_, i) => `br-${i}`);
    const { ctx, calls } = stubGh((args) =>
      // Every branch gets a distinct PR number derived from its index.
      ghBatchFrom(args, (branch) => {
        const idx = Number(branch.slice("br-".length));
        return { ...samplePR, number: 1000 + idx };
      }),
    );
    const result = await findPRsForBranches(ctx, branches);
    // n > chunk size → 2 gh calls, not n.
    expect(calls).toHaveLength(2);
    expect(result.size).toBe(n);
    // Order + identity preserved across the chunk boundary.
    expect([...result.keys()]).toEqual(branches);
    expect(result.get("br-0")?.number).toBe(1000);
    expect(result.get(`br-${n - 1}`)?.number).toBe(1000 + n - 1);
  });

  test("passes cwd to the gh client", async () => {
    const { ctx, calls } = stubGh((args) => ghBatchTable({})(args));
    await findPRsForBranches(ctx, ["x"], { cwd: "/tmp/repo" });
    expect(calls[0]!.options?.cwd).toBe("/tmp/repo");
  });

  test("passes owner/repo and each branch as an aliased -F variable", async () => {
    const { ctx, calls } = stubGh((args) => ghBatchTable({})(args));
    await findPRsForBranches(ctx, ["feature/x", "feature/y"], { owner: "acme", repo: "widgets" });
    const args = calls[0]!.args;
    expect(args).toContain("owner=acme");
    expect(args).toContain("repo=widgets");
    // Branches ride as typed alias variables, NOT interpolated into the query.
    expect(args).toContain("b0=feature/x");
    expect(args).toContain("b1=feature/y");
    const query = args.find((a) => a.startsWith("query="))!;
    expect(query).toContain("$b0: String!");
    expect(query).toContain("$b1: String!");
    expect(query).toContain("b0: pullRequests(headRefName: $b0");
    // The branch name itself must not appear in the query text (injection-safe).
    expect(query).not.toContain("feature/x");
  });

  test("throws GhNotInstalledError when stderr matches", async () => {
    const { ctx } = stubGh(() => err("/bin/sh: gh: command not found", 127));
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toBeInstanceOf(GhNotInstalledError);
  });

  test("throws GhAuthError when stderr indicates not logged in", async () => {
    const { ctx } = stubGh(() =>
      err("You are not logged into any GitHub hosts. Run `gh auth login`.", 4),
    );
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toBeInstanceOf(GhAuthError);
  });

  test("throws GhAuthError on HTTP 401", async () => {
    const { ctx } = stubGh(() => err("HTTP 401: Bad credentials"));
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toBeInstanceOf(GhAuthError);
  });

  test("retries transient failures and returns success", async () => {
    const { ctx, calls } = stubGh((args, attempt) =>
      attempt === 0 ? err("HTTP 503: Service Unavailable") : ghBatchTable({ x: samplePR })(args),
    );
    const result = await findPRsForBranches(ctx, ["x"]);
    expect(result.get("x")?.number).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("throws after retries exhausted with stderr in the message", async () => {
    const { ctx } = stubGh(() => err("HTTP 503: Service Unavailable"));
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toThrow(/503/);
  });

  test("throws plain Error on non-transient unknown failure", async () => {
    const { ctx } = stubGh(() => err("GraphQL error: malformed query"));
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toThrow(/GraphQL error/);
  });
});

describe("buildBatchedPRQuery / parseBatchedPRResponse", () => {
  test("branchAlias is stable and index-based", () => {
    expect(branchAlias(0)).toBe("b0");
    expect(branchAlias(7)).toBe("b7");
  });

  test("query declares one typed variable and one alias per branch", () => {
    const q = buildBatchedPRQuery(["a", "b"]);
    expect(q).toContain("$b0: String!");
    expect(q).toContain("$b1: String!");
    expect(q).toContain("b0: pullRequests(headRefName: $b0");
    expect(q).toContain("b1: pullRequests(headRefName: $b1");
    // Shared selection is present per alias.
    expect(q.match(/statusCheckRollup/g)?.length).toBe(2);
  });

  test("parses aliased fields back into positional results", () => {
    const json = JSON.stringify({
      data: {
        repository: {
          b0: { nodes: [{ ...samplePR, number: 10, state: "OPEN" }] },
          b1: { nodes: [] },
          b2: { nodes: [{ ...samplePR, number: 12, state: "MERGED" }] },
        },
      },
    });
    const out = parseBatchedPRResponse(json, ["a", "b", "c"]);
    expect(out[0]?.number).toBe(10);
    expect(out[1]).toBeNull();
    expect(out[2]?.number).toBe(12);
  });

  test("prefers the OPEN record per alias (stale-PR safety carried over)", () => {
    const json = JSON.stringify({
      data: {
        repository: {
          b0: {
            nodes: [
              { ...samplePR, number: 99, state: "CLOSED" },
              { ...samplePR, number: 100, state: "OPEN" },
            ],
          },
        },
      },
    });
    const out = parseBatchedPRResponse(json, ["a"]);
    expect(out[0]?.number).toBe(100);
    expect(out[0]?.state).toBe("OPEN");
  });

  test("missing alias field yields null (defensive)", () => {
    const json = JSON.stringify({ data: { repository: { b0: null } } });
    const out = parseBatchedPRResponse(json, ["a"]);
    expect(out[0]).toBeNull();
  });
});
