/**
 * group dissolve command tests - the full story
 *
 * This file tests the `sp group dissolve` command which removes group
 * trailers from commits, converting them back to individual commits.
 */
import { expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { runSpry } from "./helpers.ts";

const { test } = createStoryTest("group-dissolve.test.ts");

/**
 * Run sp group dissolve command.
 */
async function runGroupDissolve(
  cwd: string,
  groupId?: string,
  options: { inherit?: string; noInherit?: boolean } = {},
) {
  const args: string[] = ["dissolve"];
  if (groupId) args.push(groupId);
  if (options.inherit) args.push("--inherit", options.inherit);
  if (options.noInherit) args.push("--no-inherit");
  return runSpry(cwd, "group", args);
}

/**
 * Get commit messages with trailers for verification.
 */
async function getCommitTrailers(cwd: string, count: number): Promise<string> {
  return await $`git -C ${cwd} log --format=%s%n%b--- HEAD~${count}..HEAD`.text();
}

describe("sp group dissolve", () => {
  const repos = repoManager();

  test("List groups when no group ID provided", async (story) => {
    story.narrate(
      "Running `sp group dissolve` without a group ID lists available groups in non-TTY mode.",
    );

    const repo = await repos.create();
    await scenarios.withGroups.setup(repo);

    const result = await runGroupDissolve(repo.path);
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available groups:");
    expect(result.stdout).toContain("group-abc");
  });

  test("Dissolve a specific group by ID", async (story) => {
    story.narrate(
      "The `sp group dissolve <group-id>` command removes group trailers from commits, " +
        "converting them back to individual commits.",
    );

    const repo = await repos.create();
    await scenarios.withGroups.setup(repo);

    // Verify group exists before
    const beforeTrailers = await getCommitTrailers(repo.path, 3);
    expect(beforeTrailers).toContain("Spry-Group: group-abc");

    // Dissolve requires --no-inherit in non-TTY mode (no PR to inherit)
    const result = await runGroupDissolve(repo.path, "group-abc", { noInherit: true });
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dissolved");

    // Verify group trailers are removed
    const afterTrailers = await getCommitTrailers(repo.path, 3);
    expect(afterTrailers).not.toContain("Spry-Group:");
    expect(afterTrailers).toContain("Spry-Commit-Id"); // Should preserve commit IDs
  });

  test("Dissolve with partial group ID", async (story) => {
    story.narrate("You can use a prefix of the group ID - spry will match it if it's unique.");

    const repo = await repos.create();
    await scenarios.withGroups.setup(repo);

    // Use partial ID "group-a" which should match "group-abc"
    const result = await runGroupDissolve(repo.path, "group-a", { noInherit: true });
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dissolved");
  });

  test("Error when group ID not found", async (story) => {
    story.narrate("If the group ID doesn't exist, spry shows available groups.");

    const repo = await repos.create();
    await scenarios.withGroups.setup(repo);

    const result = await runGroupDissolve(repo.path, "nonexistent", { noInherit: true });
    story.log(result);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Group "nonexistent" not found');
    expect(result.stdout).toContain("Available groups:");
  });

  test("No groups to dissolve", async (story) => {
    story.narrate("When there are no groups in the stack, dissolve reports that.");

    const repo = await repos.create();
    await scenarios.withSpryIds.setup(repo);

    const result = await runGroupDissolve(repo.path);
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No groups in the current stack");
  });
});
