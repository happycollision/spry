/**
 * group expansion tests - adding commits to existing groups
 *
 * This file tests the behavior when commits are added to existing groups.
 * The key requirement: when expanding an existing group, the group ID must be
 * preserved so that existing PRs remain associated with the group.
 */
import { expect, describe } from "bun:test";
import { $ } from "bun";
import { repoManager } from "../helpers/local-repo.ts";
import { scenarios } from "../../src/scenario/definitions.ts";
import { createStoryTest } from "../helpers/story-test.ts";
import { runSpry } from "./helpers.ts";

const { test } = createStoryTest("group-expand.test.ts");

/**
 * Get commit hashes and their Spry-Group trailers via git log.
 */
async function getCommitGroups(
  cwd: string,
): Promise<Array<{ hash: string; subject: string; groupId: string | null }>> {
  // Format: hash|subject|trailers (one per line)
  // Use an array for args to avoid Bun shell parsing issues with parentheses
  const format = "%H|%s|%(trailers:key=Spry-Group,valueonly)";
  const log = await $`git -C ${cwd} log --format=${format} HEAD~7..HEAD`.text().catch(() => "");

  return log
    .trim()
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [hash, subject, groupId] = line.split("|");
      return {
        hash: hash || "",
        subject: subject || "",
        groupId: groupId?.trim() || null,
      };
    });
}

describe("sp group (expanding existing groups)", () => {
  const repos = repoManager();

  test("Expanding group via --apply preserves group ID when id is specified", async (story) => {
    story.narrate(
      "When using `sp group --apply` with an explicit `id` field, the existing group ID " +
        "should be preserved. This is the expected behavior that the TUI should also follow.",
    );

    const repo = await repos.create();
    await scenarios.mixedGroupStack.setup(repo);

    // mixedGroupStack creates:
    // - mix00001: ungrouped ("Add initial utils")
    // - mix00002-04: group-auth (3 commits - auth related)
    // - mix00005: ungrouped ("Fix typo in readme")
    // - mix00006: group-dark (single commit)
    // - mix00007: ungrouped ("Update dependencies")

    // Get commit hashes for the auth group (commits 2-4, which are indices 1-3 from bottom)
    let commits = await getCommitGroups(repo.path);
    expect(commits).toHaveLength(7);

    // Find commits in group-auth and the ungrouped commit after
    const authGroupCommits = commits.filter((c) => c.groupId === "group-auth");
    expect(authGroupCommits).toHaveLength(3);

    const ungroupedCommit = commits.find((c) => c.subject.startsWith("Fix typo in readme"));
    expect(ungroupedCommit).toBeDefined();
    expect(ungroupedCommit!.groupId).toBeNull();

    // Build a spec that expands the auth group to include the ungrouped commit
    // This mimics what the TUI SHOULD do when user adds a commit to existing group
    const spec = JSON.stringify({
      groups: [
        {
          commits: [...authGroupCommits.map((c) => c.hash), ungroupedCommit!.hash],
          name: "User Authentication (expanded)",
          id: "group-auth", // Explicitly preserve the existing group ID
        },
      ],
    });

    const result = await runSpry(repo.path, "group", ["--apply", spec]);
    story.log(result);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("applied successfully");

    // Verify the group ID was preserved
    commits = await getCommitGroups(repo.path);
    const newAuthGroupCommits = commits.filter((c) => c.groupId === "group-auth");

    // Should now have 4 commits in the group (was 3)
    expect(newAuthGroupCommits).toHaveLength(4);

    // Verify the title was updated via sp view
    const viewResult = await runSpry(repo.path, "view", []);
    story.log(viewResult);
    expect(viewResult.stdout).toContain("User Authentication (expanded)");
  });

  test("Expanding group via --apply generates new ID when id is NOT specified", async (story) => {
    story.narrate(
      "When using `sp group --apply` WITHOUT an `id` field, a new group ID is generated. " +
        "This is the BUGGY behavior that the TUI currently exhibits - it should instead " +
        "preserve the existing group ID when modifying an existing group.",
    );

    const repo = await repos.create();
    await scenarios.mixedGroupStack.setup(repo);

    let commits = await getCommitGroups(repo.path);
    const authGroupCommits = commits.filter((c) => c.groupId === "group-auth");
    const ungroupedCommit = commits.find((c) => c.subject.startsWith("Fix typo in readme"));

    // Build a spec WITHOUT the id field - simulating what the TUI currently does
    const spec = JSON.stringify({
      groups: [
        {
          commits: [...authGroupCommits.map((c) => c.hash), ungroupedCommit!.hash],
          name: "User Authentication (expanded)",
          // NO id field - this is what the TUI currently does
        },
      ],
    });

    const result = await runSpry(repo.path, "group", ["--apply", spec]);
    story.log(result);

    expect(result.exitCode).toBe(0);

    // Verify a NEW group ID was generated (not the original "group-auth")
    commits = await getCommitGroups(repo.path);

    // The original "group-auth" ID should no longer exist
    const originalGroupCommits = commits.filter((c) => c.groupId === "group-auth");
    expect(originalGroupCommits).toHaveLength(0); // Gone!

    // A new group with a different ID should exist (not group-auth or group-dark)
    const expandedGroupCommits = commits.filter((c) => {
      return c.groupId && c.groupId !== "group-auth" && c.groupId !== "group-dark";
    });
    expect(expandedGroupCommits).toHaveLength(4);

    // All 4 commits should have the same (new) group ID
    const newGroupId = expandedGroupCommits[0]!.groupId;
    for (const commit of expandedGroupCommits) {
      expect(commit.groupId).toBe(newGroupId);
    }

    story.narrate(
      `New group ID generated: ${newGroupId}. The original "group-auth" ID was lost, ` +
        "which would break any existing PR association.",
    );
  });
});
