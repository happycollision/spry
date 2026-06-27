// Doc-producing tests for `sp clean`. Each docTest must:
//   1. Call doc.scrub(repo) immediately after repos.push(repo) so the random
//      unique-id suffix and temp paths are stripped from captured fragments.
//   2. Use explicit, deterministic remote branch names (no unique-id suffix) so
//      the captured output is stable across runs.
//   3. Set spry.trunk, spry.remote, AND spry.branchPrefix before invoking sp
//      (loadConfig requires all three).
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

describe("sp clean docs", () => {
  docTest("Deleting landed branches", { section: "commands/clean", order: 10 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await repo.fetch();

    // A commit that lands on trunk: push it to main AND to a spry branch.
    await git.run(["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    const landedSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", "main"], { cwd: repo.path });
    await git.run(["push", "origin", `${landedSha}:refs/heads/spry/dondenton/login`], {
      cwd: repo.path,
    });

    doc.prose(
      "Once a stack has landed on trunk, `sp clean` fetches the remote and deletes the spry branches whose tip commits are now ancestors of trunk:",
    );

    const { command, result } = await runSp(repo.path, "clean");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("spry/dondenton/login");
    expect(result.stdout).toContain("Deleted");
  });

  docTest("Previewing with --dry-run", { section: "commands/clean", order: 20 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await repo.fetch();

    await git.run(["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    const landedSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", "main"], { cwd: repo.path });
    await git.run(["push", "origin", `${landedSha}:refs/heads/spry/dondenton/login`], {
      cwd: repo.path,
    });

    doc.prose("Pass `--dry-run` to see which branches would be removed without deleting anything:");

    const { command, result } = await runSp(repo.path, "clean", ["--dry-run"]);
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Would delete");
    expect(result.stdout).toContain("spry/dondenton/login");
  });

  docTest("Nothing to clean", { section: "commands/clean", order: 30 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await repo.fetch();

    // A spry branch whose commit never landed on trunk.
    await git.run(
      ["commit", "--allow-empty", "-m", "Work in progress\n\nSpry-Commit-Id: bbb22222"],
      {
        cwd: repo.path,
      },
    );
    const sha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${sha}:refs/heads/spry/dondenton/wip`], { cwd: repo.path });

    doc.prose("When no tracked branch has landed yet, `sp clean` leaves every branch in place:");

    const { command, result } = await runSp(repo.path, "clean");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No landed branches");
  });
});
