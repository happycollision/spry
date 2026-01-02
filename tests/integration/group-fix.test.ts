import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import { runTaspr } from "./helpers.ts";

/**
 * Run taspr group --fix command.
 */
async function runGroupFix(
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runTaspr(cwd, "group", ["--fix"]);
}

/**
 * Get commit messages with trailers for verification.
 */
async function getCommitTrailers(cwd: string, count: number): Promise<string> {
  return await $`git -C ${cwd} log --format=%s%n%b--- HEAD~${count}..HEAD`.text();
}

describe("taspr group --fix", () => {
  const repos = repoManager();

  test("reports valid stack when no issues found", async () => {
    const repo = await repos.create();
    await scenarios.withGroups.setup(repo);

    const result = await runGroupFix(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No invalid groups found");
    expect(result.stdout).toContain("Stack is valid");
  });

  test("fixes unclosed group by removing all group trailers", async () => {
    const repo = await repos.create();
    await scenarios.unclosedGroup.setup(repo);

    // Verify initial state has group trailers
    const beforeTrailers = await getCommitTrailers(repo.path, 2);
    expect(beforeTrailers).toContain("Taspr-Group-Start");
    expect(beforeTrailers).toContain("Taspr-Group-Title");

    const result = await runGroupFix(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Unclosed group");
    expect(result.stdout).toContain("Removing group trailers");
    expect(result.stdout).toContain("All group trailers removed");

    // Verify group trailers are removed but commit IDs preserved
    const afterTrailers = await getCommitTrailers(repo.path, 2);
    expect(afterTrailers).not.toContain("Taspr-Group-Start");
    expect(afterTrailers).not.toContain("Taspr-Group-Title");
    expect(afterTrailers).not.toContain("Taspr-Group-End");
    expect(afterTrailers).toContain("Taspr-Commit-Id"); // Should preserve commit IDs
  });

  test("fixes overlapping groups by removing all group trailers", async () => {
    const repo = await repos.create();
    await scenarios.overlappingGroups.setup(repo);

    // Verify initial state has overlapping group trailers
    const beforeTrailers = await getCommitTrailers(repo.path, 3);
    expect(beforeTrailers).toContain("Taspr-Group-Start: group-outer");
    expect(beforeTrailers).toContain("Taspr-Group-Start: group-inner");

    const result = await runGroupFix(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Overlapping groups");
    expect(result.stdout).toContain("Removing group trailers");
    expect(result.stdout).toContain("All group trailers removed");

    // Verify all group trailers are removed
    const afterTrailers = await getCommitTrailers(repo.path, 3);
    expect(afterTrailers).not.toContain("Taspr-Group-Start");
    expect(afterTrailers).not.toContain("Taspr-Group-Title");
    expect(afterTrailers).not.toContain("Taspr-Group-End");
    expect(afterTrailers).toContain("Taspr-Commit-Id"); // Should preserve commit IDs
  });

  test("handles empty stack gracefully", async () => {
    const repo = await repos.create();
    await scenarios.emptyStack.setup(repo);

    const result = await runGroupFix(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("handles stack without any group trailers", async () => {
    const repo = await repos.create();
    await scenarios.withTasprIds.setup(repo);

    const result = await runGroupFix(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No invalid groups found");
  });
});
