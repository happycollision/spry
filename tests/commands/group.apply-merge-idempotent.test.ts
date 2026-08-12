// Idempotent re-materialization of `sp group --apply` over an ALREADY-materialized
// merge stack (spry-merge-commit-groups-yu7k.9).
//
// The first `--apply` of a merge-group doc materializes the merge commit. A
// SECOND identical `--apply` must be a TRUE NO-OP: HEAD unchanged, the merge
// commit's SHA identical, the merge's (possibly user-edited) message preserved,
// and the merge-group records unchanged. Before the fix, the second apply
// aborted with "Commit <sha> has no Spry-Commit-Id after inject" because it
// snapshotted the non-expanded stack (which includes the id-less merge commit).
//
// Offline: gh is stubbed to throw, matching the rest of the --apply suite.

import { test, expect, afterAll } from "bun:test";
import { groupCommand } from "../../src/commands/group.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { SpryContext, TestRepo } from "../lib/index.ts";
import { captureLogs, trapExit } from "../lib/capture.ts";
import { loadMergeGroupRecords } from "../../src/git/merge-groups.ts";

const repos: TestRepo[] = [];

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

async function applyDoc(
  repo: TestRepo,
  docObj: unknown,
): Promise<{ out: string[]; err: string[]; code: number | undefined }> {
  const ctx = makeCtx(repo);
  const logs = await captureLogs("group-apply-merge-idempotent");
  const trap = trapExit();
  try {
    await groupCommand(ctx, { cwd: repo.path, apply: JSON.stringify(docObj) });
  } catch (e: unknown) {
    if (!(e instanceof Error) || e.message !== "process.exit") throw e;
  } finally {
    trap.restore();
    logs.restore();
  }
  return { out: logs.out, err: logs.err, code: trap.exitCode };
}

async function head(repo: TestRepo): Promise<string> {
  const git = createRealGitRunner();
  const r = await git.run(["rev-parse", "HEAD"], { cwd: repo.path });
  return r.stdout.trim();
}

// The SHA of the (single) merge commit on the first-parent line, or undefined.
async function mergeSha(repo: TestRepo): Promise<string | undefined> {
  const git = createRealGitRunner();
  const r = await git.run(
    ["log", "--first-parent", "--format=%H %P", `origin/${repo.defaultBranch}..HEAD`],
    { cwd: repo.path },
  );
  for (const line of r.stdout.trim().split("\n")) {
    const [sha, ...parents] = line.trim().split(/\s+/);
    if (parents.length >= 2 && sha) return sha;
  }
  return undefined;
}

async function messageOf(repo: TestRepo, sha: string): Promise<string> {
  const git = createRealGitRunner();
  const r = await git.run(["log", "-1", "--format=%B", sha], { cwd: repo.path });
  return r.stdout.replace(/\n+$/, "");
}

const mergeDoc = {
  stack: [
    { type: "commit", id: "p1p1p1p1" },
    {
      type: "merge",
      id: "mgmgmgmg",
      commits: [
        { type: "commit", id: "m1m1m1m1" },
        { type: "commit", id: "m2m2m2m2" },
      ],
    },
  ],
};

async function seedStack(repo: TestRepo): Promise<void> {
  await repo.commitFiles({ "p1.txt": "P1" }, "feat: p1\n\nSpry-Commit-Id: p1p1p1p1");
  await repo.commitFiles({ "m1.txt": "M1" }, "feat: m1\n\nSpry-Commit-Id: m1m1m1m1");
  await repo.commitFiles({ "m2.txt": "M2" }, "feat: m2\n\nSpry-Commit-Id: m2m2m2m2");
}

test("fresh materialization still works (regression)", async () => {
  const repo = await makeRepo();
  await seedStack(repo);

  const res = await applyDoc(repo, mergeDoc);
  expect(res.code).toBeUndefined();

  const mrec = await loadMergeGroupRecords(repo.git, { cwd: repo.path });
  expect(mrec["mgmgmgmg"]).toEqual({ members: ["m1m1m1m1", "m2m2m2m2"] });
  const ms = await mergeSha(repo);
  expect(ms).toBeDefined();
});

