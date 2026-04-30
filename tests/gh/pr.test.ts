import { describe, test, expect } from "bun:test";
import { findPRsForBranches } from "../../src/gh/pr.ts";
import { GhAuthError, GhNotInstalledError } from "../../src/gh/errors.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  SpryContext,
  GitRunner,
} from "../../src/lib/context.ts";

function stubGh(responses: CommandResult[]): {
  ctx: SpryContext;
  calls: Array<{ args: string[]; options?: CommandOptions }>;
} {
  let i = 0;
  const calls: Array<{ args: string[]; options?: CommandOptions }> = [];
  const gh: GhClient = {
    async run(args, options) {
      calls.push({ args, options });
      const resp = responses[i++];
      if (!resp) {
        throw new Error(`stub gh: no more responses; called with ${args.join(" ")}`);
      }
      return resp;
    },
  };
  const git: GitRunner = {
    async run() {
      throw new Error("findPRsForBranches should not call git");
    },
  };
  return { ctx: { git, gh }, calls };
}

function ghOk(prJson: object | null): CommandResult {
  const body = JSON.stringify({
    data: {
      repository: { pullRequests: { nodes: prJson === null ? [] : [prJson] } },
    },
  });
  return { stdout: body, stderr: "", exitCode: 0 };
}

const samplePR = {
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  state: "OPEN",
  title: "T",
  baseRefName: "main",
  reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
};

describe("findPRsForBranches", () => {
  test("returns empty Map for empty branches array", async () => {
    const { ctx, calls } = stubGh([]);
    const result = await findPRsForBranches(ctx, []);
    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("returns null entry for branch with no matching PR", async () => {
    const { ctx } = stubGh([ghOk(null)]);
    const result = await findPRsForBranches(ctx, ["feature/x"]);
    expect(result.get("feature/x")).toBeNull();
    expect(result.size).toBe(1);
  });

  test("returns PRInfo for branch with a matching PR", async () => {
    const { ctx } = stubGh([ghOk(samplePR)]);
    const result = await findPRsForBranches(ctx, ["feature/x"]);
    expect(result.get("feature/x")?.number).toBe(1);
    expect(result.get("feature/x")?.state).toBe("OPEN");
  });

  test("queries each branch once and preserves order in result Map", async () => {
    const { ctx, calls } = stubGh([
      ghOk({ ...samplePR, number: 1 }),
      ghOk(null),
      ghOk({ ...samplePR, number: 3 }),
    ]);
    const result = await findPRsForBranches(ctx, ["a", "b", "c"]);
    expect([...result.keys()]).toEqual(["a", "b", "c"]);
    expect(result.get("a")?.number).toBe(1);
    expect(result.get("b")).toBeNull();
    expect(result.get("c")?.number).toBe(3);
    expect(calls).toHaveLength(3);
  });

  test("passes cwd to the gh client", async () => {
    const { ctx, calls } = stubGh([ghOk(null)]);
    await findPRsForBranches(ctx, ["x"], { cwd: "/tmp/repo" });
    expect(calls[0]!.options?.cwd).toBe("/tmp/repo");
  });

  test("throws GhNotInstalledError when stderr matches", async () => {
    const { ctx } = stubGh([
      { stdout: "", stderr: "/bin/sh: gh: command not found", exitCode: 127 },
    ]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toBeInstanceOf(GhNotInstalledError);
  });

  test("throws GhAuthError when stderr indicates not logged in", async () => {
    const { ctx } = stubGh([
      {
        stdout: "",
        stderr: "You are not logged into any GitHub hosts. Run `gh auth login`.",
        exitCode: 4,
      },
    ]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toBeInstanceOf(GhAuthError);
  });

  test("throws GhAuthError on HTTP 401", async () => {
    const { ctx } = stubGh([{ stdout: "", stderr: "HTTP 401: Bad credentials", exitCode: 1 }]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toBeInstanceOf(GhAuthError);
  });

  test("retries transient failures and returns success", async () => {
    const { ctx, calls } = stubGh([
      { stdout: "", stderr: "HTTP 503: Service Unavailable", exitCode: 1 },
      ghOk(samplePR),
    ]);
    const result = await findPRsForBranches(ctx, ["x"]);
    expect(result.get("x")?.number).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("throws after retries exhausted with stderr in the message", async () => {
    const transient = {
      stdout: "",
      stderr: "HTTP 503: Service Unavailable",
      exitCode: 1,
    };
    const { ctx } = stubGh([transient, transient, transient]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toThrow(/503/);
  });

  test("throws plain Error on non-transient unknown failure", async () => {
    const { ctx } = stubGh([{ stdout: "", stderr: "GraphQL error: malformed query", exitCode: 1 }]);
    await expect(findPRsForBranches(ctx, ["x"])).rejects.toThrow(/GraphQL error/);
  });
});
