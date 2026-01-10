import { expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { runSpry } from "./helpers.ts";

const { test } = createStoryTest("group-fix.test.ts");

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

  test("Valid stack with no issues", async (story) => {
    story.narrate("When all groups in a stack are valid, sp group --fix reports no issues.");

    const repo = await repos.create();
    await scenarios.withGroups.setup(repo);

    const result = await runGroupFix(repo.path);
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No invalid groups found");
    expect(result.stdout).toContain("Stack is valid");
  });

  test("Split group auto repair requires explicit mode (non-TTY)", async (story) => {
    story.narrate(
      "A 'split group' occurs when commits with the same group ID are not contiguous. " +
        "In non-TTY mode, --fix requires an explicit method (dissolve or merge) to avoid destructive defaults.",
    );

    const repo = await repos.create();
    await scenarios.splitGroup.setup(repo);

    // Verify initial state has split group trailers
    const beforeTrailers = await getCommitTrailers(repo.path, 3);
    expect(beforeTrailers).toContain("Spry-Group: group-split");

    // In non-TTY mode, --fix without explicit method should fail
    const result = await runGroupFix(repo.path);
    story.log(result);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Split group");
    expect(result.stdout).toContain("Non-interactive mode requires an explicit fix method");
    expect(result.stdout).toContain("--fix=dissolve");
    expect(result.stdout).toContain("--fix=merge");

    // Verify group trailers are NOT removed (no action taken)
    const afterTrailers = await getCommitTrailers(repo.path, 3);
    expect(afterTrailers).toContain("Spry-Group: group-split");
  });

  test("Empty stack handling", async (story) => {
    story.narrate("Running group --fix on a branch with no commits above main exits cleanly.");

    const repo = await repos.create();
    await scenarios.emptyStack.setup(repo);

    const result = await runGroupFix(repo.path);
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("Stack without groups", async (story) => {
    story.narrate("A stack with Spry-Commit-Id trailers but no groups is valid.");

    const repo = await repos.create();
    await scenarios.withSpryIds.setup(repo);

    const result = await runGroupFix(repo.path);
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No invalid groups found");
  });

  test("Explicit dissolve with --fix=dissolve", async (story) => {
    story.narrate(
      "Using --fix=dissolve explicitly dissolves a split group by removing its trailers.",
    );

    const repo = await repos.create();
    await scenarios.splitGroup.setup(repo);

    const result = await runGroupFix(repo.path, "dissolve");
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Split group");
    expect(result.stdout).toContain("dissolved");

    // Verify group trailers are removed
    const afterTrailers = await getCommitTrailers(repo.path, 3);
    expect(afterTrailers).not.toContain("Spry-Group:");
    expect(afterTrailers).toContain("Spry-Commit-Id"); // Should preserve commit IDs
  });

  test("Explicit merge with --fix=merge", async (story) => {
    story.narrate("Using --fix=merge explicitly reorders commits to restore group contiguity.");

    const repo = await repos.create();
    await scenarios.splitGroup.setup(repo);

    // Verify initial state has split group trailers
    const beforeTrailers = await getCommitTrailers(repo.path, 3);
    expect(beforeTrailers).toContain("Spry-Group: group-split");

    const result = await runGroupFix(repo.path, "merge");
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Split group");
    expect(result.stdout).toContain("merged successfully");

    // Verify group trailers are preserved (commits reordered, not dissolved)
    const afterTrailers = await getCommitTrailers(repo.path, 3);
    expect(afterTrailers).toContain("Spry-Group: group-split");
    expect(afterTrailers).toContain("Spry-Commit-Id");
  });
});
