# PR Cache via `refs/spry/prs` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Store GitHub PR info in `refs/spry/prs` so `sp view` reads PR status instantly from a local git ref instead of hitting the GitHub API, and `sp sync` keeps the cache up to date.

**Architecture:** A new `src/gh/pr-cache.ts` module mirrors the `group-titles.ts` pattern — one blob per unit ID in a commit-tree at `refs/spry/prs`, containing `PRInfo` plus `branch` and `cachedAt` fields. `sp sync` fetches all PR info after pushing, writes and pushes the cache. `sp view` reads from the local cache; no `gh` calls during view.

**Tech Stack:** TypeScript, Bun, `bun:test`, real git repos via `tests/lib/index.ts`, same git plumbing as `src/git/group-titles.ts`.

---

### Task 1: Define types and create `src/gh/pr-cache.ts` skeleton

**Files:**

- Create: `src/gh/pr-cache.ts`

The PR cache lives in the `gh/` layer (alongside `PRInfo`) to avoid a cross-layer dependency — `src/git/group-titles.ts` couldn't import `PRInfo` without importing the `gh` layer.

**Step 1: Create the file with types only (no implementation)**

```ts
// src/gh/pr-cache.ts
import type { PRInfo } from "./pr.ts";
import type { GitRunner } from "../lib/context.ts";

export interface PRCacheEntry extends PRInfo {
  branch: string;
  cachedAt: string; // ISO 8601
}

// Keyed by unit ID (e.g. "aaa11111"), NOT branch name — unit IDs have no slashes,
// making them safe as git tree entry names without encoding.
export type PRCache = Record<string, PRCacheEntry>;

export const PR_CACHE_REF = "refs/spry/prs";
```

**Step 2: Commit**

```bash
git add src/gh/pr-cache.ts
git commit -m "feat(pr-cache): add PRCacheEntry type and module skeleton"
```

---

### Task 2: Implement `loadPRCache` with tests

**Files:**

- Modify: `src/gh/pr-cache.ts`
- Create: `tests/gh/pr-cache.test.ts`

`loadPRCache` reads `refs/spry/prs` with `ls-tree` + `cat-file blob`, exactly like `loadGroupRecords`. Returns `{}` when the ref doesn't exist yet.

**Step 1: Write the failing test**

```ts
// tests/gh/pr-cache.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { loadPRCache } from "../../src/gh/pr-cache.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];
const git = createRealGitRunner();

afterEach(async () => {
  while (repos.length > 0) await repos.pop()!.cleanup();
});

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  return repo;
}

describe("loadPRCache", () => {
  test("returns empty object when no cache stored", async () => {
    const repo = await makeRepo();
    const cache = await loadPRCache(git, { cwd: repo.path });
    expect(cache).toEqual({});
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test:docker tests/gh/pr-cache.test.ts`
Expected: FAIL — `loadPRCache is not a function` or import error.

**Step 3: Implement `loadPRCache`**

```ts
// Add to src/gh/pr-cache.ts

interface GitOpts {
  cwd?: string;
  stdin?: string;
}

export async function loadPRCache(git: GitRunner, opts?: GitOpts): Promise<PRCache> {
  const ls = await git.run(["ls-tree", PR_CACHE_REF], opts);
  if (ls.exitCode !== 0) return {};

  const cache: PRCache = {};
  for (const line of ls.stdout.trim().split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const unitId = line.slice(tab + 1);
    const cat = await git.run(["cat-file", "blob", `${PR_CACHE_REF}:${unitId}`], opts);
    if (cat.exitCode !== 0)
      throw new Error(`loadPRCache: cat-file failed for ${unitId}: ${cat.stderr}`);
    try {
      cache[unitId] = JSON.parse(cat.stdout.trim()) as PRCacheEntry;
    } catch {
      // Skip malformed entries
    }
  }
  return cache;
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test:docker tests/gh/pr-cache.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gh/pr-cache.ts tests/gh/pr-cache.test.ts
git commit -m "feat(pr-cache): implement loadPRCache"
```

---

### Task 3: Implement `savePRCache` with tests

**Files:**

