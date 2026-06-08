// Doc-producing tests for `sp rebase`. Each docTest must:
//   1. Call doc.scrub(repo) immediately after repos.push(repo) so the random
//      unique-id suffix is stripped from captured fragments.
//   2. Pass an explicit branch name to repo.branch(...) — never rely on the
//      auto-generated default. Branch names appear in output and will leak
//      through if not deterministic.
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

describe("sp rebase docs", () => {
  docTest("Already up to date", { section: "commands/rebase", order: 10 }, async (doc) => {
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

    doc.prose(
      "When your stack is already based on the latest trunk, `sp rebase` fetches and exits cleanly:",
    );

    const { command, result } = await runSp(repo.path, "rebase");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Already up to date");
  });

  docTest("Rebasing behind trunk", { section: "commands/rebase", order: 20 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await repo.fetch();
    const featureBranch = await repo.branch("feature");
    await git.run(["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Advance main on the remote while the feature branch sits on the old base
    await repo.checkout(repo.defaultBranch);
    await git.run(["commit", "--allow-empty", "-m", "Bump dependencies"], { cwd: repo.path });
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
    await repo.checkout(featureBranch);

    doc.prose(
      "When trunk has new commits, `sp rebase` fetches, detects the gap, and replays your stack on top — no conflicts, no prompts:",
    );

    const { command, result } = await runSp(repo.path, "rebase");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rebased 1 commit");
  });

  docTest("Conflict detected", { section: "commands/rebase", order: 30 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await repo.fetch();
    const featureBranch = await repo.branch("feature");
    await repo.commitFiles(
      { "api.ts": "export const handler = () => 'feature';\n" },
      "Add API handler\n\nSpry-Commit-Id: aaa11111",
    );

    // Trunk adds the same file with different content — causes add/add conflict
    await repo.checkout(repo.defaultBranch);
    await repo.commitFiles(
      { "api.ts": "export const handler = () => 'main';\n" },
      "Add API handler",
    );
    await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
    await repo.checkout(featureBranch);

    doc.prose(
      "If rebasing would produce a conflict, `sp rebase` reports the conflicting files and exits without touching your working tree. Nothing is rewritten:",
    );

    const { command, result } = await runSp(repo.path, "rebase");
    doc.command(command);
    doc.output(result.stderr);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("conflict");
  });
});

describe("sp rebase --all docs", () => {
  docTest(
    "All branches already up to date",
    { section: "commands/rebase", order: 40 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.fetch();
      // Create a feature branch and register it by running sp rebase
      await repo.branch("feature");
      await git.run(["commit", "--allow-empty", "-m", "Add feature\n\nSpry-Commit-Id: bbb22222"], {
        cwd: repo.path,
      });
      // Run sp rebase once to register the branch in tracked-branches
      await runSp(repo.path, "rebase");

      doc.prose(
        "When all tracked branches are already based on the latest trunk, `sp rebase --all` fetches and reports each as up to date:",
      );

      const { command, result } = await runSp(repo.path, "rebase", ["--all"]);
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("already up to date");
    },
  );

  docTest(
    "Rebasing multiple tracked branches",
    { section: "commands/rebase", order: 50 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.fetch();

      // Create feature-one and register via sp rebase
      const featureOneBranch = await repo.branch("feature-one");
      await git.run(
        ["commit", "--allow-empty", "-m", "Add feature one\n\nSpry-Commit-Id: ccc33333"],
        { cwd: repo.path },
      );
      await runSp(repo.path, "rebase");

      // Create feature-two on top and register it too
      const featureTwoBranch = await repo.branch("feature-two");
      await git.run(
        ["commit", "--allow-empty", "-m", "Add feature two\n\nSpry-Commit-Id: ddd44444"],
        { cwd: repo.path },
      );
      await runSp(repo.path, "rebase");

      // Advance main on remote (empty commit — no conflict possible)
      await repo.checkout(repo.defaultBranch);
      await git.run(["commit", "--allow-empty", "-m", "Bump dependencies"], { cwd: repo.path });
      await git.run(["push", "origin", repo.defaultBranch], { cwd: repo.path });
      await repo.checkout(featureTwoBranch);

      doc.prose(
        "When multiple tracked branches are behind trunk, `sp rebase --all` rebases each one in turn without requiring a manual checkout:",
      );

      const { command, result } = await runSp(repo.path, "rebase", ["--all"]);
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(featureOneBranch);
      expect(result.stdout).toContain(featureTwoBranch);
    },
  );
});
