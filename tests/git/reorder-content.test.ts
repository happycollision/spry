// tests/git/reorder-content.test.ts
import { test, expect, afterAll } from "bun:test";
import { createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/repo.ts";
import { rebasePlumbing, finalizeRewrite } from "../../src/git/index.ts";

const repos: TestRepo[] = [];
afterAll(async () => {
  while (repos.length) await repos.pop()!.cleanup();
});

test("reorder preserves every commit's file content (no snapshot-tree loss)", async () => {
  const repo = await createRepo();
  repos.push(repo);

  // trunk baseline
  const baseSha = await repo.commitFiles({ "base.txt": "base" }, "base");

  // three commits, each adds its OWN file
  await repo.commitFiles({ "a.txt": "A" }, "add a");
  await repo.commitFiles({ "b.txt": "B" }, "add b");
  await repo.commitFiles({ "c.txt": "C" }, "add c");

  // hashes bottom→top
  const log = await repo.git.run(
    ["log", "--format=%H", `${repo.defaultBranch}~3..${repo.defaultBranch}`],
    { cwd: repo.path },
  );
  const hashesTopFirst = log.stdout.trim().split("\n"); // git log is newest-first
  const bottomToTop = [...hashesTopFirst].reverse(); // [a, b, c]
  const oldTip = hashesTopFirst[0]!; // c

  // reorder so a DIFFERENT commit ends up on top: [a, c, b]
  const newOrder = [bottomToTop[0]!, bottomToTop[2]!, bottomToTop[1]!];

  const result = await rebasePlumbing(repo.git, baseSha, newOrder, { cwd: repo.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected clean reorder");
  await finalizeRewrite(repo.git, repo.defaultBranch, oldTip, result.newTip, { cwd: repo.path });

  // the working tree / tip must contain all four files
  const files = await repo.git.run(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo.path });
  const names = files.stdout.trim().split("\n");
  expect(names).toContain("a.txt");
  expect(names).toContain("b.txt");
  expect(names).toContain("c.txt");
  expect(names).toContain("base.txt");

  // the resulting commit order must match the requested reorder [a, c, b]
  const subjects = await repo.git.run(["log", "--format=%s", `${baseSha}..HEAD`], {
    cwd: repo.path,
  });
  const order = subjects.stdout.trim().split("\n"); // newest-first
  expect(order).toEqual(["add b", "add c", "add a"]);
});