- Modify: `src/gh/pr-cache.ts`
- Modify: `tests/gh/pr-cache.test.ts`

`savePRCache` writes the ENTIRE cache atomically (like `saveAllGroupRecords`). Takes a complete `PRCache` and replaces `refs/spry/prs`. Sync always writes the full cache since it fetches all branches.

**Step 1: Write failing tests**

Add to `tests/gh/pr-cache.test.ts`:

```ts
import { savePRCache } from "../../src/gh/pr-cache.ts";
import type { PRCacheEntry } from "../../src/gh/pr-cache.ts";

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
    // Save only bbb22222 — aaa11111 should be gone
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
```

**Step 2: Run to verify failures**

Run: `bun run test:docker tests/gh/pr-cache.test.ts`
Expected: FAIL — `savePRCache is not a function`

**Step 3: Implement `savePRCache`**

```ts
// Add to src/gh/pr-cache.ts

export async function savePRCache(
  git: GitRunner,
  cache: PRCache,
  opts?: GitOpts,
): Promise<void> {
  const entries: string[] = [];

  for (const [unitId, entry] of Object.entries(cache)) {
    const content = JSON.stringify(entry);
    const blob = await git.run(["hash-object", "-w", "--stdin"], { ...opts, stdin: content });
    if (blob.exitCode !== 0)
      throw new Error(`savePRCache: hash-object failed: ${blob.stderr}`);
    entries.push(`100644 blob ${blob.stdout.trim()}\t${unitId}`);
  }

  const treeInput = entries.length > 0 ? entries.join("\n") + "\n" : "";
  const tree = await git.run(["mktree"], { ...opts, stdin: treeInput });
  if (tree.exitCode !== 0) throw new Error(`savePRCache: mktree failed: ${tree.stderr}`);

  const commitArgs = ["commit-tree", tree.stdout.trim(), "-m", "update pr cache"];
  const parent = await git.run(["rev-parse", "--verify", PR_CACHE_REF], opts);
  if (parent.exitCode === 0) commitArgs.push("-p", parent.stdout.trim());
  const commit = await git.run(commitArgs, opts);
  if (commit.exitCode !== 0) throw new Error(`savePRCache: commit-tree failed: ${commit.stderr}`);

  const ref = await git.run(["update-ref", PR_CACHE_REF, commit.stdout.trim()], opts);
  if (ref.exitCode !== 0) throw new Error(`savePRCache: update-ref failed: ${ref.stderr}`);
}
```

**Step 4: Run tests to verify pass**

Run: `bun run test:docker tests/gh/pr-cache.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/gh/pr-cache.ts tests/gh/pr-cache.test.ts
git commit -m "feat(pr-cache): implement savePRCache with round-trip tests"
```

---

### Task 4: Implement `fetchPRCache` and `pushPRCache` with tests

**Files:**

- Modify: `src/gh/pr-cache.ts`
- Modify: `tests/gh/pr-cache.test.ts`

These mirror `fetchGroupRecords` exactly. Fetch uses `git fetch remote refs/spry/prs:refs/spry/prs`. Push uses `git push remote refs/spry/prs:refs/spry/prs`.

**Step 1: Write failing tests using fake git runners**

Add to `tests/gh/pr-cache.test.ts`:

```ts
import { fetchPRCache, pushPRCache } from "../../src/gh/pr-cache.ts";

function fakeGit(result: { stdout: string; stderr: string; exitCode: number }) {
  return {
    async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
      return result;
    },
  };
}

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
```

**Step 2: Run to verify failures**

Run: `bun run test:docker tests/gh/pr-cache.test.ts`
Expected: FAIL — `fetchPRCache is not a function`, `pushPRCache is not a function`

**Step 3: Implement both functions**

```ts
// Add to src/gh/pr-cache.ts

export async function fetchPRCache(
  git: GitRunner,
  remote: string,
  opts?: GitOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const refspec = `${PR_CACHE_REF}:${PR_CACHE_REF}`;
  const result = await git.run(["fetch", remote, refspec], opts);
  if (result.exitCode === 0) return { ok: true };
  if (result.stderr.includes("couldn't find remote ref")) return { ok: true };
  return { ok: false, warning: result.stderr.trim() };
}

export async function pushPRCache(
  git: GitRunner,
  remote: string,
  opts?: GitOpts,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const refspec = `${PR_CACHE_REF}:${PR_CACHE_REF}`;
  const result = await git.run(["push", remote, refspec], opts);
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, warning: result.stderr.trim() };
}
```

