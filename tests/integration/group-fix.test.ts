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
  mode?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = mode ? [`--fix=${mode}`] : ["--fix"];
  return runTaspr(cwd, "group", args);
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

  test("fixes unclosed group by removing only the start marker (non-TTY fallback)", async () => {
    const repo = await repos.create();
    await scenarios.unclosedGroup.setup(repo);

    // Verify initial state has group trailers
    const beforeTrailers = await getCommitTrailers(repo.path, 2);
    expect(beforeTrailers).toContain("Taspr-Group-Start");
    expect(beforeTrailers).toContain("Taspr-Group-Title");

    // In non-TTY mode, --fix falls back to dissolve behavior
    const result = await runGroupFix(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Unclosed group");
    expect(result.stdout).toContain("start removed");

    // Verify only the unclosed group's start marker is removed
    const afterTrailers = await getCommitTrailers(repo.path, 2);
    expect(afterTrailers).not.toContain("Taspr-Group-Start");
    expect(afterTrailers).not.toContain("Taspr-Group-Title");
    expect(afterTrailers).toContain("Taspr-Commit-Id"); // Should preserve commit IDs
  });

  test("fixes overlapping groups by removing the inner group start (non-TTY fallback)", async () => {
    const repo = await repos.create();
    await scenarios.overlappingGroups.setup(repo);

    // Verify initial state has overlapping group trailers
    const beforeTrailers = await getCommitTrailers(repo.path, 3);
    expect(beforeTrailers).toContain("Taspr-Group-Start: group-outer");
    expect(beforeTrailers).toContain("Taspr-Group-Start: group-inner");

    // In non-TTY mode, --fix falls back to dissolve behavior (removes inner group)
    const result = await runGroupFix(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Overlapping groups");
    expect(result.stdout).toContain("Inner Group");
    expect(result.stdout).toContain("start removed");

    // Verify only the inner group's start marker is removed, outer group still exists
    const afterTrailers = await getCommitTrailers(repo.path, 3);
    expect(afterTrailers).toContain("Taspr-Group-Start: group-outer"); // Outer still exists
    expect(afterTrailers).not.toContain("Taspr-Group-Start: group-inner"); // Inner removed
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

  test("fixes orphan group end by removing only the orphan end (dissolve mode)", async () => {
    const repo = await repos.create();
    await scenarios.orphanGroupEnd.setup(repo);

    // Verify initial state has orphan group end
    const beforeTrailers = await getCommitTrailers(repo.path, 3);
    expect(beforeTrailers).toContain("Taspr-Group-End: group-orphan");
    expect(beforeTrailers).not.toContain("Taspr-Group-Start");

    const result = await runGroupFix(repo.path, "dissolve");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Group end without matching start");
    expect(result.stdout).toContain("Removing orphan group end");
    expect(result.stdout).toContain("Orphan group end removed");

    // Verify orphan group end is removed but commit IDs preserved
    const afterTrailers = await getCommitTrailers(repo.path, 3);
    expect(afterTrailers).not.toContain("Taspr-Group-End");
    expect(afterTrailers).toContain("Taspr-Commit-Id"); // Should preserve commit IDs
  });

  test("--fix=dissolve removes only the problematic group start", async () => {
    const repo = await repos.create();
    await scenarios.unclosedGroup.setup(repo);

    const result = await runGroupFix(repo.path, "dissolve");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Unclosed group");
    expect(result.stdout).toContain("start removed");

    // Verify only group start/title trailers are removed
    const afterTrailers = await getCommitTrailers(repo.path, 2);
    expect(afterTrailers).not.toContain("Taspr-Group-Start");
    expect(afterTrailers).not.toContain("Taspr-Group-Title");
    expect(afterTrailers).toContain("Taspr-Commit-Id"); // Should preserve commit IDs
  });
});
