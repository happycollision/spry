import { test, expect, afterAll } from "bun:test";
import { $ } from "bun";
import { stat } from "node:fs/promises";
import { createRepo } from "./repo.ts";
import type { TestRepo } from "./repo.ts";
import { createSeededRng } from "./unique-id.ts";

const repos: TestRepo[] = [];

// afterAll, not afterEach: under --concurrent an afterEach would delete repos
// out from under still-running sibling tests.
afterAll(async () => {
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

test("deterministic commits produce identical SHAs across repos", async () => {
  const r1 = await tracked(await createRepo({ uniqueIdRng: createSeededRng("sha-stability") }));
  const s1 = await r1.commit("Add login");
  const r2 = await tracked(await createRepo({ uniqueIdRng: createSeededRng("sha-stability") }));
  const s2 = await r2.commit("Add login");
  expect(r1.uniqueId).toBe(r2.uniqueId);
  expect(s1).toBe(s2);
});

test("repo.git produces identical SHAs across seeded repos", async () => {
  const rng = () => createSeededRng("git-runner-stability");
  const r1 = await tracked(await createRepo({ uniqueIdRng: rng() }));
  await r1.git.run(["commit", "--allow-empty", "-m", "Pinned commit"]);
  const s1 = (await r1.git.run(["rev-parse", "HEAD"])).stdout.trim();

  const r2 = await tracked(await createRepo({ uniqueIdRng: rng() }));
  await r2.git.run(["commit", "--allow-empty", "-m", "Pinned commit"]);
  const s2 = (await r2.git.run(["rev-parse", "HEAD"])).stdout.trim();

  expect(s1).toBe(s2);
});

test("cleanup removes temp directories", async () => {
  const repo = await createRepo();
  const { path, originPath } = repo;

  await repo.cleanup();

  await expect(stat(path)).rejects.toThrow();
  await expect(stat(originPath)).rejects.toThrow();
});
