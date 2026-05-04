import { describe, test, expect, afterEach } from "bun:test";
import { syncCommand } from "../../src/commands/sync.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  SpryContext,
  TestRepo,
} from "../lib/index.ts";

const repos: TestRepo[] = [];

afterEach(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

async function makeRepoWithConfig(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], {
    cwd: repo.path,
  });
  return repo;
}

interface StubGhCall {
  args: string[];
  stdin?: string;
}

function stubGh(handler: (call: StubGhCall) => CommandResult): {
  gh: GhClient;
  calls: StubGhCall[];
} {
  const calls: StubGhCall[] = [];
  const gh: GhClient = {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const call = { args: [...args], stdin: options?.stdin };
      calls.push(call);
      return handler(call);
    },
  };
  return { gh, calls };
}

function makeCtx(repo: TestRepo, gh: GhClient): SpryContext {
  const realGit = createRealGitRunner();
  return {
    git: {
      run: (args, opts) => realGit.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }),
    },
    gh,
  };
}

function captureLogs(): { restore: () => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  return {
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
    out,
    err,
  };
}

function ghPRMap(
  branchToPR: Record<string, { number: number; baseRefName: string; state?: string }>,
) {
  return (call: StubGhCall): CommandResult => {
    if (call.args[0] === "pr" && call.args[1] === "edit") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (call.args[0] !== "api" || call.args[1] !== "graphql") {
      return {
        stdout: "",
        stderr: `unexpected call: ${call.args.join(" ")}`,
        exitCode: 1,
      };
    }
    const branchArg = call.args.find((a) => a.startsWith("branch="));
    const branch = branchArg?.slice("branch=".length) ?? "";
    const pr = branchToPR[branch];
    if (!pr) {
      return {
        stdout: JSON.stringify({
          data: { repository: { pullRequests: { nodes: [] } } },
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    const state = pr.state ?? "OPEN";
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: pr.number,
                  url: `https://github.com/owner/repo/pull/${pr.number}`,
                  state,
                  title: "T",
                  baseRefName: pr.baseRefName,
                  reviewDecision: null,
                  reviewThreads: { totalCount: 0, nodes: [] },
                  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                },
              ],
            },
          },
        },
      }),
      stderr: "",
      exitCode: 0,
    };
  };
}

describe("syncCommand bare", () => {
  test("empty stack: no commits in stack", async () => {
    const repo = await makeRepoWithConfig();
    const { gh, calls } = stubGh(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(logs.out.join("\n")).toContain("No commits in stack");
    expect(calls).toHaveLength(0);
  });

  test("injects missing Spry-Commit-Id trailers", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Untrailed commit"], {
      cwd: repo.path,
    });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(logs.out.join("\n")).toMatch(/Injected 1 commit ID/i);
    const log = await git.run(["log", "-1", "--format=%B"], { cwd: repo.path });
    expect(log.stdout).toContain("Spry-Commit-Id:");
  });

  test("no-op push when no remote branches match", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    const { gh, calls } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    // No remote branch yet → no push, no gh call
    expect(calls).toHaveLength(0);
    expect(logs.out.join("\n")).toContain("Sync complete");
  });

  test("pushes branch when remote ref already exists; retarget skipped if base correct", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Pre-create the remote branch
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });

    const { gh, calls } = stubGh(
      ghPRMap({ "spry/test/aaa11111": { number: 10, baseRefName: "main" } }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(logs.out.join("\n")).toContain("pushed spry/test/aaa11111");
    // base is correct → no retarget call (only the graphql lookup)
    const editCalls = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(editCalls).toHaveLength(0);
  });

  test("retargets when PR's baseRefName differs from expected", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });

    // Both branches exist remotely
    const aSha = (await git.run(["rev-parse", "HEAD~1"], { cwd: repo.path })).stdout.trim();
    const bSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${aSha}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });
    await git.run(["push", "origin", `${bSha}:refs/heads/spry/test/bbb22222`], {
      cwd: repo.path,
    });

    // PR for B has wrong base (points at main; should be at A's branch)
    const { gh, calls } = stubGh(
      ghPRMap({
        "spry/test/aaa11111": { number: 10, baseRefName: "main" },
        "spry/test/bbb22222": { number: 11, baseRefName: "main" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    const edits = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.args).toEqual(["pr", "edit", "11", "--base", "spry/test/aaa11111"]);
    expect(logs.out.join("\n")).toMatch(/retargeted PR #11/);
  });

  test("falls back gracefully when gh is unavailable; branches still pushed", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });

    const { gh } = stubGh(() => ({
      stdout: "",
      stderr: "/bin/sh: gh: command not found",
      exitCode: 127,
    }));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(logs.out.join("\n")).toContain("pushed spry/test/aaa11111");
    expect(logs.out.join("\n")).toMatch(/PR retargeting unavailable/);
  });
});
