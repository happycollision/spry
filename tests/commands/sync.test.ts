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

  test("stale-ref push prints warning and exits 1", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Pre-create the remote branch at our local HEAD
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });

    // Diverge the remote ref by pointing it at a sha the local clone doesn't
    // know about (the bare repo's main tip). This invalidates the
    // force-with-lease guard and triggers a stale-ref rejection.
    const mainSha = (await git.run(["rev-parse", "main"], { cwd: repo.originPath })).stdout.trim();
    await git.run(["update-ref", "refs/heads/spry/test/aaa11111", mainSha], {
      cwd: repo.originPath,
    });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    let exitCode: number | null = null;
    const origExit = process.exit;
    // @ts-expect-error - test stub
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit:")) throw e;
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(exitCode).toBe(1);
    expect(logs.err.join("\n")).toMatch(/Skipped spry\/test\/aaa11111.*remote diverged/);
  });

  test("per-PR retarget auth failure logs warning and exits 1", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });
    const aSha = (await git.run(["rev-parse", "HEAD~1"], { cwd: repo.path })).stdout.trim();
    const bSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${aSha}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });
    await git.run(["push", "origin", `${bSha}:refs/heads/spry/test/bbb22222`], {
      cwd: repo.path,
    });

    // Both PRs have wrong base so both get retargeted: #10 expects "main"
    // (first unit), so give it "stale-base"; #11 expects "spry/test/aaa11111"
    // (chained on #10), so "main" is wrong.
    const prMapHandler = ghPRMap({
      "spry/test/aaa11111": { number: 10, baseRefName: "stale-base" },
      "spry/test/bbb22222": { number: 11, baseRefName: "main" },
    });
    const { gh } = stubGh((call) => {
      if (call.args[0] === "api" && call.args[1] === "graphql") {
        return prMapHandler(call);
      }
      if (call.args[0] === "pr" && call.args[1] === "edit") {
        const num = call.args[2];
        if (num === "10") return { stdout: "", stderr: "", exitCode: 0 };
        return {
          stdout: "",
          stderr: "You are not logged into any GitHub hosts.",
          exitCode: 4,
        };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    });
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    let exitCode: number | null = null;
    const origExit = process.exit;
    // @ts-expect-error - test stub
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit:")) throw e;
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(exitCode).toBe(1);
    expect(logs.out.join("\n")).toMatch(/retargeted PR #10/);
    expect(logs.err.join("\n")).toMatch(/Could not retarget PR #11/);
  });

  test("detached HEAD: errors and exits 1", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    // Detach HEAD
    const sha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["checkout", sha], { cwd: repo.path });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    let exitCode: number | null = null;
    const origExit = process.exit;
    // @ts-expect-error - test stub
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit:")) throw e;
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(exitCode).toBe(1);
    expect(logs.err.join("\n")).toMatch(/detached HEAD/i);
  });
});
