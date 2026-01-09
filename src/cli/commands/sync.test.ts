import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../../../tests/helpers/local-repo.ts";
import { runSync } from "../../../tests/integration/helpers.ts";
import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { scenarios } from "../../scenario/definitions.ts";
import { join } from "node:path";

const repos = repoManager();

describe("cli/commands/sync", () => {
  test("adds IDs to commits that don't have them", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    await repo.commit();
    await repo.commit();

    // Run sync
    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Adding IDs to 2 commit(s)");
    expect(result.stdout).toContain("Added Spry-Commit-Id to 2 commit(s)");

    // Verify commits now have IDs
    const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
    expect(commits[0]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
    expect(commits[1]?.trailers["Spry-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
  });

  test("reports when all commits already have IDs", async () => {
    const repo = await repos.create();
    await scenarios.withSpryIds.setup(repo);

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All commits have Spry-Commit-Id");
  });

  test("reports when stack is empty", async () => {
    const repo = await repos.create();
    await scenarios.emptyStack.setup(repo);

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("blocks on dirty working tree with staged changes", async () => {
    const repo = await repos.create();
    await repo.branch("feature");
    await repo.commit();

    // Stage a change
    await Bun.write(join(repo.path, "dirty.ts"), "// dirty");
    await $`git -C ${repo.path} add dirty.ts`.quiet();

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot sync with uncommitted changes");
    expect(result.stderr).toContain("staged changes");
  });

  test("blocks on dirty working tree with unstaged changes", async () => {
    const repo = await repos.create();
    await repo.branch("feature");
    await repo.commit();

    // Modify tracked file
    await Bun.write(join(repo.path, "README.md"), "# Modified");

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot sync with uncommitted changes");
    expect(result.stderr).toContain("unstaged changes");
  });

  test("output is clean with no extraneous noise", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    await repo.commit();

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);

    // Split output into lines for easier assertion
    const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");

    // Should have exactly these lines (in order):
    // 1. "Adding IDs to 1 commit(s)..."
    // 2. "✓ Added Spry-Commit-Id to 1 commit(s)"
    // 3. "✓ 1 commit(s) ready (use --open to create PRs)"
    // Note: Branches are NOT pushed until --open is used (no remote clutter)
    expect(lines).toEqual([
      "Adding IDs to 1 commit(s)...",
      "✓ Added Spry-Commit-Id to 1 commit(s)",
      "✓ 1 commit(s) ready (use --open to create PRs)",
    ]);

    // Should NOT contain any of these noise patterns
    expect(result.stdout).not.toContain("Executing:");
    expect(result.stdout).not.toContain("lint-staged");
    expect(result.stdout).not.toContain("remote:");
    expect(result.stdout).not.toContain("HEAD branch:");
    expect(result.stdout).not.toContain("Fetch URL:");
    expect(result.stdout).not.toContain("detached HEAD");
    expect(result.stdout).not.toContain("Successfully rebased");

    // stderr should be empty
    expect(result.stderr).toBe("");
  });

  test("blocks when mid-rebase conflict is detected", async () => {
    const repo = await repos.create();

    // Create a file that will conflict
    const conflictFile = "conflict.txt";
    await Bun.write(join(repo.path, conflictFile), "Original content\n");
    await $`git -C ${repo.path} add .`.quiet();
    await $`git -C ${repo.path} commit -m "Add conflict file"`.quiet();
    await $`git -C ${repo.path} push origin main`.quiet();

    // Create feature branch and modify the file
    await repo.branch("feature");
    await Bun.write(join(repo.path, conflictFile), "Feature content\n");
    await $`git -C ${repo.path} add .`.quiet();
    await $`git -C ${repo.path} commit -m "Feature change"`.quiet();

    // Update main with conflicting change
    await repo.updateOriginMain("Main change", { [conflictFile]: "Main content\n" });

    // Fetch and attempt rebase (will conflict)
    await repo.fetch();
    await $`git -C ${repo.path} rebase origin/main`.quiet().nothrow();

    // Now try to run sync - should detect the conflict
    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Rebase conflict");
    expect(result.stderr).toContain(conflictFile);
    expect(result.stderr).toContain("git add");
    expect(result.stderr).toContain("git rebase --continue");

    // Clean up
    await $`git -C ${repo.path} rebase --abort`.quiet().nothrow();
  });

  test("does not push branches without --open flag", async () => {
    const repo = await repos.create();

    // Create initial feature branch with a commit that has an ID
    await repo.branch("feature");
    await repo.commit({ trailers: { "Spry-Commit-Id": "nopush01" } });

    // Run sync without --open
    const result = await runSync(repo.path);
    expect(result.exitCode).toBe(0);

    // Should indicate commit is ready, NOT that it was pushed
    expect(result.stdout).toContain("1 commit(s) ready (use --open to create PRs)");
    expect(result.stdout).not.toContain("Pushed");

    // Verify the remote branch does NOT exist
    const remoteBranches = (
      await $`git -C ${repo.path} ls-remote origin 'refs/heads/spry/*/nopush01'`.text()
    ).trim();
    expect(remoteBranches).toBe("");
  });

  // GitHub integration tests for --open flag are in tests/integration/sync.test.ts
});
