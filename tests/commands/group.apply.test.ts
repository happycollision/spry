// Offline CLI integration tests for `sp group --apply`.
//
// These drive the real `groupCommand(ctx, { cwd, apply })` function directly
// (pattern A: no binary spawn, no TTY) against a scratch repo. Open-PR state
// is seeded via `savePRCache` into the local `refs/spry/prs` cache; the `gh`
// client is stubbed to THROW so any accidental gh call fails the test loudly
// — proving the --apply path is fully offline (cache-backed, no GitHub calls).
//
// Ids minted by --apply (new groups, reissued commit ids) are random, so
// assertions check structure (/^[0-9a-f]{8}$/) and record shape, never
// literal values.

import { test, expect, afterAll } from "bun:test";
import { groupCommand } from "../../src/commands/group.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { SpryContext, TestRepo } from "../lib/index.ts";
import { captureLogs, trapExit } from "../lib/capture.ts";
import { loadGroupRecords } from "../../src/git/group-titles.ts";
import { loadPRCache, savePRCache } from "../../src/gh/pr-cache.ts";
import type { PRCache } from "../../src/gh/pr-cache.ts";

const repos: TestRepo[] = [];

// afterAll, not afterEach: under --concurrent a per-test cleanup hook would
// delete repos out from under still-running sibling tests.
afterAll(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

function makeCtx(repo: TestRepo): SpryContext {
  const git = createRealGitRunner();
  return {
    git: { run: (args, opts) => git.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }) },
    gh: {
      run: async () => {
        throw new Error("gh must not be called by --apply");
      },
    },
  };
}

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const g = createRealGitRunner();
  await g.run(["config", "spry.trunk", repo.defaultBranch], { cwd: repo.path });
  await g.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await g.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
  return repo;
}

// Returns the live Spry-Commit-Ids bottom->top. Diffs against origin/<trunk>
// (matching trunkRef's `${remote}/${trunk}`, per the spry.remote/spry.trunk
// config set in makeRepo) — NOT the local branch name, since createRepo's
// work branch IS the trunk branch name itself (no separate feature branch),
// so `<trunk>..HEAD` would just compare HEAD to itself and always be empty.
async function liveIds(repo: TestRepo): Promise<string[]> {
  const git = createRealGitRunner();
  const log = await git.run(["log", "--format=%H", `origin/${repo.defaultBranch}..HEAD`], {
    cwd: repo.path,
  });
  const hashesTopFirst = log.stdout.trim() ? log.stdout.trim().split("\n") : [];
  const ids: string[] = [];
  for (const h of hashesTopFirst.reverse()) {
    const body = await git.run(["log", "-1", "--format=%B", h], { cwd: repo.path });
    const m = body.stdout.match(/Spry-Commit-Id:\s*([0-9a-f]+)/);
    if (m) ids.push(m[1]!);
  }
  return ids;
}

function seedOpenPR(id: string, defaultBranch: string): PRCache {
  return {
    [id]: {
      branch: `spry/test/${id}`,
      cachedAt: "2026-01-01T00:00:00.000Z",
      number: 7,
      url: "",
      state: "OPEN",
      title: "feat: a",
      baseRefName: defaultBranch,
      checksStatus: "none",
      reviewDecision: "none",
      reviewThreads: { resolved: 0, total: 0 },
    },
  };
}

async function applyDoc(
  repo: TestRepo,
  docObj: unknown,
): Promise<{ out: string[]; err: string[]; code: number | undefined }> {
  const ctx = makeCtx(repo);
  const logs = await captureLogs("group-apply");
  const trap = trapExit();
  try {
    await groupCommand(ctx, { cwd: repo.path, apply: JSON.stringify(docObj) });
  } catch (e: unknown) {
    // process.exit is trapped and throws a sentinel; anything else re-throws.
    if (!(e instanceof Error) || e.message !== "process.exit") throw e;
  } finally {
    trap.restore();
    logs.restore();
  }
  return { out: logs.out, err: logs.err, code: trap.exitCode };
}

test("--apply creates a group from two commits (offline, no gh)", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      {
        type: "group",
        id: null,
        title: "My group",
        commits: [
          { type: "commit", id: "aaaaaaaa" },
          { type: "commit", id: "bbbbbbbb" },
        ],
      },
    ],
  });

  expect(res.code).toBeUndefined(); // no exit(1)
  const records = await loadGroupRecords(repo.git, { cwd: repo.path });
  const ids = Object.keys(records);
  expect(ids).toHaveLength(1);
  expect(ids[0]).toMatch(/^[0-9a-f]{8}$/);
  expect(records[ids[0]!]).toEqual({ title: "My group", members: ["aaaaaaaa", "bbbbbbbb"] });
});

