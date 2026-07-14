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

test("seeded uniqueIdRng produces identical uniqueIds across repos", async () => {
  const r1 = await tracked(await createRepo({ uniqueIdRng: createSeededRng("id-stability") }));
  const r2 = await tracked(await createRepo({ uniqueIdRng: createSeededRng("id-stability") }));
  expect(r1.uniqueId).toBe(r2.uniqueId);
});

// SHAs are intentionally NOT stable across runs (or across repos): commit
// dates come from a per-run base advanced by a process-global counter, so
// every run — and every repo within a run — mints fresh SHAs (GitHub would
// otherwise accumulate check runs on a reused SHA). What must hold instead:
// dates are distinct and monotonically increasing within a repo, giving the
// doc scrubber's date-ordered reflog walk a total order.
test("commit dates are distinct and monotonically increasing within a repo", async () => {
  const repo = await tracked(await createRepo());
  await repo.commit("First");
  await repo.git.run(["commit", "--allow-empty", "-m", "Second"]);
  const log = (await repo.git.run(["log", "--format=%ct", "--reverse", "HEAD"])).stdout.trim();
  const dates = log.split("\n").map(Number);
  expect(dates.length).toBe(3); // initial + 2
  for (let i = 1; i < dates.length; i++) {
    expect(dates[i]!).toBeGreaterThan(dates[i - 1]!);
  }
});

test("identical commit sequences in different repos mint distinct SHAs", async () => {
  const r1 = await tracked(await createRepo({ uniqueIdRng: createSeededRng("cross-repo") }));
  await r1.git.run(["commit", "--allow-empty", "-m", "Same message"]);
  const s1 = (await r1.git.run(["rev-parse", "HEAD"])).stdout.trim();

  const r2 = await tracked(await createRepo({ uniqueIdRng: createSeededRng("cross-repo") }));
  await r2.git.run(["commit", "--allow-empty", "-m", "Same message"]);
  const s2 = (await r2.git.run(["rev-parse", "HEAD"])).stdout.trim();

  // Even with identical uniqueIds, messages, and call sequences, the shared
  // date counter keeps SHAs unique — reusing a SHA on GitHub accumulates
  // check runs across PRs (the land readiness-gate trap).
  expect(s1).not.toBe(s2);
});

test("cleanup removes temp directories", async () => {
  const repo = await createRepo();
  const { path, originPath } = repo;

  await repo.cleanup();

  await expect(stat(path)).rejects.toThrow();
  await expect(stat(originPath)).rejects.toThrow();
});