**Step 4: Run to verify all pass**

Run: `bun run test:docker tests/gh/pr-cache.test.ts`
Expected: All PASS

**Step 5: Export from `src/gh/index.ts`**

Add to `src/gh/index.ts`:

```ts
export {
  loadPRCache,
  savePRCache,
  fetchPRCache,
  pushPRCache,
  PR_CACHE_REF,
} from "./pr-cache.ts";
export type { PRCacheEntry, PRCache } from "./pr-cache.ts";
```

**Step 6: Commit**

```bash
git add src/gh/pr-cache.ts src/gh/index.ts tests/gh/pr-cache.test.ts
git commit -m "feat(pr-cache): implement fetchPRCache and pushPRCache"
```

---

### Task 5: Update `enrichUnits` to support cache-based enrichment

**Files:**

- Modify: `src/gh/enrich.ts`
- Modify: `tests/gh/enrich.test.ts`

Add a new `enrichFromCache` function that takes a `PRCache` and returns `EnrichedUnit[]` without any network calls. This is what `viewCommand` will use. Keep `enrichUnits` (live fetch) intact for now — sync still needs it.

**Step 1: Write failing test**

Add to `tests/gh/enrich.test.ts`:

```ts
import { enrichFromCache } from "../../src/gh/enrich.ts";
import type { PRCache, PRCacheEntry } from "../../src/gh/pr-cache.ts";

function makeCacheEntry(overrides: Partial<PRCacheEntry> = {}): PRCacheEntry {
  return {
    branch: "spry/test/aaa11111",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    state: "OPEN",
    title: "T",
    baseRefName: "main",
    checksStatus: "passing",
    reviewDecision: "approved",
    reviewThreads: { resolved: 1, total: 1 },
    cachedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("enrichFromCache", () => {
  test("returns null pr for units with no cache entry", () => {
    const result = enrichFromCache([unit("aaa11111"), unit("bbb22222")], {});
    expect(result).toHaveLength(2);
    expect(result[0]!.pr).toBeNull();
    expect(result[1]!.pr).toBeNull();
    expect(result.every((r) => r.error === undefined)).toBe(true);
  });

  test("populates pr from cache for known unit IDs", () => {
    const cache: PRCache = {
      aaa11111: makeCacheEntry({ number: 42 }),
    };
    const result = enrichFromCache([unit("aaa11111"), unit("bbb22222")], cache);
    expect(result[0]!.pr?.number).toBe(42);
    expect(result[1]!.pr).toBeNull();
  });

  test("strips cachedAt/branch before returning PRInfo shape", () => {
    const cache: PRCache = {
      aaa11111: makeCacheEntry({ number: 42 }),
    };
    const result = enrichFromCache([unit("aaa11111")], cache);
    const pr = result[0]!.pr;
    expect(pr).not.toBeNull();
    // PRInfo fields present
    expect(pr?.number).toBe(42);
    expect(pr?.state).toBe("OPEN");
  });
});
```

**Step 2: Run to verify failure**

Run: `bun run test:docker tests/gh/enrich.test.ts`
Expected: FAIL — `enrichFromCache is not a function`

**Step 3: Implement `enrichFromCache` in `src/gh/enrich.ts`**

```ts
// Add to src/gh/enrich.ts
import type { PRCache } from "./pr-cache.ts";

export function enrichFromCache(units: PRUnit[], cache: PRCache): EnrichedUnit[] {
  return units.map((unit) => {
    const entry = cache[unit.id];
    if (!entry) return { unit, pr: null };
    // Strip cache-specific fields to match PRInfo shape
    const { branch: _branch, cachedAt: _cachedAt, ...prInfo } = entry;
    return { unit, pr: prInfo };
  });
}
```

**Step 4: Run to verify pass**

