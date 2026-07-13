import { describe, test, expect, afterAll } from "bun:test";
import { landCommand } from "../../src/commands/land.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import { captureLogs, trapExit } from "../lib/capture.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  SpryContext,
  TestRepo,
} from "../lib/index.ts";
import { saveGroupRecord, loadGroupRecords } from "../../src/git/group-titles.ts";
import { loadPRCache } from "../../src/gh/pr-cache.ts";

const repos: TestRepo[] = [];

// afterAll, not afterEach: under --concurrent a per-test cleanup hook would delete
// repos out from under still-running sibling tests.
afterAll(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

async function makeConfiguredRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
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

interface PRStub {
  number: number;
  base?: string;
  state?: string;
  reviewDecision?: string | null;
  /** statusCheckRollup contexts; null = no rollup (checksStatus "none"). */
  rollup?: Array<{
    __typename: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }> | null;
  reviewThreads?: { totalCount: number; nodes: Array<{ isResolved: boolean }> };
}

/**
 * Build a gh stub. Records `pr edit` calls in `editOrder` and exposes a
 * monotonically increasing call sequence so ordering vs the push can be checked.
 */
function ghPrStub(prByBranch: Record<string, PRStub>) {
  return (call: StubGhCall): CommandResult => {
    if (call.args[0] === "pr" && call.args[1] === "edit") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (call.args[0] === "pr" && call.args[1] === "create") {
      return { stdout: "https://github.com/o/r/pull/999\n", stderr: "", exitCode: 0 };
    }
    if (call.args[0] !== "api" || call.args[1] !== "graphql") {
      return { stdout: "", stderr: `unexpected: ${call.args.join(" ")}`, exitCode: 1 };
    }
    const branchArg = call.args.find((a) => a.startsWith("branch="));
    const branch = branchArg?.slice("branch=".length) ?? "";
    const pr = prByBranch[branch];
    if (!pr) {
      return {
        stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
        stderr: "",
        exitCode: 0,
      };
    }
    const rollup =
      pr.rollup === undefined
        ? null
        : pr.rollup === null
          ? null
          : { contexts: { nodes: pr.rollup } };
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: pr.number,
                  url: `https://github.com/o/r/pull/${pr.number}`,
                  state: pr.state ?? "OPEN",
                  title: branch,
                  baseRefName: pr.base ?? "main",
                  reviewDecision: pr.reviewDecision ?? null,
                  reviewThreads: pr.reviewThreads ?? { totalCount: 0, nodes: [] },
                  commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
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

/**
 * Build a stack on `feature` with N published units, pushing each unit's
 * spry branch to the origin so the land flow sees them as existing.
 */
async function publishedStack(
  repo: TestRepo,
  git: ReturnType<typeof createRealGitRunner>,
  units: { id: string; subject: string }[],
): Promise<void> {
  await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
  for (const u of units) {
    await git.run(["commit", "--allow-empty", "-m", `${u.subject}\n\nSpry-Commit-Id: ${u.id}`], {
      cwd: repo.path,
    });
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/test/${u.id}`], { cwd: repo.path });
  }
}

async function runLand(ctx: SpryContext, opts: Parameters<typeof landCommand>[1]): Promise<void> {
  try {
    await landCommand(ctx, opts);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "process.exit") throw e;
  }
}

describe("sp land --through", () => {
  test("--through the top unit lands the whole stack: origin/main advances to the stack tip", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);
    const tip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();

    // A correctly-stacked stack: bottom PR based on trunk, upper PR based on the
    // bottom unit's branch. Land now verifies this and refuses a mis-targeted stack.
    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1, base: "main" },
        "spry/test/bbb22222": { number: 2, base: "spry/test/aaa11111" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "bbb22222" });
    } finally {
      trap.restore();
      logs.restore();
    }

    const originMain = (
      await git.run(["rev-parse", "origin/main"], { cwd: repo.path })
    ).stdout.trim();
    expect(originMain).toBe(tip);
    expect(logs.out.join("\n")).toContain("Landed");
    expect(trap.exitCode).toBeUndefined();
  });

  test("--through the first unit lands only the bottom: origin/main advances to the first tip", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);
    const firstTip = (await git.run(["rev-parse", "HEAD~1"], { cwd: repo.path })).stdout.trim();

    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1 },
        "spry/test/bbb22222": { number: 2 },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "aaa11111" });
    } finally {
      trap.restore();
      logs.restore();
    }

    const originMain = (
      await git.run(["rev-parse", "origin/main"], { cwd: repo.path })
    ).stdout.trim();
    expect(originMain).toBe(firstTip);
  });

  test("makes no `gh pr edit` calls: PRs keep their stacked bases, trunk still advances", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);
    const tip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();

    // The upper PR (#2) is stacked on the lower unit's branch. Under the old
    // flow land would retarget it to `main` before pushing. It must not anymore.
    const { gh, calls } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1, base: "main" },
        "spry/test/bbb22222": { number: 2, base: "spry/test/aaa11111" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "bbb22222" });
    } finally {
      trap.restore();
      logs.restore();
    }

    // No PR was retargeted — land emits zero `gh pr edit` calls.
    const editCalls = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(editCalls).toHaveLength(0);
    // MERGED-by-reachability still holds: origin/main advanced to the tip.
    const originMain = (
      await git.run(["rev-parse", "origin/main"], { cwd: repo.path })
    ).stdout.trim();
    expect(originMain).toBe(tip);
    expect(trap.exitCode).toBeUndefined();
  });

  test("land fails when an in-scope PR is mis-targeted (no ff-push)", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "Add login" },
      { id: "bbb22222", subject: "Add logout" },
    ]);
    await git.run(["fetch", "origin"], { cwd: repo.path });
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    // Both PRs based on "main": unit bbb22222 should be based on
    // spry/test/aaa11111, so it is mis-targeted and trips landBlockers.
    const passing = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }];
    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1, base: "main", rollup: passing },
        "spry/test/bbb22222": { number: 2, base: "main", rollup: passing },
      }),
    );
    const ctx = makeCtx(repo, gh);

    const { err, restore } = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { through: "bbb22222", cwd: repo.path });
    } finally {
      trap.restore();
      restore();
    }

    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(before); // did NOT land
    expect(err.join("\n")).toMatch(/sp sync/);
    expect(err.join("\n")).toMatch(/base/i);
  });

  test("unknown --through id exits 1 with a resolution error and lands nothing", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    const { gh } = stubGh(ghPrStub({ "spry/test/aaa11111": { number: 1 } }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "zzz99999" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(before);
  });

  test("a group id and a member commit's id resolve to the same scope", async () => {
    // Each landing path runs in a fresh repo so origin/main starts clean.
    // `through` is computed from the repo (group id vs. a member commit hash).
    async function landGroupedWith(
      pickThrough: (info: { memberHash: string }) => string,
    ): Promise<{ tip: string; originMain: string }> {
      const repo = await makeConfiguredRepo();
      const git = createRealGitRunner();
      await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
      await git.run(["commit", "--allow-empty", "-m", "First\n\nSpry-Commit-Id: aaa11111"], {
        cwd: repo.path,
      });
      const memberHash = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
      await git.run(["commit", "--allow-empty", "-m", "Second\n\nSpry-Commit-Id: bbb22222"], {
        cwd: repo.path,
      });
      // Group the two commits under grp00001 — a single PR unit.
      await saveGroupRecord(
        git,
        "grp00001",
        { title: "Auth Feature", members: ["aaa11111", "bbb22222"] },
        { cwd: repo.path },
      );
      const tip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
      await git.run(["push", "origin", `${tip}:refs/heads/spry/test/grp00001`], { cwd: repo.path });

      const { gh } = stubGh(ghPrStub({ "spry/test/grp00001": { number: 1 } }));
      const ctx = makeCtx(repo, gh);
      const logs = await captureLogs();
      const trap = trapExit();
      try {
        await runLand(ctx, { cwd: repo.path, through: pickThrough({ memberHash }) });
      } finally {
        trap.restore();
        logs.restore();
      }
      const originMain = (
        await git.run(["rev-parse", "origin/main"], { cwd: repo.path })
      ).stdout.trim();
      return { tip, originMain };
    }

    // Land via the group id and via a member commit hash — both land the group.
    const viaGroup = await landGroupedWith(() => "grp00001");
    expect(viaGroup.originMain).toBe(viaGroup.tip);

    const viaMember = await landGroupedWith(({ memberHash }) => memberHash.slice(0, 9));
    expect(viaMember.originMain).toBe(viaMember.tip);
  });

  test("behind trunk: ff push rejected → run sp rebase, exit 1, nothing landed", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);

    // Advance origin/main past the stack base with an unrelated commit so the
    // ff push of the stack tip is non-fast-forward.
    await git.run(["checkout", "main"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "trunk moved on"], { cwd: repo.path });
    await git.run(["push", "origin", "main"], { cwd: repo.path });
    const advanced = (
      await git.run(["rev-parse", "origin/main"], { cwd: repo.path })
    ).stdout.trim();
    await git.run(["checkout", "feature"], { cwd: repo.path });

    const { gh } = stubGh(ghPrStub({ "spry/test/aaa11111": { number: 1 } }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "aaa11111" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    expect(logs.err.join("\n")).toMatch(/sp rebase/);
    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(advanced);
  });
});

describe("sp land readiness", () => {
  const failingRollup = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }];
  const pendingRollup = [{ __typename: "CheckRun", status: "IN_PROGRESS" }];

  const cases: Array<[string, PRStub, RegExp]> = [
    ["failing checks", { number: 1, rollup: failingRollup }, /checks are failing/i],
    ["pending checks", { number: 1, rollup: pendingRollup }, /checks are still running/i],
    [
      "changes requested",
      { number: 1, reviewDecision: "CHANGES_REQUESTED" },
      /changes have been requested/i,
    ],
    ["review required", { number: 1, reviewDecision: "REVIEW_REQUIRED" }, /review is required/i],
  ];

  for (const [name, prState, reasonText] of cases) {
    test(`aborts on ${name} and lands nothing`, async () => {
      const repo = await makeConfiguredRepo();
      const git = createRealGitRunner();
      await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
      const before = (
        await git.run(["rev-parse", "origin/main"], { cwd: repo.path })
      ).stdout.trim();

      const { gh } = stubGh(ghPrStub({ "spry/test/aaa11111": prState }));
      const ctx = makeCtx(repo, gh);
      const logs = await captureLogs();
      const trap = trapExit();
      try {
        await runLand(ctx, { cwd: repo.path, through: "aaa11111" });
      } finally {
        trap.restore();
        logs.restore();
      }

      expect(trap.exitCode).toBe(1);
      expect(logs.err.join("\n")).toMatch(reasonText);
      const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
      expect(after).toBe(before);
    });
  }

  test("a scope unit with no open PR errors and points to sp sync", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    // gh returns no PR (nodes: []) for the unit's branch.
    const { gh } = stubGh(ghPrStub({}));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "aaa11111" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    // landBlockers reports "no open PR" and the unified guidance points at `sp sync`
    // (the read-write split moved publishing/retargeting entirely into sync).
    expect(logs.err.join("\n")).toMatch(/no open PR/);
    expect(logs.err.join("\n")).toMatch(/sp sync/);
    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(before);
  });
});

describe("sp land no-arg picker", () => {
  test("picker selection drives the same through-path", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);
    const tip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();

    // Correctly-stacked bases so the whole-stack land passes the readiness gate.
    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1, base: "main" },
        "spry/test/bbb22222": { number: 2, base: "spry/test/aaa11111" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, {
        cwd: repo.path,
        pickThrough: async (units) => units.at(-1)?.id ?? null,
      });
    } finally {
      trap.restore();
      logs.restore();
    }

    const originMain = (
      await git.run(["rev-parse", "origin/main"], { cwd: repo.path })
    ).stdout.trim();
    expect(originMain).toBe(tip);
    expect(logs.out.join("\n")).toContain("Landed");
    expect(trap.exitCode).toBeUndefined();
  });

  test("cancel (picker returns null) lands nothing", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    const { gh } = stubGh(ghPrStub({ "spry/test/aaa11111": { number: 1 } }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, pickThrough: async () => null });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(before);
    expect(logs.out.join("\n")).toMatch(/cancelled/i);
  });
});

describe("sp land unresolved review threads", () => {
  const unresolved: PRStub = {
    number: 1,
    reviewThreads: { totalCount: 1, nodes: [{ isResolved: false }] },
  };

  test("decline → nothing landed", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    const { gh } = stubGh(ghPrStub({ "spry/test/aaa11111": unresolved }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "aaa11111", confirm: async () => false });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(before);
    expect(logs.out.join("\n")).toMatch(/cancelled/i);
  });

  test("accept → lands", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const tip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();

    const { gh } = stubGh(ghPrStub({ "spry/test/aaa11111": unresolved }));
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    let prompted = false;
    try {
      await runLand(ctx, {
        cwd: repo.path,
        through: "aaa11111",
        confirm: async () => {
          prompted = true;
          return true;
        },
      });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(prompted).toBe(true);
    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(tip);
    expect(logs.out.join("\n")).toContain("Landed");
  });
});

/**
 * Build a stack of groups on `feature`. Each group's members are committed in
 * order, the group record is saved, and the group's tip branch is pushed to the
 * origin (mirrors {@link publishedStack} but for group units).
 */
async function publishedGroupedStack(
  repo: TestRepo,
  git: ReturnType<typeof createRealGitRunner>,
  groups: { id: string; members: { id: string; subject: string }[] }[],
): Promise<void> {
  await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
  for (const g of groups) {
    for (const m of g.members) {
      await git.run(["commit", "--allow-empty", "-m", `${m.subject}\n\nSpry-Commit-Id: ${m.id}`], {
        cwd: repo.path,
      });
    }
    await saveGroupRecord(
      git,
      g.id,
      { title: g.id, members: g.members.map((m) => m.id) },
      { cwd: repo.path },
    );
    const tip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${tip}:refs/heads/spry/test/${g.id}`], { cwd: repo.path });
  }
}

describe("sp land cleanup tail", () => {
  test("drops the landed units' PR-cache entries (whole stack empties the cache without erroring)", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);

    // Correctly-stacked bases so the whole-stack land passes the readiness gate.
    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1, base: "main" },
        "spry/test/bbb22222": { number: 2, base: "spry/test/aaa11111" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "bbb22222" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    // Local cache ref is gone (savePRCache deletes the ref when empty).
    const localCache = await loadPRCache(ctx.git, { cwd: repo.path });
    expect(Object.keys(localCache)).toEqual([]);
    // The empty cache is propagated to the remote as a ref deletion.
    const remoteRef = (
      await git.run(["ls-remote", "origin", "refs/spry/prs"], { cwd: repo.path })
    ).stdout.trim();
    expect(remoteRef).toBe("");
  });

  test("a partial land drops only the landed units' cache entries and keeps the rest", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);

    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1 },
        "spry/test/bbb22222": { number: 2 },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "aaa11111" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    const localCache = await loadPRCache(ctx.git, { cwd: repo.path });
    expect(Object.keys(localCache)).toEqual(["bbb22222"]);
  });

  test("scrubs landed group records; a partial land keeps out-of-scope groups", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedGroupedStack(repo, git, [
      {
        id: "grp00001",
        members: [
          { id: "aaa11111", subject: "a" },
          { id: "bbb22222", subject: "b" },
        ],
      },
      {
        id: "grp00002",
        members: [
          { id: "ccc33333", subject: "c" },
          { id: "ddd44444", subject: "d" },
        ],
      },
    ]);

    const { gh } = stubGh(
      ghPrStub({
        "spry/test/grp00001": { number: 1 },
        "spry/test/grp00002": { number: 2 },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "grp00001" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    const records = await loadGroupRecords(ctx.git, { cwd: repo.path });
    expect(Object.keys(records)).toEqual(["grp00002"]);
  });

  test("a whole-stack group land empties the group records without erroring", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedGroupedStack(repo, git, [
      {
        id: "grp00001",
        members: [
          { id: "aaa11111", subject: "a" },
          { id: "bbb22222", subject: "b" },
        ],
      },
      {
        id: "grp00002",
        members: [
          { id: "ccc33333", subject: "c" },
          { id: "ddd44444", subject: "d" },
        ],
      },
    ]);

    // Whole-stack group land: the upper group's PR must be based on the lower
    // group's branch for the readiness gate to accept it.
    const { gh } = stubGh(
      ghPrStub({
        "spry/test/grp00001": { number: 1, base: "main" },
        "spry/test/grp00002": { number: 2, base: "spry/test/grp00001" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      // Land through the TOP group → the whole stack lands.
      await runLand(ctx, { cwd: repo.path, through: "grp00002" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    expect(logs.out.join("\n")).toContain("Landed");
    // saveAllGroupRecords({}) wrote an empty-tree commit and kept the ref.
    const records = await loadGroupRecords(ctx.git, { cwd: repo.path });
    expect(records).toEqual({});
  });

  test("with autoDeleteOnLand true, the spent remote branches are deleted", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await git.run(["config", "spry.autoDeleteOnLand", "true"], { cwd: repo.path });
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);

    // Sanity: both spry branches exist on the origin before landing.
    const before = (
      await git.run(["ls-remote", "--heads", "origin", "spry/test/*"], { cwd: repo.path })
    ).stdout.trim();
    expect(before).toContain("spry/test/aaa11111");
    expect(before).toContain("spry/test/bbb22222");

    // Correctly-stacked bases so the whole-stack land passes the readiness gate.
    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1, base: "main" },
        "spry/test/bbb22222": { number: 2, base: "spry/test/aaa11111" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "bbb22222" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    const after = (
      await git.run(["ls-remote", "--heads", "origin", "spry/test/*"], { cwd: repo.path })
    ).stdout.trim();
    expect(after).toBe("");
    expect(logs.out.join("\n")).toContain("Deleted spry/test/aaa11111");
    expect(logs.out.join("\n")).toContain("Deleted spry/test/bbb22222");
  });

  test("with autoDeleteOnLand false (default), the spent remote branches are NOT deleted", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);

    // Correctly-stacked bases so the whole-stack land passes the readiness gate.
    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1, base: "main" },
        "spry/test/bbb22222": { number: 2, base: "spry/test/aaa11111" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "bbb22222" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBeUndefined();
    const after = (
      await git.run(["ls-remote", "--heads", "origin", "spry/test/*"], { cwd: repo.path })
    ).stdout.trim();
    expect(after).toContain("spry/test/aaa11111");
    expect(after).toContain("spry/test/bbb22222");
  });

  test("land refuses a unit whose remote branch is gone (caught by readiness, not the cleanup tail)", async () => {
    // Under the read-write split, land verifies every in-scope unit is pushed
    // (analyzeStack reads `origin/<branch>`) BEFORE the ff-push. A branch missing
    // from the remote is caught by the readiness gate, so land aborts and never
    // reaches the cleanup tail. The cleanup tail's own already-gone tolerance
    // (the `isAlreadyGone` predicate) is unit-tested directly in
    // tests/gh/push.test.ts.
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await git.run(["config", "spry.autoDeleteOnLand", "true"], { cwd: repo.path });
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    // Delete the bottom unit's remote branch before landing: it is now unpushed.
    await git.run(["push", "origin", "--delete", "spry/test/aaa11111"], { cwd: repo.path });

    // Correctly-stacked bases — the block must come from the missing branch, not targeting.
    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1, base: "main" },
        "spry/test/bbb22222": { number: 2, base: "spry/test/aaa11111" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = await captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "bbb22222" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    // Nothing landed.
    const after = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
    expect(after).toBe(before);
    // The error names the unpushed problem and points at `sp sync`.
    expect(logs.err.join("\n")).toMatch(/not pushed|stale/i);
    expect(logs.err.join("\n")).toMatch(/sp sync/);
  });
});
