// Doc-producing tests for `sp view`. Each docTest must:
//   1. Call doc.scrub(repo) immediately after repos.push(repo) so the random
//      unique-id suffix is stripped from captured fragments.
//   2. Pass an explicit branch name to repo.branch(...) — never rely on the
//      auto-generated default. Branch names appear in `Stack: <branch>` and
//      will leak through if not deterministic.
//   3. Set spry.trunk, spry.remote, AND spry.branchPrefix before invoking sp
//      (loadConfig requires all three).
import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import { docTest, createRunner, createRepo, createRealGitRunner } from "../lib/index.ts";
import { savePRCache } from "../../src/gh/pr-cache.ts";
import type { PRCacheEntry } from "../../src/gh/pr-cache.ts";

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
        "View the current stack of commits on your feature branch. Pass `--no-fetch` to skip fetching remote refs (useful in CI or offline):",
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

  docTest("PR status from local cache", { section: "commands/view", order: 30 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await repo.branch("feature");
    await git.run(["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Seed the local PR cache (normally written by sp sync)
    const entry: PRCacheEntry = {
      branch: "spry/dondenton/aaa11111",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "OPEN",
      title: "Add login page",
      baseRefName: "main",
      checksStatus: "passing",
      reviewDecision: "none",
      reviewThreads: { resolved: 0, total: 2 },
      cachedAt: "2026-06-07T00:00:00.000Z",
    };
    await savePRCache(git, { aaa11111: entry }, { cwd: repo.path });

    doc.prose(
      "sp view reads PR status from a local git ref written by sp sync — no network call needed:",
    );

    // Scrub the full PR URL to a stable placeholder for docs
    doc.scrub("https://github.com/owner/repo/pull/42", "https://github.com/<owner>/<repo>/pull/42");

    const { command, result } = await runSp(repo.path, "view");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pull/42");
  });
});