test("--apply dissolves a group by listing members ungrouped", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  // first create a group
  const create = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      {
        type: "group",
        id: null,
        title: "G",
        commits: [
          { type: "commit", id: "aaaaaaaa" },
          { type: "commit", id: "bbbbbbbb" },
        ],
      },
    ],
  });
  expect(create.code).toBeUndefined();

  // now dissolve: list members ungrouped
  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      { type: "commit", id: "aaaaaaaa" },
      { type: "commit", id: "bbbbbbbb" },
    ],
  });
  expect(res.code).toBeUndefined();
  const records = await loadGroupRecords(repo.git, { cwd: repo.path });
  expect(Object.keys(records)).toHaveLength(0);
});

test("--apply errors (exit 1) when doc omits a live commit", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      { type: "commit", id: "aaaaaaaa" },
    ],
  });
  expect(res.code).toBe(1);
  expect(res.err.join("\n")).toMatch(/account|missing/i);
});

test("--apply reissues a top-level commit id when reissueId:true (id changes)", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      { type: "commit", id: "aaaaaaaa", reissueId: true }, // no open PR -> no pr:CLOSE needed
      { type: "commit", id: "bbbbbbbb" },
    ],
  });
  expect(res.code).toBeUndefined();
  const ids = await liveIds(repo);
  // Pin count + membership: nothing dropped, exactly the base + sibling +
  // one fresh reissued id survive. (A weaker "some id matches /^[0-9a-f]{8}$/"
  // check would be vacuously satisfied by "cccccccc" alone, which is always
  // present — it wouldn't catch a bug that dropped the reissued commit
  // entirely.)
  expect(ids).toHaveLength(3);
  expect(ids).toContain("cccccccc"); // base, unchanged
  expect(ids).toContain("bbbbbbbb"); // sibling, unchanged
  expect(ids).not.toContain("aaaaaaaa"); // reissued away
  const fresh = ids.filter((id) => id !== "cccccccc" && id !== "bbbbbbbb");
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatch(/^[0-9a-f]{8}$/);
});

test("--apply group adopts a member's open PR with pr:ADOPT (seeded cache)", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");
  await savePRCache(repo.git, seedOpenPR("aaaaaaaa", repo.defaultBranch), { cwd: repo.path });

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      {
        type: "group",
        id: "aaaaaaaa",
        title: "G",
        pr: "ADOPT",
        commits: [
          { type: "commit", id: "aaaaaaaa" },
          { type: "commit", id: "bbbbbbbb" },
        ],
      },
    ],
  });
  expect(res.code).toBeUndefined();
  const records = await loadGroupRecords(repo.git, { cwd: repo.path });
  expect(records["aaaaaaaa"]).toEqual({ title: "G", members: ["aaaaaaaa", "bbbbbbbb"] });
});

test("--apply errors when a group would adopt without pr:ADOPT", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");
  await savePRCache(repo.git, seedOpenPR("aaaaaaaa", repo.defaultBranch), { cwd: repo.path });

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      {
        type: "group",
        id: "aaaaaaaa",
        title: "G",
        commits: [
          { type: "commit", id: "aaaaaaaa" },
          { type: "commit", id: "bbbbbbbb" },
        ],
      },
    ],
  });
  expect(res.code).toBe(1);
  expect(res.err.join("\n")).toMatch(/adopt/i);
});

test("--apply rejects reissuing a grouped member (must ungroup first)", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      {
        type: "group",
        id: null,
        title: "G",
        commits: [
          { type: "commit", id: "aaaaaaaa", reissueId: true },
          { type: "commit", id: "bbbbbbbb" },
        ],
      },
    ],
  });
  expect(res.code).toBe(1);
  expect(res.err.join("\n")).toMatch(/member of a group|ungroup/i);

  // Nothing was mutated: no group record written, ids unchanged.
  const records = await loadGroupRecords(repo.git, { cwd: repo.path });
  expect(Object.keys(records)).toHaveLength(0);
  const ids = await liveIds(repo);
  expect(ids).toEqual(["cccccccc", "aaaaaaaa", "bbbbbbbb"]);
});

test("--apply rejects reissuing a group identity (must dissolve+recreate)", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  // Create the group first so it has a real (minted) id to reference.
  const create = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      {
        type: "group",
        id: null,
        title: "G",
        commits: [
          { type: "commit", id: "aaaaaaaa" },
          { type: "commit", id: "bbbbbbbb" },
        ],
      },
    ],
  });
  expect(create.code).toBeUndefined();
  const created = await loadGroupRecords(repo.git, { cwd: repo.path });
  const groupId = Object.keys(created)[0]!;
  expect(groupId).toMatch(/^[0-9a-f]{8}$/);

  // Now try to reissue the group's own identity.
  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      {
        type: "group",
        id: groupId,
        title: "G",
        reissueId: true,
        commits: [
          { type: "commit", id: "aaaaaaaa" },
          { type: "commit", id: "bbbbbbbb" },
        ],
      },
    ],
  });
  expect(res.code).toBe(1);
  expect(res.err.join("\n")).toMatch(/group.*not supported|dissolve/i);

  // The group record is untouched by the rejected apply.
  const after = await loadGroupRecords(repo.git, { cwd: repo.path });
  expect(after).toEqual(created);
});

