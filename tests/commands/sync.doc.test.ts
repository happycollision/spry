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

  docTest("Empty stack", { section: "commands/sync", order: 20 }, async (doc) => {
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
