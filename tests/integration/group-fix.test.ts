import { test, expect, describe, afterAll } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import { createStory } from "../helpers/story.ts";
import { runSpry } from "./helpers.ts";

/**
 * Run sp group --fix command.
 */
async function runGroupFix(cwd: string, mode?: string) {
  const args = mode ? [`--fix=${mode}`] : ["--fix"];
  return runSpry(cwd, "group", args);
}

/**
 * Get commit messages with trailers for verification.
 */
async function getCommitTrailers(cwd: string, count: number): Promise<string> {
  return await $`git -C ${cwd} log --format=%s%n%b--- HEAD~${count}..HEAD`.text();
}

describe("sp group --fix", () => {
  const repos = repoManager();
  const story = createStory("group-fix.test.ts");

  afterAll(async () => {
    await story.flush();
  });

  test("reports valid stack when no issues found", async () => {
    story.begin("reports valid stack when no issues found");
    story.narrate("When all groups in a stack are valid, sp group --fix reports no issues.");

    const repo = await repos.create();
    await scenarios.withGroups.setup(repo);

    const result = await runGroupFix(repo.path);
    story.log(result);
    story.end();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No invalid groups found");
    expect(result.stdout).toContain("Stack is valid");
  });

  test("fixes split group by dissolving in non-TTY mode", async () => {
    story.begin("fixes split group by dissolving in non-TTY mode");
    story.narrate(
      "A 'split group' occurs when commits with the same group ID are not contiguous. " +
        "In non-TTY mode, --fix automatically dissolves the group by removing trailers.",
    );

    const repo = await repos.create();
    await scenarios.splitGroup.setup(repo);

    // Verify initial state has split group trailers
    const beforeTrailers = await getCommitTrailers(repo.path, 3);
    expect(beforeTrailers).toContain("Spry-Group: group-split");

    // In non-TTY mode, --fix falls back to dissolve behavior
    const result = await runGroupFix(repo.path);
    story.log(result);
    story.end();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Split group");
    expect(result.stdout).toContain("dissolved");

    // Verify group trailers are removed
    const afterTrailers = await getCommitTrailers(repo.path, 3);
    expect(afterTrailers).not.toContain("Spry-Group:");
    expect(afterTrailers).toContain("Spry-Commit-Id"); // Should preserve commit IDs
  });

  test("handles empty stack gracefully", async () => {
    story.begin("handles empty stack gracefully");
    story.narrate("Running group --fix on a branch with no commits above main exits cleanly.");

    const repo = await repos.create();
    await scenarios.emptyStack.setup(repo);

    const result = await runGroupFix(repo.path);
    story.log(result);
    story.end();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("handles stack without any group trailers", async () => {
    story.begin("handles stack without any group trailers");
    story.narrate("A stack with Spry-Commit-Id trailers but no groups is valid.");

    const repo = await repos.create();
    await scenarios.withSpryIds.setup(repo);

    const result = await runGroupFix(repo.path);
    story.log(result);
    story.end();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No invalid groups found");
  });

  test("--fix=dissolve removes split group trailers", async () => {
    story.begin("--fix=dissolve removes split group trailers");
    story.narrate(
      "Using --fix=dissolve explicitly dissolves a split group by removing its trailers.",
    );

    const repo = await repos.create();
    await scenarios.splitGroup.setup(repo);

    const result = await runGroupFix(repo.path, "dissolve");
    story.log(result);
    story.end();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Split group");
    expect(result.stdout).toContain("dissolved");

    // Verify group trailers are removed
    const afterTrailers = await getCommitTrailers(repo.path, 3);
    expect(afterTrailers).not.toContain("Spry-Group:");
    expect(afterTrailers).toContain("Spry-Commit-Id"); // Should preserve commit IDs
  });
});
