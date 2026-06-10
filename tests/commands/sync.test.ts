import { describe, test, expect, afterEach } from "bun:test";
import { syncCommand, buildOpenCandidates } from "../../src/commands/sync.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  SpryContext,
  TestRepo,
} from "../lib/index.ts";
import { loadPRCache } from "../../src/gh/pr-cache.ts";

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

function trapExit(): { exitCode: number | undefined; restore: () => void } {
  const state: { exitCode: number | undefined } = { exitCode: undefined };
  const origExit = process.exit;
  // @ts-ignore
  process.exit = (code: number) => {
    state.exitCode = code;
    throw new Error("process.exit");
  };
  return {
    get exitCode() {
      return state.exitCode;
    },
    restore: () => {
      // @ts-ignore
      process.exit = origExit;
    },
  };
}

describe("sp sync --all (guard rails)", () => {
  test("--all with --open is rejected and exits 1", async () => {
    const repo = await makeRepoWithConfig();
    const { gh } = stubGh(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true, open: null });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }
    expect(trap.exitCode).toBe(1);
    expect(logs.err.join("\n")).toContain("--all");
    expect(logs.err.join("\n")).toContain("--open");
  });
});

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
    // No remote branch yet → no push, no retarget; gh called once for PR cache refresh
    const editCalls = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(editCalls).toHaveLength(0);
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
    let exitCode = -1;
    const origExit = process.exit;
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
    let exitCode = -1;
    const origExit = process.exit;
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

  test("fetches refs/spry/groups before parsing stack", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    const fetchedRefs: string[] = [];
    const { gh } = stubGh(ghPRMap({}));
    const realGit = createRealGitRunner();
    const ctx: SpryContext = {
      gh,
      git: {
        run: async (args, opts) => {
          if (args[0] === "fetch") fetchedRefs.push(args.slice(1).join(" "));
          return realGit.run(args, { ...opts, cwd: opts?.cwd ?? repo.path });
        },
      },
    };
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(fetchedRefs.some((r) => r.includes("refs/spry/groups"))).toBe(true);
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
    let exitCode = -1;
    const origExit = process.exit;
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

describe("syncCommand --open <ids>", () => {
  test("creates a PR for the listed unit", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(
      [
        "commit",
        "--allow-empty",
        "-m",
        "Add login\n\nDescription text\n\nSpry-Commit-Id: aaa11111",
      ],
      { cwd: repo.path },
    );

    const { gh, calls } = stubGh((call) => {
      if (call.args[0] === "api" && call.args[1] === "graphql") {
        return {
          stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (call.args[0] === "pr" && call.args[1] === "create") {
        return {
          stdout: "https://github.com/owner/repo/pull/55\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: `unexpected: ${call.args.join(" ")}`, exitCode: 1 };
    });
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa11111" });
    } finally {
      logs.restore();
    }
    const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(create).toBeDefined();
    expect(create?.args).toEqual([
      "pr",
      "create",
      "--title",
      "Add login",
      "--head",
      "spry/test/aaa11111",
      "--base",
      "main",
      "--body-file",
      "-",
    ]);
    expect(create?.stdin).toBe("Description text");
    expect(logs.out.join("\n")).toContain("Created PR #55");
    expect(logs.out.join("\n")).toContain("https://github.com/owner/repo/pull/55");
  });

  test("two-unit --open: second PR's base is first's branch", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });

    let prCounter = 100;
    const { gh, calls } = stubGh((call) => {
      if (call.args[0] === "api" && call.args[1] === "graphql") {
        return {
          stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (call.args[0] === "pr" && call.args[1] === "create") {
        const n = prCounter++;
        return {
          stdout: `https://github.com/owner/repo/pull/${n}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: `unexpected: ${call.args.join(" ")}`, exitCode: 1 };
    });
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa11111,bbb22222" });
    } finally {
      logs.restore();
    }
    const creates = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(creates).toHaveLength(2);
    const baseIdx0 = creates[0]?.args.indexOf("--base") ?? -1;
    expect(creates[0]?.args[baseIdx0 + 1]).toBe("main");
    const baseIdx1 = creates[1]?.args.indexOf("--base") ?? -1;
    expect(creates[1]?.args[baseIdx1 + 1]).toBe("spry/test/aaa11111");
  });

  test("--open of unit that already has a remote branch errors", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/aaa11111`], { cwd: repo.path });

    const { gh } = stubGh(ghPRMap({ "spry/test/aaa11111": { number: 1, baseRefName: "main" } }));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    let exited = false;
    const origExit = process.exit;
    process.exit = ((code: number) => {
      exited = true;
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa11111" });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit:")) throw e;
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(exited).toBe(true);
    expect(logs.err.join("\n")).toMatch(/already has a published branch/);
  });

  test("--open with prefix that matches multiple units errors", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: aaa22222"], {
      cwd: repo.path,
    });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    const origExit = process.exit;
    process.exit = ((code: number) => {
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa" });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit:")) throw e;
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(logs.err.join("\n")).toMatch(/matches multiple/i);
  });

  test("--open: per-target createPR failure mid-stack reports first PR and exits 1", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });

    let createCount = 0;
    const { gh } = stubGh((call) => {
      if (call.args[0] === "api" && call.args[1] === "graphql") {
        return {
          stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (call.args[0] === "pr" && call.args[1] === "create") {
        createCount++;
        if (createCount === 1) {
          return {
            stdout: "https://github.com/owner/repo/pull/100\n",
            stderr: "",
            exitCode: 0,
          };
        }
        // Second pr create fails non-transiently
        return {
          stdout: "",
          stderr: "validation error: branch already has open PR",
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: `unexpected: ${call.args.join(" ")}`, exitCode: 1 };
    });
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    let exitCode = -1;
    const origExit = process.exit;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa11111,bbb22222" });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit:")) throw e;
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(exitCode).toBe(1);
    expect(logs.out.join("\n")).toMatch(/Created PR #100/);
    expect(logs.err.join("\n")).toMatch(/Failed to create PR for spry\/test\/bbb22222/);
  });

  test("--open with empty string errors with no IDs provided", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    const origExit = process.exit;
    process.exit = ((code: number) => {
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "" });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit:")) throw e;
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(logs.err.join("\n")).toMatch(/no IDs provided/i);
  });

  test("--open of unknown id errors with not-found message", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    const origExit = process.exit;
    process.exit = ((code: number) => {
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "zzz99999" });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit:")) throw e;
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(logs.err.join("\n")).toMatch(/No commit or group matching/i);
  });

  test("--open of a group creates a PR with the stored group title", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "First\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["commit", "--allow-empty", "-m", "Second\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });
    const { saveGroupRecord } = await import("../../src/git/group-titles.ts");
    await saveGroupRecord(
      git,
      "grp00001",
      { title: "Auth Feature", members: ["aaa11111", "bbb22222"] },
      { cwd: repo.path },
    );

    const { gh, calls } = stubGh((call) => {
      if (call.args[0] === "api" && call.args[1] === "graphql") {
        return {
          stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (call.args[0] === "pr" && call.args[1] === "create") {
        return {
          stdout: "https://github.com/owner/repo/pull/42\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: `unexpected: ${call.args.join(" ")}`, exitCode: 1 };
    });
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    const origExit = process.exit;
    process.exit = ((code: number) => {
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "grp00001" });
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(create).toBeDefined();
    expect(create?.args).toContain("Auth Feature");
    expect(create?.args).toContain("spry/test/grp00001");
    expect(logs.out.join("\n")).toContain("Created PR #42");
  });
});