Run: `bun run test:docker tests/gh/enrich.test.ts`
Expected: All PASS

**Step 5: Export from index**

Add to `src/gh/index.ts`:

```ts
export { enrichUnits, enrichFromCache } from "./enrich.ts";
```

(Replace existing `enrichUnits` export line.)

**Step 6: Commit**

```bash
git add src/gh/enrich.ts src/gh/index.ts tests/gh/enrich.test.ts
git commit -m "feat(pr-cache): add enrichFromCache for cache-based view enrichment"
```

---

### Task 6: Update `viewCommand` to use the PR cache

**Files:**

- Modify: `src/commands/view.ts`
- Modify: `tests/commands/view.test.ts`

Change `viewCommand` default behavior: instead of calling `enrichUnits` (live gh), load the PR cache from `refs/spry/prs` and call `enrichFromCache`. No `gh` call ever happens in view. The `--no-fetch` flag now only affects the group records fetch.

**Step 1: Read the tests that will need updating**

Read `tests/commands/view.test.ts` — specifically the test `"default (no --no-fetch) calls gh and falls back gracefully when gh missing"`. This test will need to change: after the update, the default path never calls `gh`, so the test should verify that `gh` is NOT called and the PR info comes from the cache instead.

**Step 2: Write new/updated tests**

Add these tests to `tests/commands/view.test.ts` (keep existing tests, they still describe correct behavior for the non-gh aspects):

```ts
import { savePRCache } from "../../src/gh/pr-cache.ts";
import type { PRCacheEntry } from "../../src/gh/pr-cache.ts";

function makeEntry(overrides: Partial<PRCacheEntry> = {}): PRCacheEntry {
  return {
    branch: "spry/test/aaa11111",
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
    state: "OPEN",
    title: "Add login page",
    baseRefName: "main",
    checksStatus: "passing",
    reviewDecision: "none",
    reviewThreads: { resolved: 0, total: 0 },
    cachedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

test("default view reads PR info from local cache — no gh call", async () => {
  const repo = await repos.create();
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

  await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"], {
    cwd: repo.path,
  });

  // Store PR info in cache
  await savePRCache(git, { aaa11111: makeEntry({ number: 7 }) }, { cwd: repo.path });

  let ghCalled = false;
  const ctx: SpryContext = {
    git: {
      run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }),
    },
    gh: {
      run: async () => {
        ghCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };

  const { stdout, exitCode } = await captureView(ctx);
  const plain = stripAnsi(stdout);

  expect(exitCode).toBe(0);
  expect(ghCalled).toBe(false);
  // PR number from cache appears in output
  expect(plain).toContain("#7");
});

test("default view shows no PR info when cache is empty (no error)", async () => {
  const repo = await repos.create();
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });

  await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
    cwd: repo.path,
  });

  let ghCalled = false;
  const ctx: SpryContext = {
    git: {
      run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }),
    },
    gh: {
      run: async () => {
        ghCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };

  const { stdout, exitCode } = await captureView(ctx);
  expect(exitCode).toBe(0);
  expect(ghCalled).toBe(false);
  // No crash, just no PR number shown
  expect(stripAnsi(stdout)).toContain("○ C");
});
```

Also **update** the existing test `"default (no --no-fetch) calls gh and falls back gracefully when gh missing"` — its title and assertion need to change. Rename it to `"default view never calls gh (cache used instead)"` and flip the assertion: `expect(ghCalled).toBe(false)` and verify view still renders the stack.

**Step 3: Run tests to verify failures**

Run: `bun run test:docker tests/commands/view.test.ts`
Expected: new tests FAIL, updated existing test FAIL (currently view calls gh)

**Step 4: Update `viewCommand` in `src/commands/view.ts`**

Replace the `enrichUnits` call with `loadPRCache` + `enrichFromCache`:

```ts
// Remove: import { enrichUnits } from "../gh/enrich.ts";
// Add:
import { enrichFromCache } from "../gh/enrich.ts";
import { loadPRCache } from "../gh/pr-cache.ts";

// In viewCommand, replace the enriched block:
//
// OLD:
//   const enriched: EnrichedUnit[] = opts.noFetch
//     ? result.units.map((unit) => ({ unit, pr: null }))
//     : await enrichUnits(ctx, result.units, config);
//
// NEW:
const prCache = opts.noFetch ? {} : await loadPRCache(ctx.git);
const enriched = enrichFromCache(result.units, prCache);
```

