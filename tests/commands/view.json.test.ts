// tests/commands/view.json.test.ts
import { test, expect, afterAll } from "bun:test";
import { viewCommand } from "../../src/commands/view.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { SpryContext, TestRepo } from "../lib/index.ts";
import { captureLogs } from "../lib/capture.ts";
import { savePRCache } from "../../src/gh/pr-cache.ts";
import type { PRCache } from "../../src/gh/pr-cache.ts";

const repos: TestRepo[] = [];
afterAll(async () => {
  while (repos.length) await repos.pop()!.cleanup();
});

function makeCtx(repo: TestRepo): SpryContext {
  const git = createRealGitRunner();
  return {
    git: { run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }) },
    gh: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }, // stub: proves no gh
  };
}

async function configuredRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const g = createRealGitRunner();
  await g.run(["config", "spry.trunk", repo.defaultBranch], { cwd: repo.path });
  await g.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await g.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
  return repo;
}

test("sp view --json emits a nested tree with seeded PR state, no gh", async () => {
  const repo = await configuredRepo();
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");

  const cache: PRCache = {
    aaaaaaaa: {
      branch: "spry/test/aaaaaaaa",
      cachedAt: "2026-01-01T00:00:00.000Z",
      number: 42,
      url: "",
      state: "OPEN",
      title: "feat: a",
      baseRefName: repo.defaultBranch,
      checksStatus: "none",
      reviewDecision: "none",
      reviewThreads: { resolved: 0, total: 0 },
    },
  };
  await savePRCache(repo.git, cache, { cwd: repo.path });

  const ctx = makeCtx(repo);
  const logs = await captureLogs("view-json");
  try {
    await viewCommand(ctx, { cwd: repo.path, json: true });
  } finally {
    logs.restore();
  }

  const parsed = JSON.parse(logs.out.join("\n"));
  expect(parsed.stack).toHaveLength(1);
  expect(parsed.stack[0]).toMatchObject({ type: "commit", id: "aaaaaaaa", subject: "feat: a" });
  expect(parsed.stack[0].pr).toEqual({ number: 42, state: "OPEN" });
});

test("sp view --json emits pr:null for a commit with no cached PR", async () => {
  const repo = await configuredRepo();
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");
  // no cache seeded
  const ctx = makeCtx(repo);
  const logs = await captureLogs("view-json-null");
  try {
    await viewCommand(ctx, { cwd: repo.path, json: true });
  } finally {
    logs.restore();
  }
  const parsed = JSON.parse(logs.out.join("\n"));
  expect(parsed.stack[0].pr).toBeNull();
});
