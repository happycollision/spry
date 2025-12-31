import { test, expect, afterEach, describe } from "bun:test";
import { $ } from "bun";
import { createGitFixture, type GitFixture } from "../../../tests/helpers/git-fixture.ts";
import { getStackCommitsWithTrailers } from "../../git/commands.ts";
import { join } from "node:path";

let fixture: GitFixture | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.cleanup();
    fixture = null;
  }
});

// Helper to run taspr sync in the fixture directory
async function runSync(
  cwd: string,
  options: { open?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = options.open ? ["sync", "--open"] : ["sync"];
  const result = await $`bun run ${join(import.meta.dir, "../index.ts")} ${args}`
    .cwd(cwd)
    .nothrow()
    .quiet();
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe("cli/commands/sync", () => {
  test("adds IDs to commits that don't have them", async () => {
    fixture = await createGitFixture();
    await fixture.checkout("feature-sync-test", { create: true });

    await fixture.commit("First commit");
    await fixture.commit("Second commit");

    // Run sync
    const result = await runSync(fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Adding IDs to 2 commit(s)");
    expect(result.stdout).toContain("Added Taspr-Commit-Id to 2 commit(s)");

    // Verify commits now have IDs
    const commits = await getStackCommitsWithTrailers({ cwd: fixture.path });
    expect(commits[0]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
    expect(commits[1]?.trailers["Taspr-Commit-Id"]).toMatch(/^[0-9a-f]{8}$/);
  });

  test("reports when all commits already have IDs", async () => {
    fixture = await createGitFixture();
    await fixture.checkout("feature-has-ids", { create: true });

    await fixture.commit("Has ID", { trailers: { "Taspr-Commit-Id": "id111111" } });

    const result = await runSync(fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All commits have Taspr-Commit-Id");
  });

  test("reports when stack is empty", async () => {
    fixture = await createGitFixture();
    // No commits beyond merge-base

    const result = await runSync(fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("blocks on dirty working tree with staged changes", async () => {
    fixture = await createGitFixture();
    await fixture.checkout("feature-dirty", { create: true });
    await fixture.commit("A commit");

    // Stage a change
    await Bun.write(join(fixture.path, "dirty.ts"), "// dirty");
    await $`git -C ${fixture.path} add dirty.ts`.quiet();

    const result = await runSync(fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot sync with uncommitted changes");
    expect(result.stderr).toContain("staged changes");
  });

  test("blocks on dirty working tree with unstaged changes", async () => {
    fixture = await createGitFixture();
    await fixture.checkout("feature-unstaged", { create: true });
    await fixture.commit("A commit");

    // Modify tracked file
    await Bun.write(join(fixture.path, "README.md"), "# Modified");

    const result = await runSync(fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cannot sync with uncommitted changes");
    expect(result.stderr).toContain("unstaged changes");
  });

  test("output is clean with no extraneous noise", async () => {
    fixture = await createGitFixture();
    await fixture.checkout("feature-clean-output", { create: true });

    await fixture.commit("Test commit for clean output");

    const result = await runSync(fixture.path);

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
    fixture = await createGitFixture();

    // Create a file that will conflict
    const conflictFile = "conflict.txt";
    await Bun.write(join(fixture.path, conflictFile), "Original content\n");
    await $`git -C ${fixture.path} add .`.quiet();
    await $`git -C ${fixture.path} commit -m "Add conflict file"`.quiet();
    await $`git -C ${fixture.path} push origin main`.quiet();

    // Create feature branch and modify the file
    await fixture.checkout("feature-conflict", { create: true });
    await Bun.write(join(fixture.path, conflictFile), "Feature content\n");
    await $`git -C ${fixture.path} add .`.quiet();
    await $`git -C ${fixture.path} commit -m "Feature change"`.quiet();

    // Update main with conflicting change via worktree
    const tempWorktree = `${fixture.originPath}-worktree`;
    await $`git clone ${fixture.originPath} ${tempWorktree}`.quiet();
    await $`git -C ${tempWorktree} config user.email "other@example.com"`.quiet();
    await $`git -C ${tempWorktree} config user.name "Other User"`.quiet();
    await Bun.write(join(tempWorktree, conflictFile), "Main content\n");
    await $`git -C ${tempWorktree} add .`.quiet();
    await $`git -C ${tempWorktree} commit -m "Main change"`.quiet();
    await $`git -C ${tempWorktree} push origin main`.quiet();
    await $`rm -rf ${tempWorktree}`.quiet();

    // Fetch and attempt rebase (will conflict)
    await $`git -C ${fixture.path} fetch origin`.quiet();
    await $`git -C ${fixture.path} rebase origin/main`.quiet().nothrow();

    // Now try to run sync - should detect the conflict
    const result = await runSync(fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Rebase conflict");
    expect(result.stderr).toContain(conflictFile);
    expect(result.stderr).toContain("git add");
    expect(result.stderr).toContain("git rebase --continue");

    // Clean up
    await $`git -C ${fixture.path} rebase --abort`.quiet().nothrow();
  });

  // TODO: Add tests for --open flag once VCR-style testing is implemented
  // See: taspr-xtq (VCR-style testing for GitHub API calls)
});