Also remove the `gh` import from the function signature (context — `ctx.gh` is no longer used in view at all).

**Step 5: Run tests to verify pass**

Run: `bun run test:docker tests/commands/view.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/commands/view.ts tests/commands/view.test.ts
git commit -m "feat(pr-cache): view reads from refs/spry/prs cache instead of live gh"
```

---

### Task 7: Update `syncCommand` to populate the PR cache

**Files:**

- Modify: `src/commands/sync.ts`
- Modify: `tests/commands/sync.test.ts`

After pushing and opening PRs, sync fetches PR info for **all** branches in the stack (not just pushed ones), writes the full cache to `refs/spry/prs`, and pushes it. Also fetch the remote cache ref at startup alongside group records.

**Step 1: Write failing tests**

Add to `tests/commands/sync.test.ts`:

```ts
import { loadPRCache } from "../../src/gh/pr-cache.ts";

test("sync writes PR info to refs/spry/prs after successful run", async () => {
  const repo = await makeRepoWithConfig();
  const git = createRealGitRunner();

  // Set up a branch with a published remote counterpart
  await git.run(["checkout", "-b", "spry/test/aaa11111"], { cwd: repo.path });
  await git.run(
    ["commit", "--allow-empty", "-m", "Add login\n\nSpry-Commit-Id: aaa11111"],
    { cwd: repo.path },
  );

  // Simulate: remote already has this branch (so push runs)
  // We do this by making a bare clone and treating it as origin
  // ... (use the existing makeRepoWithConfig + remote setup pattern from sync.test.ts)

  const { gh, calls } = stubGh((call) => {
    if (call.args[0] === "api" && call.args[1] === "graphql") {
      // Return a PR for this branch
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                nodes: [{
                  number: 5,
                  url: "https://github.com/owner/repo/pull/5",
                  state: "OPEN",
                  title: "Add login",
                  baseRefName: "main",
                  reviewDecision: null,
                  reviewThreads: { totalCount: 0, nodes: [] },
                  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                }],
              },
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });

  const ctx = makeCtx(repo, gh);
  // ... run sync ...

  // Verify PR cache was written
  const cache = await loadPRCache(git, { cwd: repo.path });
  expect(cache["aaa11111"]?.number).toBe(5);
  expect(cache["aaa11111"]?.state).toBe("OPEN");
  expect(cache["aaa11111"]?.cachedAt).toBeDefined();
});
```

Note: The exact test setup requires the same remote setup pattern used in other sync tests. Look at the existing sync tests for how they set up a remote. Follow that pattern.

**Step 2: Run to verify failure**

Run: `bun run test:docker tests/commands/sync.test.ts`
Expected: New tests FAIL — cache is empty after sync

**Step 3: Update `syncCommand` — fetch cache at startup**

In `syncCommand`, add after the group records fetch:

```ts
// Fetch PR cache from remote (soft failure — cache is a convenience)
const prCacheFetch = await fetchPRCache(ctx.git, config.remote, { cwd });
if (!prCacheFetch.ok) {
  console.log(kleur.dim(`⚠ Could not fetch PR cache: ${prCacheFetch.warning}`));
}
```

Add import: `import { fetchPRCache, savePRCache, pushPRCache } from "../gh/pr-cache.ts";`

**Step 4: Update `syncCommand` — write cache after PR operations**

After the `retargetMismatched` call, add a new step:

```ts
// Refresh PR cache for all branches in the stack
await refreshPRCache(ctx, config, units, cwd);
```

Implement `refreshPRCache` as a private async function in `sync.ts`:

