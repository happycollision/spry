// tests/parse/stack-tree.test.ts
import { test, expect, describe } from "bun:test";
import { buildStackTree } from "../../src/parse/stack-tree.ts";
import type { EnrichedUnit } from "../../src/gh/enrich.ts";
import type { Drift } from "../../src/git/drift.ts";
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
  if (c0.type !== "commit") throw new Error("expected commit node");
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

describe("buildStackTree drift", () => {
  test("emits localAhead/remoteAhead per unit", () => {
    const enriched: EnrichedUnit[] = [{ unit: single("aaaaaaaa", "feat: a", "hash_a"), pr: null }];
    const drift: Drift[] = [{ localAhead: true, remoteAhead: false }];
    const tree = buildStackTree(enriched, drift);
    expect(tree.stack[0]).toMatchObject({ localAhead: true, remoteAhead: false });
  });

  test("defaults to false when drift missing for an index", () => {
    const enriched: EnrichedUnit[] = [{ unit: single("aaaaaaaa", "feat: a", "hash_a"), pr: null }];
    const tree = buildStackTree(enriched, []);
    expect(tree.stack[0]).toMatchObject({ localAhead: false, remoteAhead: false });
  });
});

// --- merge nodes (step 5) ---
import { wrapMergeNodes } from "../../src/parse/stack-tree.ts";
import type { StackTreeCommit } from "../../src/parse/types.ts";

function c(id: string): StackTreeCommit {
  return { type: "commit", id, sha: `h_${id}`, subject: `s ${id}` };
}

describe("wrapMergeNodes", () => {
  test("passes plain commits through when no merge groups", () => {
    const out = wrapMergeNodes([c("a"), c("b")], {});
    expect(out.map((n) => n.type)).toEqual(["commit", "commit"]);
  });

  test("wraps a contiguous run sharing a merge-group id into one merge node", () => {
    const out = wrapMergeNodes([c("a"), c("b"), c("cc")], { b: "mg1", cc: "mg1" });
    expect(out.map((n) => n.type)).toEqual(["commit", "merge"]);
    const merge = out[1];
    if (merge?.type !== "merge") throw new Error("expected merge");
    expect(merge.id).toBe("mg1");
    expect(merge.commits.map((x) => x.id)).toEqual(["b", "cc"]);
  });

  test("two separate merge groups become two merge nodes", () => {
    const out = wrapMergeNodes([c("a"), c("b"), c("cc"), c("d")], { a: "m1", cc: "m2", d: "m2" });
    expect(out.map((n) => n.type)).toEqual(["merge", "commit", "merge"]);
  });

  test("single-commit merge group wraps into a one-member merge node", () => {
    const out = wrapMergeNodes([c("a")], { a: "m1" });
    expect(out[0]?.type).toBe("merge");
    if (out[0]?.type === "merge") expect(out[0].commits).toHaveLength(1);
  });
});

describe("buildStackTree with merge groups", () => {
  test("wraps top-level singles belonging to a merge group", () => {
    const units: PRUnit[] = [
      single("p1p1p1p1", "p1", "hp1"),
      single("m1m1m1m1", "m1", "hm1"),
      single("m2m2m2m2", "m2", "hm2"),
    ];
    const enriched: EnrichedUnit[] = units.map((unit) => ({ unit, pr: null }));
    const tree = buildStackTree(enriched, [], { m1m1m1m1: "mg1", m2m2m2m2: "mg1" });
    expect(tree.stack.map((n) => n.type)).toEqual(["commit", "merge"]);
    const merge = tree.stack[1];
    if (merge?.type !== "merge") throw new Error("expected merge");
    expect(merge.id).toBe("mg1");
    expect(merge.commits.map((x) => x.id)).toEqual(["m1m1m1m1", "m2m2m2m2"]);
  });

  test("wraps a merge nested inside a PR group's commits", () => {
    const units: PRUnit[] = [
      group("grp", "G", ["c1", "c2", "c3"], ["h1", "h2", "h3"], ["s1", "s2", "s3"]),
    ];
    const enriched: EnrichedUnit[] = units.map((unit) => ({ unit, pr: null }));
    const tree = buildStackTree(enriched, [], { c2: "mg1", c3: "mg1" });
    const g = tree.stack[0];
    if (g?.type !== "group") throw new Error("expected group");
    expect(g.commits.map((x) => x.type)).toEqual(["commit", "merge"]);
  });
});
