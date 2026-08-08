// End-to-end: `sp view --json` emits nested merge nodes after a merge group is
// materialized via `sp group --apply`, and the emitted JSON is valid `--apply`
// input (parses without stripping). Uses --apply as the oracle (offline; gh
// throws). NOTE: re-materializing an already-materialized stack (a true history
// no-op) is deferred — see spry follow-up; this test covers the read/emit path
// and that the emitted tree is parseable apply input.
import { test, expect, afterAll } from "bun:test";
import { groupCommand } from "../../src/commands/group.ts";
import { viewCommand } from "../../src/commands/view.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { SpryContext, TestRepo } from "../lib/index.ts";
import { captureLogs, trapExit, acquireOutputLock } from "../lib/capture.ts";
import { loadMergeGroupRecords } from "../../src/git/merge-groups.ts";
import { parseApplyDoc } from "../../src/parse/apply-doc.ts";

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
        throw new Error("gh must not be called");
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

async function apply(repo: TestRepo, docObj: unknown): Promise<number | undefined> {
  const ctx = makeCtx(repo);
  const logs = await captureLogs("view-merge-apply");
  const trap = trapExit();
  try {
    await groupCommand(ctx, { cwd: repo.path, apply: JSON.stringify(docObj) });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "process.exit") throw e;
  } finally {
    trap.restore();
    logs.restore();
  }
  return trap.exitCode;
}

async function viewJson(repo: TestRepo): Promise<unknown> {
  const ctx = makeCtx(repo);
  const release = await acquireOutputLock();
  const chunks: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  try {
    await viewCommand(ctx, { cwd: repo.path, json: true });
  } finally {
    console.log = origLog;
    release();
  }
  return JSON.parse(chunks.join("\n"));
}

test("view --json emits a merge node after materialization, and round-trips through --apply", async () => {
  const repo = await makeRepo();
  await repo.commitFiles({ "p1.txt": "P1" }, "feat: p1\n\nSpry-Commit-Id: p1p1p1p1");
  await repo.commitFiles({ "m1.txt": "M1" }, "feat: m1\n\nSpry-Commit-Id: m1m1m1m1");
  await repo.commitFiles({ "m2.txt": "M2" }, "feat: m2\n\nSpry-Commit-Id: m2m2m2m2");

  const code = await apply(repo, {
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
  });
  expect(code).toBeUndefined();

  // The merge record exists, and view --json shows a nested merge node.
  const mrec = await loadMergeGroupRecords(repo.git, { cwd: repo.path });
  expect(mrec["mgmgmgmg"]).toBeDefined();

  const tree = (await viewJson(repo)) as {
    stack: Array<{ type: string; id: string; commits?: Array<{ id: string }> }>;
  };
  const types = tree.stack.map((n) => n.type);
  expect(types).toEqual(["commit", "merge"]);
  const merge = tree.stack.find((n) => n.type === "merge");
  expect(merge?.id).toBe("mgmgmgmg");
  expect(merge?.commits?.map((cc) => cc.id)).toEqual(["m1m1m1m1", "m2m2m2m2"]);

  // The emitted tree is valid --apply input verbatim (output-only fields like
  // sha/subject/pr are ignored on input; the merge node parses back to the same
  // merge group). This is the data round-trip that lets `view --json` build apply
  // docs; the history no-op on re-materialization is a separate deferred concern.
  const reparsed = parseApplyDoc(JSON.stringify(tree));
  expect(reparsed.ok).toBe(true);
  if (!reparsed.ok) return;
  expect(reparsed.doc.mergeGroups).toHaveLength(1);
  expect(reparsed.doc.mergeGroups[0]).toMatchObject({
    id: "mgmgmgmg",
    memberIds: ["m1m1m1m1", "m2m2m2m2"],
  });
});
