import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import { docTest, createRepo, createRealGitRunner, createTerminalDriver } from "../lib/index.ts";
import type { GhClient, CommandResult, CommandOptions, SpryContext } from "../lib/index.ts";
import { landCommand } from "../../src/commands/land.ts";

const harnessPath = join(import.meta.dir, "../fixtures/land-tui-harness.ts");

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

/**
 * Build a 2-unit stack on `feature/x`, publishing each unit's spry branch to the
 * origin so the land flow sees them as existing.
 */
async function publish2UnitStack(repo: { path: string }): Promise<void> {
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

  await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
  for (const [subject, id] of [
    ["Add login", "aaa11111"],
    ["Add logout", "bbb22222"],
  ] as const) {
    await git.run(["commit", "--allow-empty", "-m", `${subject}\n\nSpry-Commit-Id: ${id}`], {
      cwd: repo.path,
    });
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/dondenton/${id}`], {
      cwd: repo.path,
    });
  }
}

/** gh stub: each branch has an OPEN PR based on main, no checks/threads; `pr edit` succeeds. */
function landGhStub(prByBranch: Record<string, number>): GhClient {
  return {
    async run(args: string[], _opts?: CommandOptions): Promise<CommandResult> {
      if (args[0] === "pr" && args[1] === "edit") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        const branchArg = args.find((a) => a.startsWith("branch="));
        const branch = branchArg?.slice("branch=".length) ?? "";
        const number = prByBranch[branch];
        if (number === undefined) {
          return {
            stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  nodes: [
                    {
                      number,
                      url: `https://github.com/owner/repo/pull/${number}`,
                      state: "OPEN",
                      title: branch,
                      baseRefName: "main",
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
      }
      return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, exitCode: 1 };
    },
  };
}

describe("sp land docs", () => {
  docTest("Landing through a commit", { section: "commands/land", order: 10 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();
    await publish2UnitStack(repo);

    const tip = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();

    doc.prose(
      "`sp land --through <id>` lands the stack from the bottom **through** the unit identified by `<id>` (a group ID, unit-ID prefix, or commit-hash prefix). Spry retargets every in-scope PR onto trunk and then fast-forwards trunk to that unit's tip — it never uses the GitHub merge API. Retargeting first is what makes GitHub mark each PR `MERGED` rather than `CLOSED`. `sp land` never deletes branches (that is `sp clean`'s job):",
    );

    const gh = landGhStub({
      "spry/dondenton/aaa11111": 1,
      "spry/dondenton/bbb22222": 2,
    });
    const ctx: SpryContext = {
      git: { run: (a, opts) => git.run(a, { ...opts, cwd: opts?.cwd ?? repo.path }) },
      gh,
    };

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await landCommand(ctx, { cwd: repo.path, through: "bbb22222" });
    } finally {
      console.log = origLog;
    }

    doc.command("sp land --through bbb22222");
    doc.output(lines.join("\n") + "\n");

    const { expect } = await import("bun:test");
    expect(lines.join("\n")).toContain("Landed");
    const originMain = (
      await git.run(["rev-parse", "origin/main"], { cwd: repo.path })
    ).stdout.trim();
    expect(originMain).toBe(tip);
  });

  docTest(
    "Picking the land point interactively",
    { section: "commands/land", order: 20, timeout: 40000 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();
      await publish2UnitStack(repo);

      doc.prose(
        "Run `sp land` with no arguments to choose the land point interactively. Spry shows a single-select menu of the stack's units (bottom→top) — use ↑/↓ to move, Enter to select. The chosen unit becomes the `--through` target:",
      );
      doc.command("sp land");

      // Spawn the harness in a real PTY — the TUI runs for real, gh is stubbed in-process.
      const driver = await createTerminalDriver("bun", [harnessPath, repo.path], {
        cols: 80,
        rows: 24,
      });
      repos.push({ cleanup: () => driver.close() });

      // Wait for the picker to render (labels are "<id>  <subject>").
      await driver.waitForText("Add login", { timeout: 15000 });

      // Capture the menu before any selection.
      doc.screen(driver.capture());

      // Select the cursor row (the bottom unit) and land it.
      driver.press("Enter");

      // Wait for the land to complete.
      await driver.waitForText("Landed", { timeout: 15000 });

      const { expect } = await import("bun:test");
      const snap = driver.capture();
      expect(snap.text).toContain("Landed");
    },
  );
});
