import { test, expect, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../../../tests/helpers/local-repo.ts";
import { runSync } from "../../../tests/integration/helpers.ts";
import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { join } from "node:path";

const repos = repoManager();
afterEach(() => repos.cleanup());

describe("cli/commands/sync", () => {
  test("adds IDs to commits that don't have them", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    await repo.commit("First commit");
    await repo.commit("Second commit");

    // Run sync
    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Adding IDs to 2 commit(s)");
    expect(result.stdout).toContain("Added Taspr-Commit-Id to 2 commit(s)");

    // Verify commits now have IDs
    const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
    expect(commits[0]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
    expect(commits[1]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
  });

  test("reports when all commits already have IDs", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    await repo.commit("Has ID", { trailers: { "Taspr-Commit-Id": "id111111" } });

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All commits have Taspr-Commit-Id");
  });

  test("reports when stack is empty", async () => {
    const repo = await repos.create();
    // No commits beyond merge-base

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("blocks on dirty working tree with staged changes", async () => {
    const repo = await repos.create();
    await repo.branch("feature");
    await repo.commit("A commit");

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
    await repo.commit("A commit");

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

    await repo.commit("Test commit for clean output");

    const result = await runSync(repo.path);

    expect(result.exitCode).toBe(0);

    // Split output into lines for easier assertion
    const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");

    // Should have exactly these lines (in order):
    // 1. "Adding IDs to 1 commit(s)..."
    // 2. "✓ Added Taspr-Commit-Id to 1 commit(s)"
    // 3. "" (blank line before pushing)
    // 4. "Pushing 1 branch(es)..."
    // 5. "" (blank line)
    // 6. "✓ 1 branch(es) pushed without PR (use --open to create)"
    expect(lines).toEqual([
      "Adding IDs to 1 commit(s)...",
      "✓ Added Taspr-Commit-Id to 1 commit(s)",
      "Pushing 1 branch(es)...",
      "✓ 1 branch(es) pushed without PR (use --open to create)",
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

  test("updates branches after user completes rebase", async () => {
    const repo = await repos.create();

    // Create initial feature branch with a commit that has an ID
    await repo.branch("feature");
    await repo.commit("Feature commit", { trailers: { "Taspr-Commit-Id": "rebase01" } });

    // Run initial sync to push the branch
    let result = await runSync(repo.path);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Pushing 1 branch(es)");

    // Get the initial commit hash on remote
    const initialHash = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();

    // Update main with a new commit (simulating another developer's work)
    await repo.updateOriginMain("Update on main");

    // Fetch and rebase onto new main (no conflicts)
    await repo.fetch();
    await $`git -C ${repo.path} rebase origin/main`.quiet();

    // Verify the commit hash changed after rebase
    const rebasedHash = (await $`git -C ${repo.path} rev-parse HEAD`.text()).trim();
    expect(rebasedHash).not.toBe(initialHash);

    // Run sync - should detect the hash changed and update the branch
    result = await runSync(repo.path);
    expect(result.exitCode).toBe(0);

    // Should show that it's updating (not creating) the branch
    expect(result.stdout).toContain("Pushing 1 branch(es)");

    // Verify the remote branch now has the new hash (branch name includes dynamic username)
    // Look for any remote branch containing "rebase01" and verify it has the new hash
    const remoteBranches = (
      await $`git -C ${repo.path} ls-remote origin 'refs/heads/taspr/*/rebase01'`.text()
    ).trim();
    expect(remoteBranches).toContain(rebasedHash);
  });

  // TODO: Add tests for --open flag once VCR-style testing is implemented
  // See: taspr-xtq (VCR-style testing for GitHub API calls)
});
