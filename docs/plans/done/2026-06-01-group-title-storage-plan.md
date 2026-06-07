# Group Title Storage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the git-config group title storage with a portable metadata commit tree at `refs/spry/groups`, and wire it into `sp sync` so group PRs get correct titles and `--open <group-id>` works.

**Architecture:** `refs/spry/groups` is a real git commit whose tree has one file per group ID containing the title. `sp sync` fetches that ref before parsing the stack. Writing titles is deferred to `sp group` (later step), but `saveGroupTitle` is implemented now for use in tests.

**Tech Stack:** Bun, TypeScript, git plumbing (`hash-object`, `mktree`, `commit-tree`, `update-ref`, `ls-tree`, `cat-file`, `fetch`)

---

## Context

The branch `group-title-storage` already has a partial implementation using `git config` for storage. That implementation must be replaced. The other changes on the branch (`formatPRBody` returning `""` for groups, group guards removed from `resolveOpenTargets` and `buildOpenCandidates`) are correct and should be kept.

Run tests with the docker alias: `bun run test:docker` from the project root. To run a single file from the worktree: `cd docker && docker compose run --rm dev bash -c "cd /workspace/.worktrees/group-title-storage && bun test <path>"`.

---

## Task 1: Rewrite `src/git/group-titles.ts` with commit-tree storage

**Files:**

- Modify: `src/git/group-titles.ts`

The current file uses `git config`. Replace entirely with git plumbing.

**Step 1: Write the new implementation**

```ts
import type { GroupTitles } from "../parse/types.ts";

interface GitOpts {
  cwd?: string;
  stdin?: string;
}

interface GitRunner {
  run(
    args: string[],
    opts?: GitOpts,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const GROUPS_REF = "refs/spry/groups";

export async function loadGroupTitles(git: GitRunner, opts?: { cwd?: string }): Promise<GroupTitles> {
  const ls = await git.run(["ls-tree", GROUPS_REF], opts);
  if (ls.exitCode !== 0) return {};

  const titles: GroupTitles = {};
  for (const line of ls.stdout.trim().split("\n")) {
    if (!line) continue;
    // format: "<mode> blob <sha>\t<name>"
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const groupId = line.slice(tab + 1);
    const cat = await git.run(["cat-file", "blob", `${GROUPS_REF}:${groupId}`], opts);
    if (cat.exitCode === 0) titles[groupId] = cat.stdout;
  }
  return titles;
}

export async function saveGroupTitle(
  git: GitRunner,
  groupId: string,
  title: string,
  opts?: { cwd?: string },
): Promise<void> {
  // Write blob
  const blob = await git.run(["hash-object", "-w", "--stdin"], { ...opts, stdin: title });
  if (blob.exitCode !== 0) throw new Error(`saveGroupTitle: hash-object failed: ${blob.stderr}`);
  const blobSha = blob.stdout.trim();

  // Read existing tree entries (excluding this groupId)
  const existing: string[] = [];
  const ls = await git.run(["ls-tree", GROUPS_REF], opts);
  if (ls.exitCode === 0) {
    for (const line of ls.stdout.trim().split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab !== -1 && line.slice(tab + 1) !== groupId) existing.push(line);
    }
  }

  // Build new tree
  const newEntry = `100644 blob ${blobSha}\t${groupId}`;
  const treeInput = [...existing, newEntry].join("\n") + "\n";
  const tree = await git.run(["mktree"], { ...opts, stdin: treeInput });
  if (tree.exitCode !== 0) throw new Error(`saveGroupTitle: mktree failed: ${tree.stderr}`);
  const treeSha = tree.stdout.trim();

  // Create commit (with parent if ref exists)
  const commitArgs = ["commit-tree", treeSha, "-m", `set group title: ${groupId}`];
  const parent = await git.run(["rev-parse", "--verify", GROUPS_REF], opts);
  if (parent.exitCode === 0) commitArgs.push("-p", parent.stdout.trim());
  const commit = await git.run(commitArgs, opts);
  if (commit.exitCode !== 0) throw new Error(`saveGroupTitle: commit-tree failed: ${commit.stderr}`);

  // Update ref
  await git.run(["update-ref", GROUPS_REF, commit.stdout.trim()], opts);
}
```

**Step 2: Run existing group-titles tests to confirm they now fail (RED)**

```bash
cd docker && docker compose run --rm dev bash -c "cd /workspace/.worktrees/group-title-storage && bun test tests/git/group-titles.test.ts"
```

Expected: failures because the tests still use `git config` setup but implementation no longer reads from config.

**Step 3: Commit the implementation (tests still failing)**

```bash
cd /Users/dondenton/GitProjects/spry/.worktrees/group-title-storage
git add src/git/group-titles.ts
git commit -m "refactor(group-titles): replace git-config storage with commit-tree at refs/spry/groups"
```

