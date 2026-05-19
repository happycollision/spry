import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import { docTest, createRunner, createRepo, createRealGitRunner } from "../lib/index.ts";
import type { GhClient, CommandResult, CommandOptions, SpryContext } from "../lib/index.ts";
import { syncCommand } from "../../src/commands/sync.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const runSp = createRunner(cliPath);

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

describe("sp sync docs", () => {
  docTest("Pushing existing branches", { section: "commands/sync", order: 10 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Pre-publish the branch
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/dondenton/aaa11111`], {
      cwd: repo.path,
    });

    doc.prose(
      "Run `sp sync` to push your stack's commits to their already-published remote branches. Spry derives each branch as `<spry.branchPrefix>/<unit-id>` and only pushes branches that already exist on the remote — it never creates new ones. Use `sp sync --open` to publish for the first time.",
    );

    // Canonicalize the gh-unavailable hint so fragments stay deterministic
    doc.scrub(/PR retargeting unavailable: [^\n]+/, "PR retargeting unavailable: <hint>");

    const { command, result } = await runSp(repo.path, "sync");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pushed spry/dondenton/aaa11111");
  });

  docTest("Opening a new PR", { section: "commands/sync", order: 20 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    doc.prose(
      "Use `sp sync --open <id>` to publish a commit for the first time — Spry pushes the branch and opens a PR on GitHub targeting trunk (or the previous unit's branch for a stacked PR):",
    );

    const gh: GhClient = {
      async run(args: string[], _opts?: CommandOptions): Promise<CommandResult> {
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/owner/repo/pull/42\n", stderr: "", exitCode: 0 };
        }
        return {
          stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const realGit = createRealGitRunner();
    const ctx: SpryContext = {
      git: { run: (args, opts) => realGit.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }) },
      gh,
    };

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa11111" });
    } finally {
      console.log = origLog;
    }

    doc.command("sp sync --open aaa11111");
    doc.output(lines.join("\n") + "\n");

    const { expect } = await import("bun:test");
    expect(lines.join("\n")).toContain("Created PR #42");
    expect(lines.join("\n")).toContain("Sync complete");
  });

  docTest("Auto-injecting commit IDs", { section: "commands/sync", order: 40 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    // No Spry-Commit-Id trailer — sync will inject one automatically
    await git.run(["commit", "--allow-empty", "-m", "Add login"], { cwd: repo.path });

    doc.prose(
      "If a commit lacks a `Spry-Commit-Id` trailer, `sp sync` rewrites it with one before doing anything else. This happens automatically on first use:",
    );

    // No remote branches exist, so no gh calls are made — use the CLI runner directly
    const { command, result } = await runSp(repo.path, "sync");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Injected 1 commit ID");
    expect(result.stdout).toContain("Sync complete");
  });

  docTest("Retargeting stacked PRs", { section: "commands/sync", order: 50 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });

    // Pre-publish both branches
    const aSha = (await git.run(["rev-parse", "HEAD~1"], { cwd: repo.path })).stdout.trim();
    const bSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${aSha}:refs/heads/spry/dondenton/aaa11111`], {
      cwd: repo.path,
    });
    await git.run(["push", "origin", `${bSha}:refs/heads/spry/dondenton/bbb22222`], {
      cwd: repo.path,
    });

    doc.prose(
      "After pushing, `sp sync` checks each open PR's base and retargets any that are wrong. This keeps your stacked PRs pointing at each other rather than trunk as the stack evolves:",
    );

    // PR for bbb22222 has wrong base (main instead of spry/dondenton/aaa11111)
    const gh: GhClient = {
      async run(args: string[], _opts?: CommandOptions): Promise<CommandResult> {
        if (args[0] === "api" && args[1] === "graphql") {
          const branchArg = args.find((a) => a.startsWith("branch="));
          const branch = branchArg?.slice("branch=".length) ?? "";
          const prByBranch: Record<string, { number: number; baseRefName: string }> = {
            "spry/dondenton/aaa11111": { number: 10, baseRefName: "main" },
            "spry/dondenton/bbb22222": { number: 11, baseRefName: "main" },
          };
          const pr = prByBranch[branch];
          if (!pr) {
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
                        number: pr.number,
                        url: `https://github.com/owner/repo/pull/${pr.number}`,
                        state: "OPEN",
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
        }
        if (args[0] === "pr" && args[1] === "edit") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, exitCode: 1 };
      },
    };

    const realGit = createRealGitRunner();
    const ctx: SpryContext = {
      git: { run: (a, opts) => realGit.run(a, { ...opts, cwd: opts?.cwd ?? repo.path }) },
      gh,
    };

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      console.log = origLog;
    }

    doc.command("sp sync");
    doc.output(lines.join("\n") + "\n");

    const { expect } = await import("bun:test");
    expect(lines.join("\n")).toContain("pushed spry/dondenton/aaa11111");
    expect(lines.join("\n")).toContain("pushed spry/dondenton/bbb22222");
    expect(lines.join("\n")).toMatch(/retargeted PR #11/);
    expect(lines.join("\n")).toContain("Sync complete");
  });

  docTest("Empty stack", { section: "commands/sync", order: 30 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    doc.prose("On a branch with no commits ahead of trunk, `sp sync` no-ops:");

    const { command, result } = await runSp(repo.path, "sync");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });
});
