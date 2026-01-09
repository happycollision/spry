import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createLocalRepo, type LocalRepo } from "../scenario/core.ts";
import { generateUniqueId } from "../../tests/helpers/unique-id.ts";
import {
  applyGroupSpec,
  parseGroupSpec,
  dissolveGroup,
  addGroupTrailers,
  removeGroupTrailers,
  mergeSplitGroup,
} from "./group-rebase.ts";
import { getStackCommitsWithTrailers } from "./commands.ts";
import { parseStack } from "../core/stack.ts";
import { scenarios } from "../scenario/definitions.ts";
import { readGroupTitles } from "./group-titles.ts";

describe("group-rebase", () => {
  let repo: LocalRepo;

  beforeEach(async () => {
    repo = await createLocalRepo(
      { uniqueId: generateUniqueId() },
      { scenarioName: "group-rebase" },
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  describe("parseGroupSpec", () => {
    test("parses empty spec", () => {
      const spec = parseGroupSpec('{"groups": []}');
      expect(spec.groups).toEqual([]);
      expect(spec.order).toBeUndefined();
    });

    test("parses spec with order", () => {
      const spec = parseGroupSpec('{"order": ["a", "b"], "groups": []}');
      expect(spec.order).toEqual(["a", "b"]);
    });

    test("parses spec with groups", () => {
      const spec = parseGroupSpec('{"groups": [{"commits": ["a", "b"], "name": "My Group"}]}');
      expect(spec.groups).toHaveLength(1);
      expect(spec.groups[0]!.commits).toEqual(["a", "b"]);
      expect(spec.groups[0]!.name).toBe("My Group");
    });

    test("throws on invalid JSON", () => {
      expect(() => parseGroupSpec("not json")).toThrow();
    });

    test("throws if groups is not an array", () => {
      expect(() => parseGroupSpec('{"groups": "not array"}')).toThrow("groups must be an array");
    });
  });

  describe("applyGroupSpec", () => {
    test("creates a single-commit group", async () => {
      // Create a branch with commits
      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "First commit" });

      // Apply group spec
      const result = await applyGroupSpec(
        {
          groups: [{ commits: [hash1], name: "Single Commit Group" }],
        },
        { cwd: repo.path },
      );

      expect(result.success).toBe(true);

      // Verify Spry-Group trailer was added
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(1);

      const commit = commits[0]!;
      const groupId = commit.trailers["Spry-Group"];
      expect(groupId).toBeDefined();

      // Title is stored in ref storage
      const titles = await readGroupTitles({ cwd: repo.path });
      expect(titles[groupId!]).toBe("Single Commit Group");
    });

    test("creates a multi-commit group", async () => {
      // Create a branch with commits
      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "First commit" });
      const hash2 = await repo.commit({ message: "Second commit" });
      const hash3 = await repo.commit({ message: "Third commit" });

      // Apply group spec - group all 3 commits
      const result = await applyGroupSpec(
        {
          groups: [{ commits: [hash1, hash2, hash3], name: "Multi Commit Group" }],
        },
        { cwd: repo.path },
      );

      expect(result.success).toBe(true);

      // Verify Spry-Group trailer was added to all commits
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(3);

      const groupId = commits[0]!.trailers["Spry-Group"];
      expect(groupId).toBeDefined();

      // All commits should have the same group ID
      for (const commit of commits) {
        expect(commit.trailers["Spry-Group"]).toBe(groupId);
      }

      // Title is stored in ref storage
      const titles = await readGroupTitles({ cwd: repo.path });
      expect(titles[groupId!]).toBe("Multi Commit Group");
    });

    test("supports short hash references", async () => {
      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "First commit" });

      // Use short hash (7 chars)
      const shortHash = hash1.slice(0, 7);

      const result = await applyGroupSpec(
        {
          groups: [{ commits: [shortHash], name: "Short Hash Group" }],
        },
        { cwd: repo.path },
      );

      expect(result.success).toBe(true);

      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const groupId = commits[0]!.trailers["Spry-Group"];
      expect(groupId).toBeDefined();

      // Title is stored in ref storage
      const titles = await readGroupTitles({ cwd: repo.path });
      expect(titles[groupId!]).toBe("Short Hash Group");
    });

    test("supports Spry-Commit-Id references", async () => {
      await repo.branch("feature");
      await repo.commit({
        message: "First commit",
        trailers: { "Spry-Commit-Id": "abc12345" },
      });

      // Reference by Spry-Commit-Id
      const result = await applyGroupSpec(
        {
          groups: [{ commits: ["abc12345"], name: "ID Reference Group" }],
        },
        { cwd: repo.path },
      );

      expect(result.success).toBe(true);

      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const groupId = commits[0]!.trailers["Spry-Group"];
      expect(groupId).toBeDefined();

      // Title is stored in ref storage, not in commit trailers
      const titles = await readGroupTitles({ cwd: repo.path });
      expect(titles[groupId!]).toBe("ID Reference Group");
    });

    test("reorders commits when order is specified", async () => {
      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "First" });
      const hash2 = await repo.commit({ message: "Second" });
      const hash3 = await repo.commit({ message: "Third" });

      // Reverse the order
      const result = await applyGroupSpec(
        {
          order: [hash3, hash2, hash1],
          groups: [],
        },
        { cwd: repo.path },
      );

      expect(result.success).toBe(true);

      // Verify order changed
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(3);

      // Order should now be: Third, Second, First
      expect(commits[0]!.subject).toContain("Third");
      expect(commits[1]!.subject).toContain("Second");
      expect(commits[2]!.subject).toContain("First");
    });

    test("reorders and groups in one operation", async () => {
      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "First" });
      const hash2 = await repo.commit({ message: "Second" });
      const hash3 = await repo.commit({ message: "Third" });

      // Reorder to: Third, First, Second and group Third+First
      const result = await applyGroupSpec(
        {
          order: [hash3, hash1, hash2],
          groups: [{ commits: [hash3, hash1], name: "Reordered Group" }],
        },
        { cwd: repo.path },
      );

      expect(result.success).toBe(true);

      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(3);

      // Verify order
      expect(commits[0]!.subject).toContain("Third");
      expect(commits[1]!.subject).toContain("First");
      expect(commits[2]!.subject).toContain("Second");

      // Verify group (Third and First have same Spry-Group)
      const groupId = commits[0]!.trailers["Spry-Group"];
      expect(groupId).toBeDefined();
      expect(commits[1]!.trailers["Spry-Group"]).toBe(groupId);

      // Title is stored in ref storage
      const titles = await readGroupTitles({ cwd: repo.path });
      expect(titles[groupId!]).toBe("Reordered Group");

      // Second should not be in the group
      expect(commits[2]!.trailers["Spry-Group"]).toBeUndefined();
    });

    test("does nothing when no changes needed", async () => {
      await repo.branch("feature");
      await repo.commit({ message: "First" });

      const result = await applyGroupSpec(
        {
          groups: [],
        },
        { cwd: repo.path },
      );

      expect(result.success).toBe(true);
    });

    test("validates parsed stack after grouping", async () => {
      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "First" });
      const hash2 = await repo.commit({ message: "Second" });

      await applyGroupSpec(
        {
          groups: [{ commits: [hash1, hash2], name: "Valid Group" }],
        },
        { cwd: repo.path },
      );

      // parseStack should validate successfully
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const titles = await readGroupTitles({ cwd: repo.path });
      const result = parseStack(commits, titles);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.units).toHaveLength(1);
        expect(result.units[0]!.type).toBe("group");
        expect(result.units[0]!.title).toBe("Valid Group");
      }
    });

    test("throws on unknown commit reference", async () => {
      await repo.branch("feature");
      await repo.commit({ message: "First" });

      expect(
        applyGroupSpec(
          {
            groups: [{ commits: ["nonexistent"], name: "Bad Group" }],
          },
          { cwd: repo.path },
        ),
      ).rejects.toThrow('Unknown commit reference in group "Bad Group": nonexistent');
    });

    test("throws on non-contiguous group commits", async () => {
      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "First" });
      await repo.commit({ message: "Second" }); // Middle commit, not in group
      const hash3 = await repo.commit({ message: "Third" });

      // Try to group commits 1 and 3, skipping commit 2
      expect(
        applyGroupSpec(
          {
            groups: [{ commits: [hash1, hash3], name: "Non-Contiguous Group" }],
          },
          { cwd: repo.path },
        ),
      ).rejects.toThrow('Group "Non-Contiguous Group" has non-contiguous commits');
    });

    test("replaces existing group trailers instead of accumulating", async () => {
      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "First" });
      const hash2 = await repo.commit({ message: "Second" });

      // Apply first group
      const result1 = await applyGroupSpec(
        {
          groups: [{ commits: [hash1, hash2], name: "Original Group" }],
        },
        { cwd: repo.path },
      );
      expect(result1.success).toBe(true);

      // Get new hashes after rebase
      let commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);
      const newHash1 = commits[0]!.hash;
      const newHash2 = commits[1]!.hash;
      const originalGroupId = commits[0]!.trailers["Spry-Group"];
      expect(originalGroupId).toBeDefined();

      // Verify first group was applied (title in ref storage)
      let titles = await readGroupTitles({ cwd: repo.path });
      expect(titles[originalGroupId!]).toBe("Original Group");

      // Apply different group to same commits
      const result2 = await applyGroupSpec(
        {
          groups: [{ commits: [newHash1, newHash2], name: "New Group" }],
        },
        { cwd: repo.path },
      );
      expect(result2.success).toBe(true);

      // Verify trailers were replaced, not accumulated
      commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);

      // New group should have a new ID
      const newGroupId = commits[0]!.trailers["Spry-Group"];
      expect(newGroupId).toBeDefined();

      // Should only have the new group title in ref storage
      titles = await readGroupTitles({ cwd: repo.path });
      expect(titles[newGroupId!]).toBe("New Group");

      // Check the commit message doesn't have duplicate trailers
      const { $ } = await import("bun");
      const message = await $`git -C ${repo.path} log -1 --format=%B ${commits[0]!.hash}`.text();
      const groupMatches = message.match(/Spry-Group:/g);
      expect(groupMatches).toHaveLength(1); // Only one group trailer
    });

    test("removes group trailers when no new groups specified", async () => {
      await repo.branch("feature");
      const hash1 = await repo.commit({ message: "First" });

      // Apply group
      await applyGroupSpec(
        {
          groups: [{ commits: [hash1], name: "Temporary Group" }],
        },
        { cwd: repo.path },
      );

      let commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const groupId = commits[0]!.trailers["Spry-Group"];
      expect(groupId).toBeDefined();

      // Verify title in ref storage
      let titles = await readGroupTitles({ cwd: repo.path });
      expect(titles[groupId!]).toBe("Temporary Group");

      // Apply empty spec (should remove group trailers)
      await applyGroupSpec(
        {
          groups: [],
        },
        { cwd: repo.path },
      );

      // Verify trailers were removed
      commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits[0]!.trailers["Spry-Group"]).toBeUndefined();
    });
  });

  describe("dissolveGroup", () => {
    test("dissolves a multi-commit group", async () => {
      // Use the withGroups scenario
      await scenarios.withGroups.setup(repo);

      // Verify the group exists before dissolving
      let commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(3);
      expect(commits[0]!.trailers["Spry-Group"]).toBe("group-abc");
      expect(commits[0]!.trailers["Spry-Group-Title"]).toBe("Feature Group");
      expect(commits[1]!.trailers["Spry-Group"]).toBe("group-abc");

      // Dissolve the group
      const result = await dissolveGroup("group-abc", { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify group trailers were removed
      commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(3);

      // First and second commits should have no group trailers
      expect(commits[0]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[0]!.trailers["Spry-Group-Title"]).toBeUndefined();
      expect(commits[1]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[1]!.trailers["Spry-Group-Title"]).toBeUndefined();

      // Third commit was never in a group, should be unchanged
      expect(commits[2]!.trailers["Spry-Commit-Id"]).toBe("std00001");

      // parseStack should now see 3 individual units, not a group
      const parsed = parseStack(commits);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.units).toHaveLength(3);
        expect(parsed.units.every((u) => u.type === "single")).toBe(true);
      }
    });

    test("dissolves a single-commit group", async () => {
      await repo.branch("feature");
      await repo.commit({
        message: "Single commit group",
        trailers: {
          "Spry-Commit-Id": "single01",
          "Spry-Group": "single-group",
          "Spry-Group-Title": "Single Group",
        },
      });

      // Verify group exists
      let commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits[0]!.trailers["Spry-Group"]).toBe("single-group");

      // Dissolve
      const result = await dissolveGroup("single-group", { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify trailers removed
      commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits[0]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[0]!.trailers["Spry-Group-Title"]).toBeUndefined();
      // Spry-Commit-Id should remain
      expect(commits[0]!.trailers["Spry-Commit-Id"]).toBe("single01");
    });

    test("returns error for non-existent group", async () => {
      await repo.branch("feature");
      await repo.commit({ message: "Regular commit" });

      const result = await dissolveGroup("nonexistent", { cwd: repo.path });
      expect(result.success).toBe(false);
      expect(result.error).toContain("nonexistent");
      expect(result.error).toContain("not found");
    });

    test("only removes trailers for the specified group", async () => {
      await repo.branch("feature");
      // Create two groups
      await repo.commit({
        message: "Group A commit 1",
        trailers: {
          "Spry-Group": "group-a",
          "Spry-Group-Title": "Group A",
        },
      });
      await repo.commit({
        message: "Group B commit 1",
        trailers: {
          "Spry-Group": "group-b",
          "Spry-Group-Title": "Group B",
        },
      });

      // Dissolve only group-a
      const result = await dissolveGroup("group-a", { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify group-a is dissolved but group-b remains
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);

      // First commit (was group-a) should have no group trailers
      expect(commits[0]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[0]!.trailers["Spry-Group-Title"]).toBeUndefined();

      // Second commit (group-b) should still have its trailers
      expect(commits[1]!.trailers["Spry-Group"]).toBe("group-b");
      expect(commits[1]!.trailers["Spry-Group-Title"]).toBe("Group B");
    });

    test("keeps original IDs when dissolving without assignGroupIdToCommit (no open PR)", async () => {
      await repo.branch("feature");
      const donorId = "donor-id-123";

      // Create a group where the group ID matches a commit's Spry-Commit-Id
      // This simulates what happens when a group "adopts" a commit's existing PR
      await repo.commit({
        message: "Commit that donated ID to group",
        trailers: {
          "Spry-Commit-Id": donorId,
          "Spry-Group": donorId, // Group ID matches commit ID = donated PR
        },
      });
      await repo.commit({
        message: "Second commit in group",
        trailers: {
          "Spry-Commit-Id": "other-id-456",
          "Spry-Group": donorId, // Same group, different commit ID
        },
      });

      // Verify initial state
      let commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);
      expect(commits[0]!.trailers["Spry-Commit-Id"]).toBe(donorId);
      expect(commits[0]!.trailers["Spry-Group"]).toBe(donorId);
      expect(commits[1]!.trailers["Spry-Commit-Id"]).toBe("other-id-456");
      expect(commits[1]!.trailers["Spry-Group"]).toBe(donorId);

      // Dissolve the group without specifying assignGroupIdToCommit
      // (simulating no open PR - all commits keep their IDs)
      const result = await dissolveGroup(donorId, { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify results after dissolve
      commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);

      // First commit (donated its ID to group) KEEPS its ID (no conflict when no PR)
      expect(commits[0]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[0]!.trailers["Spry-Commit-Id"]).toBe(donorId); // Same ID!

      // Second commit keeps its original ID
      expect(commits[1]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[1]!.trailers["Spry-Commit-Id"]).toBe("other-id-456"); // Same ID
    });

    test("keeps Spry-Commit-Id when dissolving a group with a different group ID", async () => {
      await repo.branch("feature");

      // Create a group where the group ID is different from all commit IDs
      // This is the normal case - group ID was auto-generated
      await repo.commit({
        message: "First commit in group",
        trailers: {
          "Spry-Commit-Id": "commit-id-111",
          "Spry-Group": "generated-group-id",
        },
      });
      await repo.commit({
        message: "Second commit in group",
        trailers: {
          "Spry-Commit-Id": "commit-id-222",
          "Spry-Group": "generated-group-id",
        },
      });

      // Dissolve the group
      const result = await dissolveGroup("generated-group-id", { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify both commits keep their original IDs
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);

      expect(commits[0]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[0]!.trailers["Spry-Commit-Id"]).toBe("commit-id-111"); // Same ID

      expect(commits[1]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[1]!.trailers["Spry-Commit-Id"]).toBe("commit-id-222"); // Same ID
    });

    test("allows a specific commit to inherit the group ID via assignGroupIdToCommit", async () => {
      await repo.branch("feature");
      const groupId = "group-id-xyz";

      // Create a group with two commits
      await repo.commit({
        message: "First commit in group",
        trailers: {
          "Spry-Commit-Id": "commit-id-aaa",
          "Spry-Group": groupId,
        },
      });
      const hash2 = await repo.commit({
        message: "Second commit in group",
        trailers: {
          "Spry-Commit-Id": "commit-id-bbb",
          "Spry-Group": groupId,
        },
      });

      // Dissolve the group, specifying that the SECOND commit should be assigned the group ID
      const result = await dissolveGroup(groupId, {
        cwd: repo.path,
        assignGroupIdToCommit: hash2,
      });
      expect(result.success).toBe(true);

      // Verify the results
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);

      // First commit keeps its original ID
      expect(commits[0]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[0]!.trailers["Spry-Commit-Id"]).toBe("commit-id-aaa");

      // Second commit now has the GROUP ID as its commit ID (inheriting the PR)
      expect(commits[1]!.trailers["Spry-Group"]).toBeUndefined();
      expect(commits[1]!.trailers["Spry-Commit-Id"]).toBe(groupId); // Inherited!
    });

    test("donor commit gets new ID when a different commit is assigned the group ID", async () => {
      await repo.branch("feature");
      const groupId = "donor-group-id";

      // Create a group where first commit donated its ID (ID matches group ID)
      await repo.commit({
        message: "Donor commit (ID matches group)",
        trailers: {
          "Spry-Commit-Id": groupId, // Same as group ID - this commit donated it
          "Spry-Group": groupId,
        },
      });
      const hash2 = await repo.commit({
        message: "Second commit",
        trailers: {
          "Spry-Commit-Id": "other-id-456",
          "Spry-Group": groupId,
        },
      });

      // Dissolve, assigning the group ID to the SECOND commit (not the donor)
      const result = await dissolveGroup(groupId, {
        cwd: repo.path,
        assignGroupIdToCommit: hash2,
      });
      expect(result.success).toBe(true);

      // Verify results
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);

      // First commit (donor) gets a NEW ID because second commit is taking the group ID
      expect(commits[0]!.trailers["Spry-Commit-Id"]).toBeDefined();
      expect(commits[0]!.trailers["Spry-Commit-Id"]).not.toBe(groupId); // New ID!

      // Second commit now has the group ID (inherits the PR)
      expect(commits[1]!.trailers["Spry-Commit-Id"]).toBe(groupId);
    });

    test("donor commit keeps its ID when it is assigned the group ID", async () => {
      await repo.branch("feature");
      const groupId = "shared-id-123";

      // Create a group where first commit's ID matches the group ID
      const hash1 = await repo.commit({
        message: "First commit (ID matches group)",
        trailers: {
          "Spry-Commit-Id": groupId, // Same as group ID
          "Spry-Group": groupId,
        },
      });
      await repo.commit({
        message: "Second commit",
        trailers: {
          "Spry-Commit-Id": "other-id-456",
          "Spry-Group": groupId,
        },
      });

      // Dissolve, assigning the group ID to the donor commit (no change needed)
      const result = await dissolveGroup(groupId, {
        cwd: repo.path,
        assignGroupIdToCommit: hash1,
      });
      expect(result.success).toBe(true);

      // Verify results
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      expect(commits).toHaveLength(2);

      // First commit keeps the group ID (it was already its ID)
      expect(commits[0]!.trailers["Spry-Commit-Id"]).toBe(groupId);

      // Second commit keeps its original ID
      expect(commits[1]!.trailers["Spry-Commit-Id"]).toBe("other-id-456");
    });
  });

  describe("addGroupTrailers", () => {
    test("adds Spry-Group trailer and saves title to ref storage", async () => {
      await scenarios.multiCommitStack.setup(repo);

      // Get commits
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const firstCommit = commits[0];
      expect(firstCommit).toBeDefined();

      // Add group trailers to the first commit
      const result = await addGroupTrailers(
        firstCommit!.hash,
        "test-group-id",
        "Test Group Title",
        { cwd: repo.path },
      );
      expect(result.success).toBe(true);

      // Verify the Spry-Group trailer was added
      const { $ } = await import("bun");
      const afterTrailers = await $`git -C ${repo.path} log --format=%s%n%b--- HEAD~3..HEAD`.text();
      expect(afterTrailers).toContain("Spry-Group: test-group-id");

      // Verify title was saved to ref storage
      const titles = await readGroupTitles({ cwd: repo.path });
      expect(titles["test-group-id"]).toBe("Test Group Title");
    });
  });

  describe("removeGroupTrailers", () => {
    test("removes Spry-Group trailer from a commit", async () => {
      await scenarios.withGroups.setup(repo);

      // Get commits and find one with group trailers
      const commits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const groupCommit = commits.find((c) => c.trailers["Spry-Group"]);
      expect(groupCommit).toBeDefined();
      const groupId = groupCommit!.trailers["Spry-Group"];
      expect(groupId).toBeDefined();

      // Remove the group trailers
      const result = await removeGroupTrailers(groupCommit!.hash, groupId!, { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify group trailers were removed from that commit
      const newCommits = await getStackCommitsWithTrailers({ cwd: repo.path });
      const updatedCommit = newCommits.find(
        (c) => c.subject === groupCommit!.subject && !c.trailers["Spry-Group"],
      );
      expect(updatedCommit).toBeDefined();
      // Commit IDs should still be there
      expect(updatedCommit!.trailers["Spry-Commit-Id"]).toBeDefined();
    });
  });

  describe("mergeSplitGroup", () => {
    test("reorders commits to merge a split group", async () => {
      await scenarios.splitGroup.setup(repo);

      // Verify the stack is initially invalid (split group)
      const commitsBefore = await getStackCommitsWithTrailers({ cwd: repo.path });
      const validationBefore = parseStack(commitsBefore);
      expect(validationBefore).toMatchObject({ ok: false, error: "split-group" });

      // Merge the split group
      const result = await mergeSplitGroup("group-split", { cwd: repo.path });
      expect(result.success).toBe(true);

      // Verify title was saved to ref storage (falls back to first commit subject)
      const titlesAfter = await readGroupTitles({ cwd: repo.path });
      expect(titlesAfter["group-split"]).toContain("First grouped commit");

      // Verify the stack is now valid
      const commitsAfter = await getStackCommitsWithTrailers({ cwd: repo.path });
      const validationAfter = parseStack(commitsAfter, titlesAfter);
      expect(validationAfter.ok).toBe(true);

      // Verify the group commits are now contiguous and ID is preserved
      if (validationAfter.ok) {
        const groupUnit = validationAfter.units.find(
          (u) => u.type === "group" && u.id === "group-split",
        );
        expect(groupUnit).toMatchObject({ type: "group", id: "group-split" });
        expect(groupUnit!.title).toContain("First grouped commit");
        expect(groupUnit!.commits).toHaveLength(2);
      }
    });
  });
});
