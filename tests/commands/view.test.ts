import { describe, test, expect } from "bun:test";
import { createRealGitRunner, repoManager } from "../lib/index.ts";
import { viewCommand } from "../../src/commands/view.ts";
import type { SpryContext } from "../../src/lib/context.ts";

const repos = repoManager();

// Helper to capture stdout/stderr from viewCommand
async function captureView(
  ctx: SpryContext,
  opts: { noFetch?: boolean } = {},
): Promise<{ stdout: string; exitCode: number }> {
  const chunks: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  let exitCode = 0;
  console.log = (...args: unknown[]) => chunks.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => chunks.push(args.map(String).join(" "));
  // @ts-expect-error — mock process.exit to throw instead
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error("EXIT");
  };

  try {
    await viewCommand(ctx, opts);
  } catch (e) {
    if (!(e instanceof Error && e.message === "EXIT")) throw e;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { stdout: chunks.join("\n"), exitCode };
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Helper to create a cwd-bound context
function createCtx(repoPath: string): SpryContext {
  const git = createRealGitRunner();
  return {
    git: {
      run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repoPath }),
    },
    gh: { run: async () => ({ stdout: "", stderr: "", exitCode: 1 }) },
  };
}

describe("viewCommand", () => {
  test("empty stack on trunk branch", async () => {
    const repo = await repos.create();

    // Configure spry
    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

    const ctx = createCtx(repo.path);
    const { stdout, exitCode } = await captureView(ctx);

    expect(exitCode).toBe(0);
    expect(stripAnsi(stdout)).toContain("No commits ahead of origin/main");
  });

  test("stack with single commit with trailer", async () => {
    const repo = await repos.create();

    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

    // Create a feature branch and commit with Spry-Commit-Id trailer
    await git.run(["checkout", "-b", "feature/login"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    const ctx = createCtx(repo.path);
    const { stdout, exitCode } = await captureView(ctx);
    const plain = stripAnsi(stdout);

    expect(exitCode).toBe(0);
    expect(plain).toContain("Stack:");
    expect(plain).toContain("1 commit");
    expect(plain).toContain("Add login page");
    expect(plain).toContain("aaa11111");
  });

  test("stack with commit without trailer", async () => {
    const repo = await repos.create();

    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

    // Create a feature branch with a plain commit (no trailer)
    await git.run(["checkout", "-b", "feature/plain"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Fix typo in README"], { cwd: repo.path });

    const ctx = createCtx(repo.path);
    const { stdout, exitCode } = await captureView(ctx);
    const plain = stripAnsi(stdout);

    expect(exitCode).toBe(0);
    expect(plain).toContain("Stack:");
    expect(plain).toContain("1 commit");
    expect(plain).toContain("Fix typo in README");
    expect(plain).toContain("(no ID)");
  });

  test("stack with multiple commits", async () => {
    const repo = await repos.create();

    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

    await git.run(["checkout", "-b", "feature/multi"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "First commit\n\nSpry-Commit-Id: bbb22222"], {
      cwd: repo.path,
    });
    await git.run(["commit", "--allow-empty", "-m", "Second commit\n\nSpry-Commit-Id: ccc33333"], {
      cwd: repo.path,
    });

    const ctx = createCtx(repo.path);
    const { stdout, exitCode } = await captureView(ctx);
    const plain = stripAnsi(stdout);

    expect(exitCode).toBe(0);
    expect(plain).toContain("2 commits");
    expect(plain).toContain("First commit");
    expect(plain).toContain("bbb22222");
    expect(plain).toContain("Second commit");
    expect(plain).toContain("ccc33333");
  });

  test("--no-fetch skips gh and shows local-only view", async () => {
    const repo = await repos.create();
    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Use a context whose gh client throws if called
    let ghCalled = false;
    const ctx: SpryContext = {
      git: {
        run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }),
      },
      gh: {
        run: async () => {
          ghCalled = true;
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      },
    };

    const { stdout, exitCode } = await captureView(ctx, { noFetch: true });
    const plain = stripAnsi(stdout);

    expect(exitCode).toBe(0);
    expect(plain).toContain("○ C");
    expect(ghCalled).toBe(false);
  });

  test("default (no --no-fetch) calls gh and falls back gracefully when gh missing", async () => {
    const repo = await repos.create();
    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    const ctx: SpryContext = {
      git: {
        run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }),
      },
      gh: {
        run: async () => ({
          stdout: "",
          stderr: "/bin/sh: gh: command not found",
          exitCode: 127,
        }),
      },
    };

    const { stdout, exitCode } = await captureView(ctx);
    const plain = stripAnsi(stdout);

    expect(exitCode).toBe(0);
    expect(plain).toContain("PR status unavailable: install gh");
    expect(plain).toContain("○ C");
  });
});
