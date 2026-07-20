import { describe, test, expect, afterAll } from "bun:test";
import { loadPRCache, savePRCache, fetchPRCache, pushPRCache } from "../../src/gh/pr-cache.ts";
import type { PRCacheEntry } from "../../src/gh/pr-cache.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];
const git = createRealGitRunner();

// afterAll, not afterEach: under --concurrent a per-test cleanup hook would delete
// repos out from under still-running sibling tests.
afterAll(async () => {
  while (repos.length > 0) await repos.pop()!.cleanup();
});

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  return repo;
}

function makeEntry(overrides: Partial<PRCacheEntry> = {}): PRCacheEntry {
  return {
    branch: "spry/test/aaa11111",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    state: "OPEN",
    title: "Add login",
    baseRefName: "main",
    checksStatus: "passing",
    reviewDecision: "none",
    reviewThreads: { resolved: 0, total: 0 },
    cachedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

function fakeGit(result: { stdout: string; stderr: string; exitCode: number }) {
  return {
    async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
      return result;
    },
  };
}

describe("loadPRCache", () => {
  test("returns empty object when no cache stored", async () => {
    const repo = await makeRepo();
    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(cache).toEqual({});
  });
});

describe("savePRCache + loadPRCache", () => {
  test("round-trips a single entry", async () => {
    const repo = await makeRepo();
    const entry = makeEntry();
    await savePRCache(git, { aaa11111: entry }, { cwd: repo.path });

    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(cache["aaa11111"]).toEqual(entry);
  });

  test("round-trips multiple entries", async () => {
    const repo = await makeRepo();
    const e1 = makeEntry({ branch: "spry/test/aaa11111", number: 1 });
    const e2 = makeEntry({ branch: "spry/test/bbb22222", number: 2, state: "MERGED" });
    await savePRCache(git, { aaa11111: e1, bbb22222: e2 }, { cwd: repo.path });

    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(cache["aaa11111"]?.number).toBe(1);
    expect(cache["bbb22222"]?.state).toBe("MERGED");
  });

  test("overwrites entire cache on second save", async () => {
    const repo = await makeRepo();
    await savePRCache(git, { aaa11111: makeEntry({ number: 1 }) }, { cwd: repo.path });
    await savePRCache(git, { bbb22222: makeEntry({ number: 2 }) }, { cwd: repo.path });

    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(Object.keys(cache)).toEqual(["bbb22222"]);
  });

  test("empty cache saves and loads cleanly", async () => {
    const repo = await makeRepo();
    await savePRCache(git, {}, { cwd: repo.path });
    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(cache).toEqual({});
  });
});

describe("fetchPRCache", () => {
  test("returns ok when fetch succeeds", async () => {
    const result = await fetchPRCache(fakeGit({ stdout: "", stderr: "", exitCode: 0 }), "origin");
    expect(result.ok).toBe(true);
  });

  test("returns ok when remote has no prs ref", async () => {
    const result = await fetchPRCache(
      fakeGit({ stdout: "", stderr: "couldn't find remote ref refs/spry/prs", exitCode: 128 }),
      "origin",
    );
    expect(result.ok).toBe(true);
  });

  test("returns warning on other fetch failure", async () => {
    const result = await fetchPRCache(
      fakeGit({ stdout: "", stderr: "Connection refused", exitCode: 1 }),
      "origin",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning).toMatch(/Connection refused/);
  });
});

describe("pushPRCache", () => {
  test("returns ok when push succeeds", async () => {
    const result = await pushPRCache(fakeGit({ stdout: "", stderr: "", exitCode: 0 }), "origin");
    expect(result.ok).toBe(true);
  });

  test("returns warning when push fails", async () => {
    const result = await pushPRCache(
      fakeGit({ stdout: "", stderr: "remote: denied", exitCode: 1 }),
      "origin",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning).toMatch(/denied/);
  });
});