test("second identical --apply over a materialized merge is a NO-OP", async () => {
  const repo = await makeRepo();
  await seedStack(repo);

  const first = await applyDoc(repo, mergeDoc);
  expect(first.code).toBeUndefined();
  const headAfterFirst = await head(repo);
  const mergeAfterFirst = await mergeSha(repo);
  expect(mergeAfterFirst).toBeDefined();
  const mrecAfterFirst = await loadMergeGroupRecords(repo.git, { cwd: repo.path });

  const second = await applyDoc(repo, mergeDoc);
  expect(second.code).toBeUndefined(); // must NOT abort
  // The rewrite is skipped entirely (ref/working-tree untouched), not just
  // rebuilt to an identical SHA.
  expect(second.out.join("\n")).toContain("already materialized");

  // HEAD is byte-for-byte unchanged; the merge commit SHA is identical.
  expect(await head(repo)).toBe(headAfterFirst);
  expect(await mergeSha(repo)).toBe(mergeAfterFirst);

  // Merge-group records are unchanged.
  const mrecAfterSecond = await loadMergeGroupRecords(repo.git, { cwd: repo.path });
  expect(mrecAfterSecond).toEqual(mrecAfterFirst);
});

test("re-apply preserves an edited merge message (no message churn, HEAD stable)", async () => {
  const repo = await makeRepo();
  await seedStack(repo);

  const first = await applyDoc(repo, mergeDoc);
  expect(first.code).toBeUndefined();
  const mergeBefore = await mergeSha(repo);
  expect(mergeBefore).toBeDefined();

  // Reword the merge commit's message in place, keeping everything else identical
  // (same two parents, same tree). We rebuild it with the SAME pinned merge env
  // that `materialize` uses (fixed epoch + spry identity), so this represents a
  // spry-produced merge whose message was edited — the state a re-apply must
  // reproduce byte-for-byte.
  const git = createRealGitRunner();
  const parents = (
    await git.run(["rev-list", "--parents", "-n", "1", mergeBefore!], { cwd: repo.path })
  ).stdout
    .trim()
    .split(/\s+/);
  const p1 = parents[1];
  const p2 = parents[2];
  const tree = (
    await git.run(["rev-parse", `${mergeBefore}^{tree}`], { cwd: repo.path })
  ).stdout.trim();
  const editedMessage = "Custom merge subject\n\nhand-edited body line";
  const mergeEnv = {
    GIT_AUTHOR_NAME: "spry",
    GIT_AUTHOR_EMAIL: "spry@local",
    GIT_AUTHOR_DATE: "1700000000 +0000",
    GIT_COMMITTER_NAME: "spry",
    GIT_COMMITTER_EMAIL: "spry@local",
    GIT_COMMITTER_DATE: "1700000000 +0000",
  };
  // Pass the message via stdin (no trailing newline), exactly as spry's
  // `createCommit` does — a merge produced by `git commit-tree -m` would carry a
  // trailing newline that materialize's stdin-built commit never adds, which would
  // itself change the SHA and mask the real invariant.
  const rewritten = (
    await git.run(["commit-tree", tree, "-p", p1!, "-p", p2!], {
      cwd: repo.path,
      env: { ...process.env, ...mergeEnv },
      stdin: editedMessage,
    })
  ).stdout.trim();
  await git.run(["update-ref", "HEAD", rewritten], { cwd: repo.path });
  const headAfterEdit = await head(repo);
  const mergeAfterEdit = await mergeSha(repo);

  // Re-apply the same doc. The edited message must survive and the re-apply must
  // NOT churn the message back to the "Merge: <subject>" placeholder, nor move
  // HEAD (same members, same order, same message => identical rebuilt SHA).
  const res = await applyDoc(repo, mergeDoc);
  expect(res.code).toBeUndefined();

  const mergeNow = await mergeSha(repo);
  expect(mergeNow).toBeDefined();
  expect(await messageOf(repo, mergeNow!)).toBe(editedMessage);
  expect(mergeNow).toBe(mergeAfterEdit);
  expect(await head(repo)).toBe(headAfterEdit);
});
