// tests/parse/stack-tree.test.ts
import { test, expect } from "bun:test";
import { buildStackTree } from "../../src/parse/stack-tree.ts";
import type { EnrichedUnit } from "../../src/gh/enrich.ts";
import type { PRUnit } from "../../src/parse/types.ts";

function single(id: string, subject: string, hash: string): PRUnit {
  return {
    type: "single",
    id,
    title: undefined,
    commitIds: [id],
    commits: [hash],
    subjects: [subject],
  };
}
function group(
  id: string,
  title: string,
  ids: string[],
  hashes: string[],
  subjects: string[],
): PRUnit {
  return { type: "group", id, title, commitIds: ids, commits: hashes, subjects };
}

test("buildStackTree emits commit and group nodes with PR state", () => {
  const units: PRUnit[] = [
    single("aaaaaaaa", "feat: a", "hash_a"),
    group(
      "bbbbbbbb",
      "My group",
      ["bbbbbbbb", "cccccccc"],
      ["hash_b", "hash_c"],
      ["feat: b", "feat: c"],
    ),
  ];
  const enriched: EnrichedUnit[] = [
    {
      unit: units[0]!,
      pr: {
        number: 12,
        url: "",
        state: "OPEN",
        title: "",
        baseRefName: "",
        checksStatus: "none",
        reviewDecision: "none",
        reviewThreads: { resolved: 0, total: 0 },
      },
    },
    { unit: units[1]!, pr: null },
  ];

  const tree = buildStackTree(enriched);

  expect(tree.stack).toHaveLength(2);
  const c0 = tree.stack[0]!;
  expect(c0).toMatchObject({ type: "commit", id: "aaaaaaaa", sha: "hash_a", subject: "feat: a" });
  expect(c0.pr).toEqual({ number: 12, state: "OPEN" });

  const g = tree.stack[1]!;
  expect(g.type).toBe("group");
  if (g.type !== "group") throw new Error("expected group");
  expect(g).toMatchObject({ id: "bbbbbbbb", title: "My group" });
  expect(g.pr).toBeNull();
  expect(g.commits).toHaveLength(2);
  expect(g.commits[0]).toMatchObject({
    type: "commit",
    id: "bbbbbbbb",
    sha: "hash_b",
    subject: "feat: b",
  });
  expect(g.commits[1]).toMatchObject({
    type: "commit",
    id: "cccccccc",
    sha: "hash_c",
    subject: "feat: c",
  });
});
