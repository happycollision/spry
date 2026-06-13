import { describe, test, expect, afterEach } from "bun:test";
import { landCommand } from "../../src/commands/land.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  SpryContext,
  TestRepo,
} from "../lib/index.ts";
import { saveGroupRecord } from "../../src/git/group-titles.ts";

const repos: TestRepo[] = [];

afterEach(async () => {
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

    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1 },
        "spry/test/bbb22222": { number: 2 },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
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
    const logs = captureLogs();
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

  test("retargets every off-trunk scope PR to trunk BEFORE pushing", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [
      { id: "aaa11111", subject: "first" },
      { id: "bbb22222", subject: "second" },
    ]);

    // Track the order of pr-edit calls relative to the ff push to trunk.
    // The land flow only retargets PRs whose base isn't already trunk; the
    // upper PR (#2) is stacked on the lower unit's branch, so it must be
    // retargeted to trunk before origin/main advances.
    let mainAdvanced = false;
    const editsBeforePush: string[] = [];
    const editsAfterPush: string[] = [];
    const handler = ghPrStub({
      "spry/test/aaa11111": { number: 1, base: "main" },
      "spry/test/bbb22222": { number: 2, base: "spry/test/aaa11111" },
    });
    const realGit = createRealGitRunner();
    const ctx: SpryContext = {
      git: {
        run: async (args, opts) => {
          const res = await realGit.run(args, { ...opts, cwd: opts?.cwd ?? repo.path });
          // Detect the ff push to trunk (refspec ends with refs/heads/main).
          if (
            args[0] === "push" &&
            args.some((a) => a.endsWith(":refs/heads/main")) &&
            res.exitCode === 0
          ) {
            mainAdvanced = true;
          }
          return res;
        },
      },
      gh: {
        async run(args, options) {
          if (args[0] === "pr" && args[1] === "edit") {
            (mainAdvanced ? editsAfterPush : editsBeforePush).push(args[2] ?? "");
          }
          return handler({ args: [...args], stdin: options?.stdin });
        },
      },
    };
    const logs = captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "bbb22222" });
    } finally {
      trap.restore();
      logs.restore();
    }

    // The stacked PR was retargeted to trunk before the push; no retarget
    // happened after origin/main advanced.
    expect(editsBeforePush).toContain("2");
    expect(editsAfterPush).toHaveLength(0);
    expect(trap.exitCode).toBeUndefined();
  });

  test("unknown --through id exits 1 with a resolution error and lands nothing", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    const { gh } = stubGh(ghPrStub({ "spry/test/aaa11111": { number: 1 } }));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
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
      const logs = captureLogs();
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
    const logs = captureLogs();
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
      const logs = captureLogs();
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

  test("a scope unit with no open PR errors and points to sp sync --open", async () => {
    const repo = await makeConfiguredRepo();
    const git = createRealGitRunner();
    await publishedStack(repo, git, [{ id: "aaa11111", subject: "first" }]);
    const before = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();

    // gh returns no PR (nodes: []) for the unit's branch.
    const { gh } = stubGh(ghPrStub({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    const trap = trapExit();
    try {
      await runLand(ctx, { cwd: repo.path, through: "aaa11111" });
    } finally {
      trap.restore();
      logs.restore();
    }

    expect(trap.exitCode).toBe(1);
    expect(logs.err.join("\n")).toMatch(/sp sync --open/);
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

    const { gh } = stubGh(
      ghPrStub({
        "spry/test/aaa11111": { number: 1 },
        "spry/test/bbb22222": { number: 2 },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
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
    const logs = captureLogs();
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
    const logs = captureLogs();
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
    const logs = captureLogs();
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
