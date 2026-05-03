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
  docTest("Viewing a simple stack", { section: "commands/view", order: 10 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    // Configure spry
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

    // Create feature branch with two commits
    await repo.branch("feature");
    await git.run(["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    await git.run(
      ["commit", "--allow-empty", "-m", "Add signup form\n\nSpry-Commit-Id: bbb22222"],
      { cwd: repo.path },
    );

    doc.prose("View the current stack of commits on your feature branch:");

    const { command, result } = await runSp(repo.path, "view");

    doc.command(command);
    doc.output(result.stdout);

    // Verify the output looks right
    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Stack:");
    expect(result.stdout).toContain("2 commits");
    expect(result.stdout).toContain("Add login page");
    expect(result.stdout).toContain("Add signup form");
  });

  docTest("Viewing an empty stack", { section: "commands/view", order: 20 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

    doc.prose("When you're on a branch with no commits ahead of trunk:");

    const { command, result } = await runSp(repo.path, "view");

    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits ahead of");
  });
});
