import { test, expect, afterEach } from "bun:test";
import { $ } from "bun";
import { stat } from "node:fs/promises";
import { createRepo } from "./repo.ts";
import type { TestRepo } from "./repo.ts";

const repos: TestRepo[] = [];

afterEach(async () => {
  for (const repo of repos) await repo.cleanup();
  repos.length = 0;
});

async function tracked(repo: TestRepo): Promise<TestRepo> {
  repos.push(repo);
  return repo;
}

test("creates a local repo with bare origin", async () => {
  const repo = await tracked(await createRepo());

  // Working directory exists
  const workStat = await stat(repo.path);
  expect(workStat.isDirectory()).toBe(true);

  // Origin exists
  const originStat = await stat(repo.originPath);
  expect(originStat.isDirectory()).toBe(true);

  // Is a git repo
  const result = await $`git -C ${repo.path} rev-parse --git-dir`.quiet().text();
  expect(result.trim()).toBe(".git");
});

test("has initial commit on main", async () => {
  const repo = await tracked(await createRepo());

  const branch = await repo.currentBranch();
  expect(branch).toBe("main");

  const log = await $`git -C ${repo.path} log --oneline`.quiet().text();
  expect(log.trim()).toContain("Initial commit");
});

test("commit creates unique files", async () => {
  const repo = await tracked(await createRepo());
  await repo.commit("First");
  await repo.commit("Second");

  const log = await $`git -C ${repo.path} log --oneline`.quiet().text();
  const lines = log.trim().split("\n");
  expect(lines.length).toBe(3); // initial + 2
});

test("branch creates and checks out new branch", async () => {
  const repo = await tracked(await createRepo());
  const branchName = await repo.branch("feature");

  const current = await repo.currentBranch();
  expect(current).toBe(branchName);
  expect(branchName).toContain("feature");
  expect(branchName).toContain(repo.uniqueId);
});

test("cleanup removes temp directories", async () => {
  const repo = await createRepo();
  const { path, originPath } = repo;

  await repo.cleanup();

  expect(stat(path)).rejects.toThrow();
  expect(stat(originPath)).rejects.toThrow();
});
