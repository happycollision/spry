import { describe, test, expect, afterAll } from "bun:test";
import {
  loadTrackedBranches,
  saveTrackedBranches,
  registerBranch,
} from "../../src/git/tracked-branches.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];
// afterAll, not afterEach: under --concurrent a per-test cleanup hook would delete
// repos out from under still-running sibling tests.
afterAll(async () => {
  while (repos.length > 0) await repos.pop()!.cleanup();
});

async function makeRepo() {
  const repo = await createRepo();
  repos.push(repo);
  return { repo, git: createRealGitRunner() };
}

describe("loadTrackedBranches", () => {
  test("returns empty array when ref does not exist", async () => {
    const { repo, git } = await makeRepo();
    const result = await loadTrackedBranches(git, { cwd: repo.path });
    expect(result).toEqual([]);
  });
});

describe("saveTrackedBranches / loadTrackedBranches", () => {
  test("round-trips a list of branch names", async () => {
    const { repo, git } = await makeRepo();
    await saveTrackedBranches(git, ["feature-a", "feature-b"], { cwd: repo.path });
    const loaded = await loadTrackedBranches(git, { cwd: repo.path });
    expect(loaded).toEqual(["feature-a", "feature-b"]);
  });

  test("deletes ref when saving empty list", async () => {
    const { repo, git } = await makeRepo();
    await saveTrackedBranches(git, ["feature-a"], { cwd: repo.path });
    await saveTrackedBranches(git, [], { cwd: repo.path });
    const result = await loadTrackedBranches(git, { cwd: repo.path });
    expect(result).toEqual([]);
  });
});

describe("registerBranch", () => {
  test("adds branch when not already tracked", async () => {
    const { repo, git } = await makeRepo();
    await registerBranch(git, "feature-x", { cwd: repo.path });
    const result = await loadTrackedBranches(git, { cwd: repo.path });
    expect(result).toContain("feature-x");
  });

  test("is idempotent — does not duplicate", async () => {
    const { repo, git } = await makeRepo();
    await registerBranch(git, "feature-x", { cwd: repo.path });
    await registerBranch(git, "feature-x", { cwd: repo.path });
    const result = await loadTrackedBranches(git, { cwd: repo.path });
    expect(result.filter((b) => b === "feature-x")).toHaveLength(1);
  });
});