```ts
async function refreshPRCache(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  cwd: string | undefined,
): Promise<void> {
  if (units.length === 0) return;

  const branches = units.map((u) => branchForUnit(u, config));
  let prMap: Map<string, PRInfo | null>;
  try {
    prMap = await findPRsForBranches(ctx, branches, { cwd });
  } catch (err) {
    // gh unavailable — skip cache update silently
    const hint = retargetingFallbackHint(err);
    console.log(kleur.dim(`⚠ PR cache not updated: ${hint.replace("PR retargeting unavailable", "gh unavailable")}`));
    return;
  }

  const now = new Date().toISOString();
  const cache: PRCache = {};
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    const pr = prMap.get(branch);
    if (pr) {
      cache[unit.id] = { ...pr, branch, cachedAt: now };
    }
  }

  try {
    await savePRCache(ctx.git, cache, { cwd });
    const pushResult = await pushPRCache(ctx.git, config.remote, { cwd });
    if (!pushResult.ok) {
      console.log(kleur.dim(`⚠ Could not push PR cache: ${pushResult.warning}`));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(kleur.dim(`⚠ Could not save PR cache: ${message}`));
  }
}
```

Add import: `import type { PRCache } from "../gh/pr-cache.ts";`

**Step 5: Consolidate `findPRsForBranches` calls**

The `retargetMismatched` function currently calls `findPRsForBranches` internally. Now that `refreshPRCache` also calls it for all branches, we can refactor: call `findPRsForBranches` once for all branches, pass the result map to both `retargetMismatched` and `refreshPRCache`. This halves the API calls.

Refactor `retargetMismatched` to accept a pre-fetched `Map<string, PRInfo | null>` parameter instead of fetching internally. Update its signature:

```ts
async function retargetMismatched(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  branches: string[],
  prMap: Map<string, PRInfo | null>,  // pre-fetched
  cwd: string | undefined,
): Promise<boolean>
```

Remove the internal `findPRsForBranches` call. In `syncCommand`, the call sequence becomes:

```ts
// 6. Retarget + cache: fetch PR info once for all branches
const allBranches = units.map((u) => branchForUnit(u, config));
let prMap: Map<string, PRInfo | null> | undefined;
try {
  prMap = await findPRsForBranches(ctx, allBranches, { cwd });
} catch (err) {
  const hint = retargetingFallbackHint(err);
  console.log(kleur.dim(`${hint} (branches still updated)`));
}

const retargetBranches = [...pushResult.pushed, ...openedBranches];
const retargetHadFailure = prMap
  ? await retargetMismatched(ctx, config, units, retargetBranches, prMap, cwd)
  : false;

if (prMap) {
  await writePRCache(ctx, config, units, prMap, cwd);
}
```

Where `writePRCache` is the cache-write portion extracted from `refreshPRCache`:

```ts
async function writePRCache(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  prMap: Map<string, PRInfo | null>,
  cwd: string | undefined,
): Promise<void> {
  const now = new Date().toISOString();
  const cache: PRCache = {};
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    const pr = prMap.get(branch);
    if (pr) cache[unit.id] = { ...pr, branch, cachedAt: now };
  }
  try {
    await savePRCache(ctx.git, cache, { cwd });
    const push = await pushPRCache(ctx.git, config.remote, { cwd });
    if (!push.ok) console.log(kleur.dim(`⚠ Could not push PR cache: ${push.warning}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(kleur.dim(`⚠ Could not save PR cache: ${message}`));
  }
}
```

**Step 6: Run all sync tests**

Run: `bun run test:docker tests/commands/sync.test.ts`
Expected: All PASS (existing retarget tests may need updating if `retargetMismatched` signature changed — update call sites)

**Step 7: Run all tests**

Run: `bun run test:docker`
Expected: All PASS

**Step 8: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "feat(pr-cache): sync writes refs/spry/prs cache after PR operations"
```

---

### Task 8: Update CHANGELOG

**Files:**

- Modify: `CHANGELOG.md`

Add under `## [Unreleased]` → `### Added`:

```markdown
- PR status cache stored in `refs/spry/prs`: `sp sync` now writes GitHub PR info (number, URL, state, checks, review decision) to a local git ref after each sync, and pushes it to the remote so teammates and CI get PR status without `gh` auth. `sp view` reads from this cache — no GitHub API calls during view.
```

**Step 1: Edit CHANGELOG.md and add the entry**

**Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "chore: update changelog for PR cache feature"
```
