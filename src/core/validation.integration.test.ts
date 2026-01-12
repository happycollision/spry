import { describe, test, expect, beforeEach } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getBranchName, getBranchNameConfig } from "../github/branches.ts";
import { createPR } from "../github/pr.ts";

describe("validation integration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "spry-validation-test-"));

    // Initialize git repo
    await $`git -C ${testDir} init`.quiet();
    await $`git -C ${testDir} config user.name "Test User"`.quiet();
    await $`git -C ${testDir} config user.email "test@example.com"`.quiet();

    // Create a commit so we have a proper repo
    await $`touch ${join(testDir, "README.md")}`;
    await $`git -C ${testDir} add .`.quiet();
    await $`git -C ${testDir} commit -m "Initial commit"`.quiet();
  });

  test("getBranchName validates generated branch names", () => {
    const validId = "a1b2c3d4";
    const config = { prefix: "spry", username: "testuser" };

    // Should succeed with valid inputs
    const branchName = getBranchName(validId, config);
    expect(branchName).toBe("spry/testuser/a1b2c3d4");
  });

  test("getBranchName rejects invalid characters in prefix", () => {
    const config = { prefix: "spry..bad", username: "testuser" };

    expect(() => {
      getBranchName("a1b2c3d4", config);
    }).toThrow("Invalid branch name");
  });

  test("getBranchName rejects invalid characters in username", () => {
    const config = { prefix: "spry", username: "test^user" };

    expect(() => {
      getBranchName("a1b2c3d4", config);
    }).toThrow("Invalid branch name");
  });

  test("createPR validates empty title", async () => {
    // This test will fail at validation before even attempting to call gh
    await expect(
      createPR({
        title: "",
        head: "test-branch",
        base: "main",
      }),
    ).rejects.toThrow("cannot be empty");
  });

  test("createPR validates title with control characters", async () => {
    await expect(
      createPR({
        title: "Bad title\x00with null",
        head: "test-branch",
        base: "main",
      }),
    ).rejects.toThrow("control characters");
  });

  test("createPR validates title that is too long", async () => {
    const longTitle = "a".repeat(501);

    await expect(
      createPR({
        title: longTitle,
        head: "test-branch",
        base: "main",
      }),
    ).rejects.toThrow("too long");
  });
});
