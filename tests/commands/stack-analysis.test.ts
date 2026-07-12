import { describe, test, expect, afterEach } from "bun:test";
import { analyzeStack, missingIdHashes } from "../../src/commands/stack-analysis.ts";
import type { StackAnalysis } from "../../src/commands/stack-analysis.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";
import type { SpryConfig } from "../../src/git/index.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import type { CommitWithTrailers } from "../../src/parse/index.ts";
import type { PRCache } from "../../src/gh/pr-cache.ts";
import type { GitRunner } from "../../src/lib/context.ts";

const repos: TestRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

function cfg(): SpryConfig {
  return {
    trunk: "main",
    remote: "origin",
    branchPrefix: "spry/test",
    repo: undefined,
    owner: undefined,
    autoDeleteOnLand: false,
  } as SpryConfig;
}

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  return repo;
}

describe("analyzeStack", () => {
  test("empty stack → empty analysis", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    const ctx: { git: GitRunner } = {
      git: { run: (args, opts) => git.run(args, { ...opts, cwd: repo.path }) },
    };
    const analysis: StackAnalysis = await analyzeStack(ctx, {
      units: [] as PRUnit[],
      commits: [],
      prCache: {} as PRCache,
      config: cfg(),
    });
    expect(analysis.units).toEqual([]);
  });

  test("missingIdHashes returns hashes of commits lacking Spry-Commit-Id", () => {
    const commits: CommitWithTrailers[] = [
      { hash: "aaa", subject: "has id", body: "", trailers: { "Spry-Commit-Id": "id1" } },
      { hash: "bbb", subject: "no id", body: "", trailers: {} },
      { hash: "ccc", subject: "also no id", body: "body", trailers: {} },
    ];
    expect(missingIdHashes(commits)).toEqual(["bbb", "ccc"]);
  });

  function makeCtx(
    repo: TestRepo,
    git: ReturnType<typeof createRealGitRunner>,
  ): { git: GitRunner } {
    return {
      git: { run: (args, opts) => git.run(args, { ...opts, cwd: repo.path }) },
    };
  }

  // Commits an empty commit; if push && id, publishes it to origin/<prefix>/<id> and fetches so the remote-tracking ref exists locally.
  async function commitAndPush(
    git: ReturnType<typeof createRealGitRunner>,
    repo: TestRepo,
    subject: string,
    id: string | null,
    push: boolean,
  ): Promise<string> {
    const msg = id ? `${subject}\n\nSpry-Commit-Id: ${id}` : subject;
    await git.run(["commit", "--allow-empty", "-m", msg], { cwd: repo.path });
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    if (push && id) {
      await git.run(["push", "origin", `${head}:refs/heads/spry/test/${id}`], { cwd: repo.path });
      await git.run(["fetch", "origin"], { cwd: repo.path });
    }
    return head;
  }

  function unit(id: string, tip: string): PRUnit {
    return {
      type: "single",
      id,
      title: undefined,
      commitIds: [id],
      commits: [tip],
      subjects: [id],
    };
  }

  test("pushed + correctly-targeted bottom unit → no flags", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    const ctx = makeCtx(repo, git);
    await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
    const tip = await commitAndPush(git, repo, "Add login", "aaa11111", true);

    const u = unit("aaa11111", tip);
    const prCache: PRCache = {
      aaa11111: {
        number: 1,
        url: "u",
        state: "OPEN",
        title: "T",
        baseRefName: "main",
        checksStatus: "passing",
        reviewDecision: "none",
        reviewThreads: { resolved: 0, total: 0 },
        branch: "spry/test/aaa11111",
        cachedAt: "now",
      },
    };
    const analysis = await analyzeStack(ctx, {
      units: [u],
      commits: [
        { hash: tip, subject: "Add login", body: "", trailers: { "Spry-Commit-Id": "aaa11111" } },
      ],
      prCache,
      config: cfg(),
    });
    const a = analysis.units[0]!;
    expect(a.missingId).toBe(false);
    expect(a.unpushed).toBe(false);
    expect(a.misTargeted).toBe(false);
    expect(a.expectedBase).toBe("main");
  });

  test("unit with no origin branch → unpushed", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    const ctx = makeCtx(repo, git);
    await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
    const tip = await commitAndPush(git, repo, "Add login", "aaa11111", false); // not pushed
    const analysis = await analyzeStack(ctx, {
      units: [unit("aaa11111", tip)],
      commits: [{ hash: tip, subject: "x", body: "", trailers: { "Spry-Commit-Id": "aaa11111" } }],
      prCache: {},
      config: cfg(),
    });
    expect(analysis.units[0]!.unpushed).toBe(true);
  });

  test("stale origin tip (amended after push) → unpushed", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    const ctx = makeCtx(repo, git);
    await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
    await commitAndPush(git, repo, "Add login", "aaa11111", true);
    await git.run(
      ["commit", "--allow-empty", "--amend", "-m", "Add login v2\n\nSpry-Commit-Id: aaa11111"],
      { cwd: repo.path },
    );
    const newTip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    const analysis = await analyzeStack(ctx, {
      units: [unit("aaa11111", newTip)],
      commits: [
        { hash: newTip, subject: "x", body: "", trailers: { "Spry-Commit-Id": "aaa11111" } },
      ],
      prCache: {},
      config: cfg(),
    });
    expect(analysis.units[0]!.unpushed).toBe(true);
  });

  test("commit without Spry-Commit-Id → missingId", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    const ctx = makeCtx(repo, git);
    await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
    const tip = await commitAndPush(git, repo, "no id", null, false);
    const analysis = await analyzeStack(ctx, {
      units: [unit("aaa11111", tip)],
      commits: [{ hash: tip, subject: "no id", body: "", trailers: {} }],
      prCache: {},
      config: cfg(),
    });
    expect(analysis.units[0]!.missingId).toBe(true);
  });

  test("upper unit PR based on main instead of prev branch → misTargeted", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    const ctx = makeCtx(repo, git);
    await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
    const t1 = await commitAndPush(git, repo, "Add login", "aaa11111", true);
    const t2 = await commitAndPush(git, repo, "Add logout", "bbb22222", true);
    const units = [unit("aaa11111", t1), unit("bbb22222", t2)];
    const prCache: PRCache = {
      bbb22222: {
        number: 2,
        url: "u",
        state: "OPEN",
        title: "T",
        baseRefName: "main",
        checksStatus: "passing",
        reviewDecision: "none",
        reviewThreads: { resolved: 0, total: 0 },
        branch: "spry/test/bbb22222",
        cachedAt: "now",
      },
    };
    const analysis = await analyzeStack(ctx, {
      units,
      commits: [
        { hash: t1, subject: "x", body: "", trailers: { "Spry-Commit-Id": "aaa11111" } },
        { hash: t2, subject: "y", body: "", trailers: { "Spry-Commit-Id": "bbb22222" } },
      ],
      prCache,
      config: cfg(),
    });
    const upper = analysis.units.find((u) => u.unit.id === "bbb22222")!;
    expect(upper.misTargeted).toBe(true);
    expect(upper.expectedBase).toBe("spry/test/aaa11111");
    const bottom = analysis.units.find((u) => u.unit.id === "aaa11111")!;
    expect(bottom.misTargeted).toBe(false);
  });
});