test("--apply reorders commits when the doc order differs from live order", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      { type: "commit", id: "bbbbbbbb" },
      { type: "commit", id: "aaaaaaaa" },
    ],
  });
  expect(res.code).toBeUndefined();
  const ids = await liveIds(repo);
  expect(ids).toEqual(["cccccccc", "bbbbbbbb", "aaaaaaaa"]);
});

test("--apply reorder bails with exit 1 on a dirty working tree", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  // Dirty the working tree (untracked file counts per getWorkingTreeStatus).
  await Bun.write(`${repo.path}/dirty.txt`, "uncommitted");

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      { type: "commit", id: "bbbbbbbb" },
      { type: "commit", id: "aaaaaaaa" },
    ],
  });
  expect(res.code).toBe(1);
  expect(res.err.join("\n")).toMatch(/dirty/i);

  // Order unchanged since the reorder never ran.
  const ids = await liveIds(repo);
  expect(ids).toEqual(["cccccccc", "aaaaaaaa", "bbbbbbbb"]);
});

test("--apply rejects a doc that both reissues and reorders in one pass", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      { type: "commit", id: "bbbbbbbb" },
      { type: "commit", id: "aaaaaaaa", reissueId: true },
    ],
  });
  expect(res.code).toBe(1);
  expect(res.err.join("\n")).toMatch(/reissue.*reorder|separate applies/i);
});

test("--apply never calls gh (offline canonical proof)", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");

  // A trivial no-op apply (single top-level commit, unchanged). The gh stub
  // throws on any call; reaching this assertion at all is the offline proof.
  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      { type: "commit", id: "aaaaaaaa" },
    ],
  });
  expect(res.code).toBeUndefined();
});

test("--apply with reissue + pr:CLOSE marks the cached PR entry CLOSED", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");
  // Seed an OPEN PR for aaaaaaaa: reissuing a commit with an open PR requires
  // pr:CLOSE (reconcile's checkPr rejects the reissue otherwise), and that is
  // exactly the transition this test exercises.
  await savePRCache(repo.git, seedOpenPR("aaaaaaaa", repo.defaultBranch), { cwd: repo.path });

  const res = await applyDoc(repo, {
    stack: [
      { type: "commit", id: "cccccccc" },
      { type: "commit", id: "aaaaaaaa", reissueId: true, pr: "CLOSE" },
      { type: "commit", id: "bbbbbbbb" },
    ],
  });
  expect(res.code).toBeUndefined();
  const after = await loadPRCache(repo.git, { cwd: repo.path });
  expect(after.aaaaaaaa?.state).toBe("CLOSED");
});

test("--apply reads the doc from stdin when apply is '-'", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "base.txt": "b" }, "base\n\nSpry-Commit-Id: cccccccc");
  await repo.commitFiles({ "a.txt": "A" }, "feat: a\n\nSpry-Commit-Id: aaaaaaaa");
  await repo.commitFiles({ "b.txt": "B" }, "feat: b\n\nSpry-Commit-Id: bbbbbbbb");

  const doc = JSON.stringify({
    stack: [
      { type: "commit", id: "cccccccc" },
      {
        type: "group",
        id: null,
        title: "Via stdin",
        commits: [
          { type: "commit", id: "aaaaaaaa" },
          { type: "commit", id: "bbbbbbbb" },
        ],
      },
    ],
  });
  const ctx = makeCtx(repo);
  const logs = await captureLogs("group-apply-stdin");
  const trap = trapExit();
  try {
    await groupCommand(ctx, { cwd: repo.path, apply: "-", readStdin: async () => doc });
  } catch (e: unknown) {
    if (!(e instanceof Error) || e.message !== "process.exit") throw e;
  } finally {
    trap.restore();
    logs.restore();
  }

  expect(trap.exitCode).toBeUndefined();
  const records = await loadGroupRecords(repo.git, { cwd: repo.path });
  const ids = Object.keys(records);
  expect(ids).toHaveLength(1);
  const gid = ids[0];
  expect(gid).toBeDefined();
  if (!gid) throw new Error("no group record found");
  expect(records[gid]?.title).toBe("Via stdin");
});
