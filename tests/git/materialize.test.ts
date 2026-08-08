import { describe, test, expect, afterAll } from "bun:test";
import {
  materialize,
  buildMaterializePlan,
  type PlanNode,
  type MergeGroupSpec,
} from "../../src/git/materialize.ts";
import { getTree } from "../../src/git/plumbing.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";
import { $ } from "bun";

const repos: TestRepo[] = [];
const git = createRealGitRunner();

afterAll(async () => {
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

// Build a linear stack of commits, each adding one file, on a branch off the
// current HEAD. Returns the base SHA and the ordered commit SHAs.
async function linearStack(
  repoPath: string,
  names: string[],
): Promise<{ base: string; shas: string[] }> {
  const base = (await $`git rev-parse HEAD`.cwd(repoPath).quiet().text()).trim();
  const shas: string[] = [];
  for (const n of names) {
    await Bun.write(`${repoPath}/${n}.txt`, `${n}\n`);
    await $`git add ${n + ".txt"}`.cwd(repoPath).quiet();
    await $`git commit -q -m ${"commit " + n}`.cwd(repoPath).quiet();
    shas.push((await $`git rev-parse HEAD`.cwd(repoPath).quiet().text()).trim());
  }
  return { base, shas };
}

// Returns only the stack's own `c*.txt` files (the base fixture also seeds a
// README.md, which is irrelevant to these assertions).
async function filesAt(repoPath: string, sha: string): Promise<string[]> {
  const out = await $`git ls-tree -r --name-only ${sha}`.cwd(repoPath).quiet().text();
  return out
    .trim()
    .split("\n")
    .filter((f) => /^c\d+\.txt$/.test(f))
    .sort();
}

async function parentCount(repoPath: string, sha: string): Promise<number> {
  const out = await $`git rev-list --parents -n 1 ${sha}`.cwd(repoPath).quiet().text();
  return out.trim().split(/\s+/).length - 1;
}

describe("materialize", () => {
  test("materializes a merge group into a real merge commit with correct final tree", async () => {
    const repo = await makeRepo();
    // Stack: c1, c2, c3, c4. Group [c2,c3] as a merge; c1 and c4 plain.
    const { base, shas } = await linearStack(repo.path, ["c1", "c2", "c3", "c4"]);
    const [c1, c2, c3, c4] = shas as [string, string, string, string];
    const linearTip = c4;

    const plan: PlanNode[] = [
      { type: "commit", sha: c1 },
      { type: "merge", members: [c2, c3], message: "Merge: group X" },
      { type: "commit", sha: c4 },
    ];
    const result = await materialize(git, base, plan, { cwd: repo.path });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // One merge commit was created, and the final tip's content matches the
    // original linear stack tip (all four files present).
    expect(result.mergeShas).toHaveLength(1);
    expect(await filesAt(repo.path, result.newTip)).toEqual([
      "c1.txt",
      "c2.txt",
      "c3.txt",
      "c4.txt",
    ]);
    expect(await getTree(git, result.newTip, { cwd: repo.path })).toBe(
      await getTree(git, linearTip, { cwd: repo.path }),
    );

    // The merge commit has two parents.
    const merge = result.mergeShas[0]!;
    expect(await parentCount(repo.path, merge)).toBe(2);
  });

  test("determinism: re-materializing an unchanged group yields the identical merge SHA", async () => {
    const repo = await makeRepo();
    const { base, shas } = await linearStack(repo.path, ["c1", "c2", "c3"]);
    const [c1, c2, c3] = shas as [string, string, string];
    const plan: PlanNode[] = [
      { type: "commit", sha: c1 },
      { type: "merge", members: [c2, c3], message: "Merge: group X" },
    ];
    const r1 = await materialize(git, base, plan, { cwd: repo.path });
    const r2 = await materialize(git, base, plan, { cwd: repo.path });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // Same base + same plan (same member SHAs, same message, pinned env) => the
    // whole rebuild is content-addressed identical, merge SHA included.
    expect(r2.newTip).toBe(r1.newTip);
    expect(r2.mergeShas[0]).toBe(r1.mergeShas[0]);
  });

  test("inverse: materialize then flatten yields trees matching the original linear stack", async () => {
    const repo = await makeRepo();
    const { base, shas } = await linearStack(repo.path, ["c1", "c2", "c3", "c4"]);
    const [c1, c2, c3, c4] = shas as [string, string, string, string];
    const linearTip = c4;

    // Materialize [c2,c3] as a merge.
    const materialized = await materialize(
      git,
      base,
      [
        { type: "commit", sha: c1 },
        { type: "merge", members: [c2, c3], message: "Merge" },
        { type: "commit", sha: c4 },
      ],
      { cwd: repo.path },
    );
    expect(materialized.ok).toBe(true);

    // "Unmerge": express the same commits as an all-plain plan.
    const flattened = await materialize(
      git,
      base,
      [
        { type: "commit", sha: c1 },
        { type: "commit", sha: c2 },
        { type: "commit", sha: c3 },
        { type: "commit", sha: c4 },
      ],
      { cwd: repo.path },
    );
    expect(flattened.ok).toBe(true);
    if (!flattened.ok) return;

    // The flattened tip has the same content as the original linear stack tip,
    // and no merge commits.
    expect(flattened.mergeShas).toHaveLength(0);
    expect(await getTree(git, flattened.newTip, { cwd: repo.path })).toBe(
      await getTree(git, linearTip, { cwd: repo.path }),
    );
  });

  test("dropped-change trap: a merge over a plain commit carries the lower commit's file", async () => {
    // c1 plain, then merge[c2,c3]. c2/c3 are re-rooted onto c1's replay; the
    // 3-way merge must carry c1.txt through into the side branch and merge — a
    // verbatim tree reuse would drop it.
    const repo = await makeRepo();
    const { base, shas } = await linearStack(repo.path, ["c1", "c2", "c3"]);
    const [c1, c2, c3] = shas as [string, string, string];
    const result = await materialize(
      git,
      base,
      [
        { type: "commit", sha: c1 },
        { type: "merge", members: [c2, c3], message: "Merge" },
      ],
      { cwd: repo.path },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The merge tip must contain c1.txt (the lower plain commit's change), not
    // just c2/c3.
    expect(await filesAt(repo.path, result.newTip)).toEqual(["c1.txt", "c2.txt", "c3.txt"]);
  });

  test("a plan with only plain nodes is a plain rebuild (no merges)", async () => {
    const repo = await makeRepo();
    const { base, shas } = await linearStack(repo.path, ["c1", "c2"]);
    const [c1, c2] = shas as [string, string];
    const result = await materialize(
      git,
      base,
      [
        { type: "commit", sha: c1 },
        { type: "commit", sha: c2 },
      ],
      { cwd: repo.path },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mergeShas).toHaveLength(0);
    expect(await filesAt(repo.path, result.newTip)).toEqual(["c1.txt", "c2.txt"]);
  });

  test("single-commit merge group is allowed", async () => {
    const repo = await makeRepo();
    const { base, shas } = await linearStack(repo.path, ["c1"]);
    const [c1] = shas as [string];
    const result = await materialize(
      git,
      base,
      [{ type: "merge", members: [c1], message: "Solo merge" }],
      {
        cwd: repo.path,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mergeShas).toHaveLength(1);
    expect(await parentCount(repo.path, result.mergeShas[0]!)).toBe(2);
    expect(await filesAt(repo.path, result.newTip)).toEqual(["c1.txt"]);
  });
});

describe("buildMaterializePlan", () => {
  const hashById = { p1: "h1", m1: "h2", m2: "h3", p4: "h4" };
  const ordered = ["p1", "m1", "m2", "p4"];

  test("builds a plain+merge+plain plan for a contiguous merge group", () => {
    const specs: MergeGroupSpec[] = [{ memberIds: ["m1", "m2"], message: "Merge" }];
    const r = buildMaterializePlan(ordered, hashById, specs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toEqual([
      { type: "commit", sha: "h1" },
      { type: "merge", members: ["h2", "h3"], message: "Merge" },
      { type: "commit", sha: "h4" },
    ]);
  });

  test("rejects a non-contiguous merge group", () => {
    const specs: MergeGroupSpec[] = [{ memberIds: ["p1", "m2"], message: "Merge" }];
    const r = buildMaterializePlan(ordered, hashById, specs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/contiguous/i);
  });

  test("rejects a member that is not in the stack", () => {
    const specs: MergeGroupSpec[] = [{ memberIds: ["m1", "nope"], message: "Merge" }];
    const r = buildMaterializePlan(ordered, hashById, specs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not in the stack/i);
  });

  test("rejects a merge group spanning two PR groups (containment)", () => {
    const specs: MergeGroupSpec[] = [{ memberIds: ["m1", "m2"], message: "Merge" }];
    const prGroupById = { m1: "gA", m2: "gB" };
    const r = buildMaterializePlan(ordered, hashById, specs, prGroupById);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/more than one PR group|spans/i);
  });

  test("allows a merge group fully within one PR group", () => {
    const specs: MergeGroupSpec[] = [{ memberIds: ["m1", "m2"], message: "Merge" }];
    const prGroupById = { m1: "gA", m2: "gA" };
    const r = buildMaterializePlan(ordered, hashById, specs, prGroupById);
    expect(r.ok).toBe(true);
  });

  test("single-commit merge group is allowed", () => {
    const specs: MergeGroupSpec[] = [{ memberIds: ["m1"], message: "Solo" }];
    const r = buildMaterializePlan(ordered, hashById, specs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toContainEqual({ type: "merge", members: ["h2"], message: "Solo" });
  });

  test("rejects a commit in two merge groups", () => {
    const specs: MergeGroupSpec[] = [
      { memberIds: ["m1", "m2"], message: "A" },
      { memberIds: ["m2"], message: "B" },
    ];
    const r = buildMaterializePlan(ordered, hashById, specs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/more than one merge group/i);
  });
});