---

## Task 2: Update `tests/git/group-titles.test.ts` to use the commit-tree API

**Files:**

- Modify: `tests/git/group-titles.test.ts`

The current tests use `git config` shell commands to set up test data. Replace with calls to `saveGroupTitle` (which we just implemented).

**Step 1: Rewrite the tests**

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { loadGroupTitles, saveGroupTitle } from "../../src/git/group-titles.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];
const git = createRealGitRunner();

afterEach(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  return repo;
}

describe("loadGroupTitles", () => {
  test("returns empty object when no group titles stored", async () => {
    const repo = await makeRepo();
    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles).toEqual({});
  });

  test("returns stored group title by group id", async () => {
    const repo = await makeRepo();
    await saveGroupTitle(git, "g1", "Auth Feature", { cwd: repo.path });

    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles["g1"]).toBe("Auth Feature");
  });

  test("returns multiple stored group titles", async () => {
    const repo = await makeRepo();
    await saveGroupTitle(git, "g1", "Auth Feature", { cwd: repo.path });
    await saveGroupTitle(git, "g2", "Login Flow", { cwd: repo.path });

    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles["g1"]).toBe("Auth Feature");
    expect(titles["g2"]).toBe("Login Flow");
  });
});

describe("saveGroupTitle", () => {
  test("stores a group title retrievable by loadGroupTitles", async () => {
    const repo = await makeRepo();
    await saveGroupTitle(git, "g1", "Auth Feature", { cwd: repo.path });

    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles["g1"]).toBe("Auth Feature");
  });

  test("overwrites an existing title for the same group id", async () => {
    const repo = await makeRepo();
    await saveGroupTitle(git, "g1", "Old Title", { cwd: repo.path });
    await saveGroupTitle(git, "g1", "New Title", { cwd: repo.path });

    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles["g1"]).toBe("New Title");
  });
});
```

**Step 2: Run tests — expect GREEN**

```bash
cd docker && docker compose run --rm dev bash -c "cd /workspace/.worktrees/group-title-storage && bun test tests/git/group-titles.test.ts"
```

Expected: 5 pass, 0 fail.

**Step 3: Commit**

```bash
cd /Users/dondenton/GitProjects/spry/.worktrees/group-title-storage
git add tests/git/group-titles.test.ts
git commit -m "test(group-titles): update to use commit-tree storage via saveGroupTitle"
```

---

## Task 3: Add `fetchGroupTitles` to `src/git/group-titles.ts`

**Files:**

- Modify: `src/git/group-titles.ts`

`sp sync` needs to fetch the ref from the remote before reading it.

**Step 1: Write the failing test first**

Add to `tests/git/group-titles.test.ts`:

```ts
// Note: fetchGroupTitles talks to a remote — tested via syncCommand integration test.
// Unit-level: verify it returns ok when fetch exits 0, and ok when ref missing (exit 1).
import { fetchGroupTitles } from "../../src/git/group-titles.ts";

