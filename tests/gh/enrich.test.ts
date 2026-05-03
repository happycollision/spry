import { describe, test, expect } from "bun:test";
import { enrichUnits } from "../../src/gh/enrich.ts";
import type { CommandResult, GhClient, GitRunner, SpryContext } from "../../src/lib/context.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import type { SpryConfig } from "../../src/git/config.ts";

const config: SpryConfig = {
  trunk: "main",
  remote: "origin",
  branchPrefix: "spry/test",
};

function unit(id: string): PRUnit {
  return {
    type: "single",
    id,
    title: "T",
    commitIds: [id],
    commits: [id.repeat(5)],
    subjects: ["T"],
  };
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
  reviewThreads: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
};

function makeCtx(responses: CommandResult[]): SpryContext {
  let i = 0;
  const gh: GhClient = {
    async run() {
      const r = responses[i++];
      if (!r) throw new Error("stub gh: no more responses");
      return r;
    },
  };
  const git: GitRunner = {
    async run() {
      throw new Error("enrichUnits should not call git");
    },
  };
  return { git, gh };
}

describe("enrichUnits", () => {
  test("empty units array returns empty array, no gh call", async () => {
    const ctx = makeCtx([]);
    const result = await enrichUnits(ctx, [], config);
    expect(result).toEqual([]);
  });

  test("populates pr field for each unit on success", async () => {
    const ctx = makeCtx([ghOk(samplePR), ghOk(null)]);
    const result = await enrichUnits(ctx, [unit("aaa11111"), unit("bbb22222")], config);

    expect(result).toHaveLength(2);
    expect(result[0]!.unit.id).toBe("aaa11111");
    expect(result[0]!.pr?.number).toBe(1);
    expect(result[1]!.unit.id).toBe("bbb22222");
    expect(result[1]!.pr).toBeNull();
    expect(result.every((r) => r.error === undefined)).toBe(true);
  });

  test("returns error: 'no-gh' when gh is not installed", async () => {
    const ctx = makeCtx([{ stdout: "", stderr: "/bin/sh: gh: command not found", exitCode: 127 }]);
    const result = await enrichUnits(ctx, [unit("aaa11111"), unit("bbb22222")], config);

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.error === "no-gh")).toBe(true);
    expect(result.every((r) => r.pr === null)).toBe(true);
  });

  test("returns error: 'auth' when gh is not authenticated", async () => {
    const ctx = makeCtx([
      { stdout: "", stderr: "You are not logged into any GitHub hosts.", exitCode: 4 },
    ]);
    const result = await enrichUnits(ctx, [unit("aaa11111")], config);
    expect(result[0]!.error).toBe("auth");
  });

  test("returns error: 'no-remote' when repo is not a GitHub repo", async () => {
    const ctx = makeCtx([
      { stdout: "", stderr: "no GitHub remotes found in the current directory", exitCode: 1 },
    ]);
    const result = await enrichUnits(ctx, [unit("aaa11111")], config);
    expect(result[0]!.error).toBe("no-remote");
  });

  test("returns error: 'network' for other post-retry failures", async () => {
    // Three transient failures exhaust the retry budget
    const transient = {
      stdout: "",
      stderr: "HTTP 503: Service Unavailable",
      exitCode: 1,
    };
    const ctx = makeCtx([transient, transient, transient]);
    const result = await enrichUnits(ctx, [unit("aaa11111")], config);
    expect(result[0]!.error).toBe("network");
  });
});
