import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import { docTest, createRunner, createRepo, createRealGitRunner } from "../lib/index.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const runSp = createRunner(cliPath);

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

describe("sp view docs", () => {
  docTest(
    "Viewing a simple stack (offline)",
    { section: "commands/view", order: 10 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.branch("feature");
      await git.run(
        ["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"],
        { cwd: repo.path },
      );
      await git.run(
        ["commit", "--allow-empty", "-m", "Add signup form\n\nSpry-Commit-Id: bbb22222"],
        { cwd: repo.path },
      );

      doc.prose(
        "View the current stack of commits on your feature branch (use --no-fetch for offline/CI):",
      );

      const { command, result } = await runSp(repo.path, "view", ["--no-fetch"]);
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Stack:");
      expect(result.stdout).toContain("2 commits");
      expect(result.stdout).toContain("Add login page");
      expect(result.stdout).toContain("Add signup form");
    },
  );

  docTest("Viewing an empty stack", { section: "commands/view", order: 20 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    doc.prose("When you're on a branch with no commits ahead of trunk:");

    const { command, result } = await runSp(repo.path, "view", ["--no-fetch"]);
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits ahead of");
  });

  docTest(
    "PR status unavailable (fallback)",
    { section: "commands/view", order: 30 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.branch("feature");
      await git.run(
        ["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"],
        { cwd: repo.path },
      );

      doc.prose(
        "If gh isn't installed, isn't authenticated, or can't reach GitHub, sp view falls back to local mode with a hint:",
      );

      // Default invocation (no --no-fetch). With no gh on PATH or no auth in test
      // env, we get the no-gh / auth fallback. We assert only on the "PR status
      // unavailable" prefix to keep this stable across environments.
      const { command, result } = await runSp(repo.path, "view");
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("PR status unavailable");
    },
  );
});