describe("buildOpenCandidates", () => {
  const config = { trunk: "main", remote: "origin", branchPrefix: "spry/test" };

  function single(id: string, title: string): PRUnit {
    return {
      type: "single",
      id,
      title,
      commitIds: [id],
      commits: [id.repeat(5)],
      subjects: [title],
    };
  }

  function group(id: string, title: string): PRUnit {
    return {
      type: "group",
      id,
      title,
      commitIds: [id],
      commits: [id.repeat(5)],
      subjects: [title],
    };
  }

  test("disables units that already have a remote branch", () => {
    const units = [single("aaa11111", "A"), single("bbb22222", "B")];
    const existing = new Set(["spry/test/aaa11111"]);
    const out = buildOpenCandidates(units, existing, config);
    expect(out[0]?.disabled).toBe(true);
    expect(out[0]?.hint).toBe("(already published)");
    expect(out[1]?.disabled).toBeUndefined();
  });

  test("does not disable group units (they can be opened)", () => {
    const units = [single("aaa11111", "A"), group("grp00001", "G")];
    const out = buildOpenCandidates(units, new Set(), config);
    expect(out[1]?.disabled).toBeUndefined();
    expect(out[1]?.hint).toBeUndefined();
  });
});

describe("PR cache", () => {
  test("sync writes PR info to refs/spry/prs after fetching", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Pre-publish the branch so sync sees it in existing remote refs
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });

    const { gh } = stubGh(ghPRMap({ "spry/test/aaa11111": { number: 5, baseRefName: "main" } }));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }

    expect(logs.out.join("\n")).toContain("Sync complete");

    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(cache["aaa11111"]?.number).toBe(5);
    expect(cache["aaa11111"]?.state).toBe("OPEN");
    expect(cache["aaa11111"]?.branch).toBe("spry/test/aaa11111");
    expect(cache["aaa11111"]?.cachedAt).toBeDefined();
  });

  test("sync does not write cache when gh is unavailable", async () => {
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

    // Cache should be empty — gh unavailable, so no PR info fetched
    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(Object.keys(cache)).toHaveLength(0);
  });
});