describe("fetchGroupTitles", () => {
  test("returns ok when fetch succeeds", async () => {
    const fakeGit: typeof git = {
      async run() { return { stdout: "", stderr: "", exitCode: 0 }; },
    };
    const result = await fetchGroupTitles(fakeGit, "origin");
    expect(result.ok).toBe(true);
  });

  test("returns ok when remote has no groups ref (exit 128)", async () => {
    const fakeGit: typeof git = {
      async run() {
        return { stdout: "", stderr: "couldn't find remote ref", exitCode: 128 };
      },
    };
    const result = await fetchGroupTitles(fakeGit, "origin");
    expect(result.ok).toBe(true);
  });

  test("returns warning on network error", async () => {
    const fakeGit: typeof git = {
      async run() {
        return { stdout: "", stderr: "Connection refused", exitCode: 1 };
      },
    };
    const result = await fetchGroupTitles(fakeGit, "origin");
    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/Connection refused/);
  });
});
```

**Step 2: Run to verify RED**

```bash
cd docker && docker compose run --rm dev bash -c "cd /workspace/.worktrees/group-title-storage && bun test tests/git/group-titles.test.ts"
```

Expected: 3 new failures (fetchGroupTitles not exported).

**Step 3: Add `fetchGroupTitles` to `src/git/group-titles.ts`**

```ts
export async function fetchGroupTitles(
  git: GitRunner,
  remote: string,
  opts?: { cwd?: string },
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const refspec = `${GROUPS_REF}:${GROUPS_REF}`;
  const result = await git.run(["fetch", remote, refspec], opts);
  if (result.exitCode === 0) return { ok: true };
  // Exit 128 = ref doesn't exist on remote — not an error
  if (result.stderr.includes("couldn't find remote ref")) return { ok: true };
  return { ok: false, warning: result.stderr.trim() };
}
```

**Step 4: Run to verify GREEN**

```bash
cd docker && docker compose run --rm dev bash -c "cd /workspace/.worktrees/group-title-storage && bun test tests/git/group-titles.test.ts"
```

Expected: 8 pass, 0 fail.

**Step 5: Export from `src/git/index.ts`**

```ts
export { loadGroupTitles, saveGroupTitle, fetchGroupTitles } from "./group-titles.ts";
```

**Step 6: Commit**

```bash
git add src/git/group-titles.ts src/git/index.ts tests/git/group-titles.test.ts
git commit -m "feat(group-titles): add fetchGroupTitles to pull refs/spry/groups from remote"
```

---

## Task 4: Wire `fetchGroupTitles` into `syncCommand`

**Files:**

- Modify: `src/commands/sync.ts`
- Modify: `tests/commands/sync.test.ts`

**Step 1: Write a failing test**

Add to `tests/commands/sync.test.ts` in the `syncCommand bare` describe block:

```ts
test("fetches refs/spry/groups before parsing stack", async () => {
  const repo = await makeRepoWithConfig();
  const git = createRealGitRunner();
  await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"], {
    cwd: repo.path,
  });

  const fetchedRefs: string[] = [];
  const { gh } = stubGh(ghPRMap({}));
  const ctx: SpryContext = {
    gh,
    git: {
      run: async (args, opts) => {
        if (args[0] === "fetch") fetchedRefs.push(args.slice(1).join(" "));
        return createRealGitRunner().run(args, { ...opts, cwd: opts?.cwd ?? repo.path });
      },
    },
  };
  const logs = captureLogs();
  try {
    await syncCommand(ctx, { cwd: repo.path });
  } finally {
    logs.restore();
  }
  expect(fetchedRefs.some((r) => r.includes("refs/spry/groups"))).toBe(true);
});
```

**Step 2: Run to verify RED**

```bash
cd docker && docker compose run --rm dev bash -c "cd /workspace/.worktrees/group-title-storage && bun test tests/commands/sync.test.ts"
```

Expected: 1 new failure.

**Step 3: Update `syncCommand` to fetch before loading**

In `src/commands/sync.ts`, update the import and the step 2 block:

```ts
import { loadGroupTitles, fetchGroupTitles } from "../git/group-titles.ts";
```

In `syncCommand`, replace:

```ts
const groupTitles = await loadGroupTitles(ctx.git, { cwd });
```

with:

```ts
const fetchResult = await fetchGroupTitles(ctx.git, config.remote, { cwd });
if (!fetchResult.ok) {
  console.log(kleur.dim(`⚠ Could not fetch group titles: ${fetchResult.warning}`));
}
const groupTitles = await loadGroupTitles(ctx.git, { cwd });
```

**Step 4: Run all sync tests — expect GREEN**

```bash
cd docker && docker compose run --rm dev bash -c "cd /workspace/.worktrees/group-title-storage && bun test tests/commands/sync.test.ts"
```

Expected: 20 pass, 0 fail.

**Step 5: Update the group --open integration test**

The existing test `--open of a group creates a PR with the stored group title` currently seeds the title via `git config`. Update it to use git plumbing (or `saveGroupTitle`) instead:

Replace:

```ts
await git.run(["config", "spry-group.grp00001.title", "Auth Feature"], { cwd: repo.path });
```

With (using Bun.$ git plumbing to set up the ref directly):

```ts
// Use saveGroupTitle from the module under test to set up the ref
const { saveGroupTitle } = await import("../../src/git/group-titles.ts");
await saveGroupTitle(git, "grp00001", "Auth Feature", { cwd: repo.path });
```

**Step 6: Run to verify GREEN**

```bash
cd docker && docker compose run --rm dev bash -c "cd /workspace/.worktrees/group-title-storage && bun test tests/commands/sync.test.ts"
```

Expected: all pass.

**Step 7: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "feat(sync): fetch refs/spry/groups before parsing so group titles are available"
```

---

## Task 5: Update CHANGELOG and run full suite

**Step 1: Update CHANGELOG.md**

Under `## [Unreleased] > ### Added`, replace the git-config entries with:

```markdown
- Group-title storage (`loadGroupTitles` / `saveGroupTitle` / `fetchGroupTitles` in `src/git/group-titles.ts`) persists group titles as a metadata commit tree at `refs/spry/groups`; portable across clones and collaborators
- `sp sync` fetches `refs/spry/groups` from the remote before parsing so group PRs receive their stored titles
- `sp sync --open <group-id>` now works for group units
- `formatPRBody` returns empty string for group units instead of throwing
```

**Step 2: Run full test suite**

```bash
bun run test:docker
```

Expected: all previously-passing tests still pass, new tests green.

**Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "chore: update changelog for group-title storage"
```
