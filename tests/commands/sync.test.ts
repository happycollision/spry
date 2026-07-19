import { describe, test, expect, afterAll } from "bun:test";
import {
  syncCommand,
  buildOpenCandidates,
  checkSync,
  stackHasReorder,
  parkMismatchedToTrunk,
} from "../../src/commands/sync.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import { captureLogs, trapExit } from "../lib/capture.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  SpryContext,
  TestRepo,
} from "../lib/index.ts";
import { loadPRCache } from "../../src/gh/pr-cache.ts";
import { registerBranch, loadTrackedBranches } from "../../src/git/tracked-branches.ts";
import type { PRInfo } from "../../src/gh/pr.ts";
import type { SpryConfig } from "../../src/git/config.ts";

const repos: TestRepo[] = [];

// afterAll, not afterEach: under --concurrent a per-test cleanup hook would delete
// repos out from under still-running sibling tests.
afterAll(async () => {
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

describe("sp sync --all (guard rails)", () => {
  test("--all with --open is rejected and exits 1", async () => {
    const repo = await makeRepoWithConfig();
    const { gh } = stubGh(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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

  test("tolerates dirty tracked files because sync does not rebase", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await Bun.write(`${repo.path}/README.md`, "# Test repo\n\ndirty but local\n");

    const { gh, calls } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }

    const editCalls = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(editCalls).toHaveLength(0);
    expect(logs.out.join("\n")).toContain("Sync complete");
    const status = (await git.run(["status", "--porcelain"], { cwd: repo.path })).stdout;
    expect(status).toContain(" M README.md");
  });

  test("skips push when remote ref already matches local tip", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Pre-create the remote branch at the exact tip sync would push.
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });

    // Record every `git push` that targets a spry branch ref.
    const branchPushes: string[] = [];
    const realGit = createRealGitRunner();
    const ctx: SpryContext = {
      gh: stubGh(ghPRMap({ "spry/test/aaa11111": { number: 10, baseRefName: "main" } })).gh,
      git: {
        run: async (args, opts) => {
          if (args[0] === "push" && args.some((a) => a.includes("refs/heads/spry/test/"))) {
            branchPushes.push(args.join(" "));
          }
          return realGit.run(args, { ...opts, cwd: opts?.cwd ?? repo.path });
        },
      },
    };
    const logs = await captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }

    // Remote tip already equals local tip → no push should happen.
    expect(branchPushes).toEqual([]);
    expect(logs.out.join("\n")).toContain("Sync complete");
  });

  test("pushes branch when remote ref already exists; retarget skipped if base correct", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Pre-create the remote branch at an OLDER sha (main) so the remote tip
    // differs from the local unit tip — this is what warrants a real push.
    const mainSha = (await git.run(["rev-parse", "main"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${mainSha}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });

    const { gh, calls } = stubGh(
      ghPRMap({ "spry/test/aaa11111": { number: 10, baseRefName: "main" } }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    // Remote branch exists at an older sha (main) so a real push is warranted.
    const mainSha = (await git.run(["rev-parse", "main"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${mainSha}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });

    const { gh } = stubGh(() => ({
      stdout: "",
      stderr: "/bin/sh: gh: command not found",
      exitCode: 127,
    }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
    const logs = await captureLogs();
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
  const config = {
    trunk: "main",
    remote: "origin",
    branchPrefix: "spry/test",
    autoDeleteOnLand: false,
  };

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
    const existing = new Map([["spry/test/aaa11111", "deadbeef"]]);
    const out = buildOpenCandidates(units, existing, config);
    expect(out[0]?.disabled).toBe(true);
    expect(out[0]?.hint).toBe("(already published)");
    expect(out[1]?.disabled).toBeUndefined();
  });

  test("does not disable group units (they can be opened)", () => {
    const units = [single("aaa11111", "A"), group("grp00001", "G")];
    const out = buildOpenCandidates(units, new Map(), config);
    expect(out[1]?.disabled).toBeUndefined();
    expect(out[1]?.hint).toBeUndefined();
  });
});

describe("sp sync --all (loop)", () => {
  test("no tracked branches: reports and returns cleanly", async () => {
    const repo = await makeRepoWithConfig();
    // Detached HEAD so nothing gets registered.
    const git = createRealGitRunner();
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["checkout", head], { cwd: repo.path });

    const { gh } = stubGh(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }
    expect(logs.out.join("\n")).toContain("No tracked branches");
  });

  test("pushes already-published branches across two stacks", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();

    // Remote branches exist at an older sha (main) so a real push is warranted.
    const mainSha = (await git.run(["rev-parse", "main"], { cwd: repo.path })).stdout.trim();

    // Stack A: feature-a with one published unit
    await git.run(["checkout", "-b", "feature-a"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A work\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["push", "origin", `${mainSha}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });
    await registerBranch(git, "feature-a", { cwd: repo.path });

    // Stack B: feature-b with one published unit
    await git.run(["checkout", "main"], { cwd: repo.path });
    await git.run(["checkout", "-b", "feature-b"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "B work\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });
    await git.run(["push", "origin", `${mainSha}:refs/heads/spry/test/bbb22222`], {
      cwd: repo.path,
    });
    await registerBranch(git, "feature-b", { cwd: repo.path });

    // gh: no PRs found (empty), so retarget/cache do nothing.
    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    const out = logs.out.join("\n");
    expect(out).toContain("spry/test/aaa11111");
    expect(out).toContain("spry/test/bbb22222");
    expect(trap.exitCode).toBeUndefined();
  });

  test("tolerates dirty tracked files while syncing tracked stacks", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature-a"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A work\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    // Remote branch exists at an older sha (main) so a real push is warranted.
    const mainSha = (await git.run(["rev-parse", "main"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${mainSha}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });
    await registerBranch(git, "feature-a", { cwd: repo.path });
    await Bun.write(`${repo.path}/README.md`, "# Test repo\n\ndirty but local\n");

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(logs.out.join("\n")).toContain("spry/test/aaa11111");
    expect(logs.out.join("\n")).toContain("Sync complete");
    expect(trap.exitCode).toBeUndefined();
    const status = (await git.run(["status", "--porcelain"], { cwd: repo.path })).stdout;
    expect(status).toContain(" M README.md");
  });

  test("prunes a tracked branch that no longer exists locally", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature-alive"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "alive\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await registerBranch(git, "ghost-branch", { cwd: repo.path });
    await registerBranch(git, "feature-alive", { cwd: repo.path });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(logs.out.join("\n")).toContain("ghost-branch");
    expect(logs.out.join("\n")).toContain("removed");
    const tracked = await loadTrackedBranches(git, { cwd: repo.path });
    expect(tracked).not.toContain("ghost-branch");
    expect(tracked).toContain("feature-alive");
  });

  test("injects missing IDs into a non-current tracked branch via ref update, leaving HEAD untouched", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();

    // feature-other has a commit with NO Spry-Commit-Id, and is NOT checked out.
    await git.run(["checkout", "-b", "feature-other"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "needs an id"], { cwd: repo.path });
    const otherTipBefore = (
      await git.run(["rev-parse", "refs/heads/feature-other"], { cwd: repo.path })
    ).stdout.trim();

    // Move HEAD onto a clean branch off main so feature-other is not current.
    await git.run(["checkout", "main"], { cwd: repo.path });
    await git.run(["checkout", "-b", "feature-current"], { cwd: repo.path });
    const headBefore = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await registerBranch(git, "feature-other", { cwd: repo.path });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(logs.out.join("\n")).toContain("Injected");

    // feature-other's ref moved and its commit now carries an injected ID.
    const otherTipAfter = (
      await git.run(["rev-parse", "refs/heads/feature-other"], { cwd: repo.path })
    ).stdout.trim();
    expect(otherTipAfter).not.toBe(otherTipBefore);
    const msg = (
      await git.run(["log", "-1", "--format=%B", "refs/heads/feature-other"], { cwd: repo.path })
    ).stdout;
    expect(msg).toContain("Spry-Commit-Id:");

    // HEAD and the working tree are untouched.
    const headAfter = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    expect(headAfter).toBe(headBefore);
    const status = (await git.run(["status", "--porcelain"], { cwd: repo.path })).stdout.trim();
    expect(status).toBe("");
  });

  test("--all writes a combined PR cache without clobbering across stacks", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();

    // Two published stacks: feature-a (aaa11111) and feature-b (bbb22222)
    for (const [branch, id] of [
      ["feature-a", "aaa11111"],
      ["feature-b", "bbb22222"],
    ] as const) {
      await git.run(["checkout", "main"], { cwd: repo.path });
      await git.run(["checkout", "-b", branch], { cwd: repo.path });
      await git.run(["commit", "--allow-empty", "-m", `${branch} work\n\nSpry-Commit-Id: ${id}`], {
        cwd: repo.path,
      });
      const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
      await git.run(["push", "origin", `${head}:refs/heads/spry/test/${id}`], { cwd: repo.path });
      await registerBranch(git, branch, { cwd: repo.path });
    }

    // gh stub: report an OPEN PR for each spry branch.
    const { gh } = stubGh(
      ghPRMap({
        "spry/test/aaa11111": { number: 1, baseRefName: "main" },
        "spry/test/bbb22222": { number: 2, baseRefName: "main" },
      }),
    );

    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(Object.keys(cache).sort()).toEqual(["aaa11111", "bbb22222"]);
  });

  test("retargets mismatched PRs across multiple stacks", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();

    // Two independent two-unit stacks. In each, the second unit's PR points at
    // main but should be retargeted onto the first unit's branch.
    const stacks = [
      { branch: "feature-a", lower: "aaa11111", upper: "bbb22222" },
      { branch: "feature-b", lower: "ccc33333", upper: "ddd44444" },
    ] as const;
    for (const { branch, lower, upper } of stacks) {
      await git.run(["checkout", "main"], { cwd: repo.path });
      await git.run(["checkout", "-b", branch], { cwd: repo.path });
      await git.run(["commit", "--allow-empty", "-m", `lower\n\nSpry-Commit-Id: ${lower}`], {
        cwd: repo.path,
      });
      await git.run(["commit", "--allow-empty", "-m", `upper\n\nSpry-Commit-Id: ${upper}`], {
        cwd: repo.path,
      });
      const lowerSha = (await git.run(["rev-parse", "HEAD~1"], { cwd: repo.path })).stdout.trim();
      const upperSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
      await git.run(["push", "origin", `${lowerSha}:refs/heads/spry/test/${lower}`], {
        cwd: repo.path,
      });
      await git.run(["push", "origin", `${upperSha}:refs/heads/spry/test/${upper}`], {
        cwd: repo.path,
      });
      await registerBranch(git, branch, { cwd: repo.path });
    }

    // Lower units have the correct base (main); upper units have a stale base.
    const { gh, calls } = stubGh(
      ghPRMap({
        "spry/test/aaa11111": { number: 10, baseRefName: "main" },
        "spry/test/bbb22222": { number: 11, baseRefName: "main" },
        "spry/test/ccc33333": { number: 12, baseRefName: "main" },
        "spry/test/ddd44444": { number: 13, baseRefName: "main" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    const edits = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(edits).toHaveLength(2);
    const editArgs = edits.map((e) => e.args);
    expect(editArgs).toContainEqual(["pr", "edit", "11", "--base", "spry/test/aaa11111"]);
    expect(editArgs).toContainEqual(["pr", "edit", "13", "--base", "spry/test/ccc33333"]);
    expect(trap.exitCode).toBeUndefined();
  });

  test("push failure on one stack exits 1 but still saves the tracked list", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();

    const localMainSha = (await git.run(["rev-parse", "main"], { cwd: repo.path })).stdout.trim();

    // feature-a is healthy: its remote branch starts at an older sha (main) so a
    // real push is warranted (a same-sha remote would now be skipped).
    await git.run(["checkout", "-b", "feature-a"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "feature-a\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["push", "origin", `${localMainSha}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });
    await registerBranch(git, "feature-a", { cwd: repo.path });

    // feature-b: push its own tip so the local clone's tracking ref expects that
    // sha, then diverge origin behind its back to trip force-with-lease.
    await git.run(["checkout", "main"], { cwd: repo.path });
    await git.run(["checkout", "-b", "feature-b"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "feature-b\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });
    const bHead = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${bHead}:refs/heads/spry/test/bbb22222`], { cwd: repo.path });
    await registerBranch(git, "feature-b", { cwd: repo.path });

    // Diverge feature-b's remote ref to a sha the local clone doesn't expect.
    const originMainSha = (
      await git.run(["rev-parse", "main"], { cwd: repo.originPath })
    ).stdout.trim();
    await git.run(["update-ref", "refs/heads/spry/test/bbb22222", originMainSha], {
      cwd: repo.originPath,
    });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    expect(logs.err.join("\n")).toMatch(/Skipped spry\/test\/bbb22222.*remote diverged/);
    // The healthy stack still pushed.
    expect(logs.out.join("\n")).toContain("pushed spry/test/aaa11111");
    // Both branches remain tracked even though one failed.
    const tracked = await loadTrackedBranches(git, { cwd: repo.path });
    expect(tracked).toContain("feature-a");
    expect(tracked).toContain("feature-b");
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
    const logs = await captureLogs();
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

  test("sync does not cache a stale MERGED/CLOSED PR for the branch", async () => {
    // A head branch can carry a stale MERGED/CLOSED PR record (GitHub never
    // deletes PRs). That record is not the unit's live PR — sync must not cache
    // it, and must not print "Updated PR cache" for it. Only an OPEN PR counts.
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });

    const { gh } = stubGh(
      ghPRMap({ "spry/test/aaa11111": { number: 9, baseRefName: "main", state: "MERGED" } }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }

    expect(logs.out.join("\n")).not.toContain("Updated PR cache");
    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(Object.keys(cache)).toHaveLength(0);
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
    const logs = await captureLogs();
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

describe("checkSync", () => {
  test("checkSync performs no gh pr edit/create calls", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/aaa11111`], { cwd: repo.path });

    const { gh, calls } = stubGh(
      ghPRMap({ "spry/test/aaa11111": { number: 1, baseRefName: "main" } }),
    );
    const ctx = makeCtx(repo, gh);

    // checkSync writes the PR cache internally, which logs "Updated PR
    // cache" through console.log — hold the output lock while it runs.
    const logs = await captureLogs();
    let result: Awaited<ReturnType<typeof checkSync>>;
    try {
      result = await checkSync(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(result.units.map((u) => u.id)).toEqual(["aaa11111"]);
    expect(calls.some((c) => c.args[0] === "pr" && c.args[1] === "edit")).toBe(false);
    expect(calls.some((c) => c.args[0] === "pr" && c.args[1] === "create")).toBe(false);
  });
});

describe("stackHasReorder", () => {
  const config = { trunk: "main", remote: "origin", branchPrefix: "spry/test" } as SpryConfig;
  const unit = (id: string): PRUnit =>
    ({ id, commits: [id], subjects: ["s"], title: "t" }) as unknown as PRUnit;

  test("false when every open PR base already equals its expected base", () => {
    const units = [unit("aaa11111"), unit("bbb22222")];
    const prMap = new Map<string, PRInfo | null>([
      ["spry/test/aaa11111", { number: 1, state: "OPEN", baseRefName: "main" } as PRInfo],
      [
        "spry/test/bbb22222",
        { number: 2, state: "OPEN", baseRefName: "spry/test/aaa11111" } as PRInfo,
      ],
    ]);
    expect(stackHasReorder(units, prMap, config)).toBe(false);
  });

  test("true when an open PR base differs from its expected base", () => {
    const units = [unit("aaa11111"), unit("bbb22222")];
    // bbb should be based on aaa's branch but GitHub still has it on main
    const prMap = new Map<string, PRInfo | null>([
      ["spry/test/aaa11111", { number: 1, state: "OPEN", baseRefName: "main" } as PRInfo],
      ["spry/test/bbb22222", { number: 2, state: "OPEN", baseRefName: "main" } as PRInfo],
    ]);
    expect(stackHasReorder(units, prMap, config)).toBe(true);
  });

  test("ignores closed/merged PRs and missing PRs", () => {
    const units = [unit("aaa11111"), unit("bbb22222")];
    const prMap = new Map<string, PRInfo | null>([
      ["spry/test/aaa11111", { number: 1, state: "MERGED", baseRefName: "main" } as PRInfo],
      ["spry/test/bbb22222", null],
    ]);
    expect(stackHasReorder(units, prMap, config)).toBe(false);
  });
});

describe("parkMismatchedToTrunk", () => {
  const config = { trunk: "main", remote: "origin", branchPrefix: "spry/test" } as SpryConfig;
  const unit = (id: string): PRUnit =>
    ({ id, commits: [id], subjects: ["s"], title: "t" }) as unknown as PRUnit;

  test("retargets each mismatched open PR to trunk and returns no failures", async () => {
    const repo = await makeRepoWithConfig();
    const units = [unit("aaa11111"), unit("bbb22222")];
    const prMap = new Map<string, PRInfo | null>([
      [
        "spry/test/aaa11111",
        { number: 10, state: "OPEN", baseRefName: "spry/test/bbb22222" } as PRInfo,
      ],
      [
        "spry/test/bbb22222",
        { number: 11, state: "OPEN", baseRefName: "spry/test/ccc33333" } as PRInfo,
      ],
    ]);
    const { gh, calls } = stubGh(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    let failed: Set<string>;
    try {
      failed = await parkMismatchedToTrunk(
        ctx,
        config,
        units,
        ["spry/test/aaa11111", "spry/test/bbb22222"],
        prMap,
        repo.path,
      );
    } finally {
      logs.restore();
    }
    const edits = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(edits.map((c) => c.args)).toEqual([
      ["pr", "edit", "10", "--base", "main"],
      ["pr", "edit", "11", "--base", "main"],
    ]);
    expect(failed.size).toBe(0);
    expect(logs.out.join("\n")).toContain("↻ parked PR #10 → main");
    expect(logs.out.join("\n")).toContain("↻ parked PR #11 → main");
  });

  test("does not park a PR already on its correct stacked base", async () => {
    const repo = await makeRepoWithConfig();
    const units = [unit("aaa11111"), unit("bbb22222")];
    // bbb is already correctly based on aaa's branch — must be skipped.
    const prMap = new Map<string, PRInfo | null>([
      ["spry/test/aaa11111", { number: 10, state: "OPEN", baseRefName: "main" } as PRInfo],
      [
        "spry/test/bbb22222",
        { number: 11, state: "OPEN", baseRefName: "spry/test/aaa11111" } as PRInfo,
      ],
    ]);
    const { gh, calls } = stubGh(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    let failed: Set<string>;
    try {
      failed = await parkMismatchedToTrunk(
        ctx,
        config,
        units,
        ["spry/test/aaa11111", "spry/test/bbb22222"],
        prMap,
        repo.path,
      );
    } finally {
      logs.restore();
    }
    const edits = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(edits).toHaveLength(0); // aaa already on trunk, bbb already correctly stacked
    expect(failed.size).toBe(0);
    expect(logs.out.join("\n")).not.toContain("parked");
  });

  test("does not retarget a PR already based on trunk", async () => {
    const repo = await makeRepoWithConfig();
    const units = [unit("aaa11111")];
    const prMap = new Map<string, PRInfo | null>([
      ["spry/test/aaa11111", { number: 10, state: "OPEN", baseRefName: "main" } as PRInfo],
    ]);
    const { gh, calls } = stubGh(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    let failed: Set<string>;
    try {
      failed = await parkMismatchedToTrunk(
        ctx,
        config,
        units,
        ["spry/test/aaa11111"],
        prMap,
        repo.path,
      );
    } finally {
      logs.restore();
    }
    const edits = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(edits).toHaveLength(0);
    expect(failed.size).toBe(0);
    expect(logs.out.join("\n")).not.toContain("parked");
  });

  test("records a failed park and does not throw", async () => {
    const repo = await makeRepoWithConfig();
    const units = [unit("aaa11111")];
    const prMap = new Map<string, PRInfo | null>([
      [
        "spry/test/aaa11111",
        { number: 10, state: "OPEN", baseRefName: "spry/test/bbb22222" } as PRInfo,
      ],
    ]);
    const { gh } = stubGh((call) => {
      if (call.args[0] === "pr" && call.args[1] === "edit") {
        return { stdout: "", stderr: "boom", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    let failed: Set<string>;
    try {
      failed = await parkMismatchedToTrunk(
        ctx,
        config,
        units,
        ["spry/test/aaa11111"],
        prMap,
        repo.path,
      );
    } finally {
      logs.restore();
    }
    expect(failed.has("spry/test/aaa11111")).toBe(true);
    expect(logs.err.join("\n")).toMatch(/Could not park PR #10/);
  });
});

describe("syncCommand reorder park", () => {
  test("parks mismatched PRs to trunk before re-stacking", async () => {
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

    // Simulate a prior reorder still visible on GitHub: A's PR sits on B's
    // branch, B's PR sits on main. Expected after this sync: A->main, B->A.
    const { gh, calls } = stubGh(
      ghPRMap({
        "spry/test/aaa11111": { number: 10, baseRefName: "spry/test/bbb22222" },
        "spry/test/bbb22222": { number: 11, baseRefName: "main" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }

    const edits = calls
      .filter((c) => c.args[0] === "pr" && c.args[1] === "edit")
      .map((c) => c.args.join(" "));
    // Phase 1 park: A (mismatched, base=B, not trunk, expected=main) -> main.
    // (B is already on main and expected=A, so it is NOT parked — only re-stacked.)
    expect(edits).toContain("pr edit 10 --base main");
    // Phase 3 re-stack: B -> A's branch.
    expect(edits).toContain("pr edit 11 --base spry/test/aaa11111");
    // Park precedes the re-stack of B.
    const parkIdx = edits.indexOf("pr edit 10 --base main");
    const restackIdx = edits.indexOf("pr edit 11 --base spry/test/aaa11111");
    expect(parkIdx).toBeLessThan(restackIdx);
    // The park log line is the signal UNIQUE to Phase 1 — Phase 3 retarget
    // reaches the same final bases from the static prMap snapshot, so without
    // this assertion the test passes even if the park call is removed.
    expect(logs.out.join("\n")).toContain("↻ parked PR #10 → main");
  });

  test("no park calls when the stack is not reordered", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    const aSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${aSha}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });

    const { gh, calls } = stubGh(
      ghPRMap({ "spry/test/aaa11111": { number: 10, baseRefName: "main" } }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    const edits = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(edits).toHaveLength(0);
    expect(logs.out.join("\n")).not.toContain("parked");
  });
});

describe("syncCommand park failure is fail-safe", () => {
  test("a failed park excludes that branch from the push and exits 1", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });
    // Push A's branch at an OLDER sha (main) so a real push WOULD occur absent the skip.
    const mainSha = (await git.run(["rev-parse", "main"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${mainSha}:refs/heads/spry/test/aaa11111`], {
      cwd: repo.path,
    });
    const bSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${bSha}:refs/heads/spry/test/bbb22222`], {
      cwd: repo.path,
    });

    // A's PR is mismatched (base=B, expected=main) so it will be parked; make
    // the park (pr edit) fail so A must be skipped by the push.
    const { gh } = stubGh((call) => {
      if (call.args[0] === "pr" && call.args[1] === "edit") {
        return { stdout: "", stderr: "network down", exitCode: 1 };
      }
      return ghPRMap({
        "spry/test/aaa11111": { number: 10, baseRefName: "spry/test/bbb22222" },
        "spry/test/bbb22222": { number: 11, baseRefName: "main" },
      })(call);
    });
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.message !== "process.exit") throw e;
    } finally {
      trap.restore();
      logs.restore();
    }
    expect(trap.exitCode).toBe(1);
    // A was NOT pushed (park failed → skipped). Asserting the mechanism
    // (own-branch skipped + exit 1) rather than the outcome (PR not merged) is
    // sufficient: a reorder rewrites A's commit to a fresh SHA, so A's stale
    // remote head cannot be made reachable by any other branch's push. See the
    // SHA-reachability note on `parkMismatchedToTrunk` for the full invariant.
    expect(logs.out.join("\n")).not.toContain("pushed spry/test/aaa11111");
    expect(logs.err.join("\n")).toMatch(/Could not park PR #10/);
  });
});

describe("syncCommand --all reorder park", () => {
  test("parks a reordered tracked stack to trunk before pushing", async () => {
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
    // Track this branch so --all picks it up.
    await registerBranch(repo.git, "feature/x", { cwd: repo.path });

    const { gh, calls } = stubGh(
      ghPRMap({
        "spry/test/aaa11111": { number: 10, baseRefName: "spry/test/bbb22222" },
        "spry/test/bbb22222": { number: 11, baseRefName: "main" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path, all: true });
    } finally {
      logs.restore();
    }
    const edits = calls
      .filter((c) => c.args[0] === "pr" && c.args[1] === "edit")
      .map((c) => c.args.join(" "));
    expect(edits).toContain("pr edit 10 --base main"); // park A
    expect(edits).toContain("pr edit 11 --base spry/test/aaa11111"); // re-stack B
    // The park log line is unique to Phase 1 (finishSyncAll's retarget logs "↻ retargeted").
    expect(logs.out.join("\n")).toContain("↻ parked PR #10 → main");
  });
});
