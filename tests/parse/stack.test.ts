// tests/parse/stack.test.ts
import { test, expect, describe } from "bun:test";
import {
  detectPRUnits,
  parseStack,
  buildStackModel,
  flattenStackModel,
  type CommitWithTrailers,
} from "../../src/parse/stack.ts";
import type { CommitGroupMap, CommitMergeGroupMap } from "../../src/parse/types.ts";

function makeCommit(
  hash: string,
  subject: string,
  trailers: Record<string, string> = {},
): CommitWithTrailers {
  return { hash, subject, body: subject, trailers };
}

describe("detectPRUnits", () => {
  test("returns empty array for empty commits", () => {
    expect(detectPRUnits([])).toEqual([]);
  });

  test("creates singles for commits without group assignments", () => {
    const commits = [
      makeCommit("aaa111", "Add user model", { "Spry-Commit-Id": "a1b2c3d4" }),
      makeCommit("bbb222", "Add auth", { "Spry-Commit-Id": "b2c3d4e5" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ type: "single", id: "a1b2c3d4", commits: ["aaa111"] });
    expect(units[1]).toMatchObject({ type: "single", id: "b2c3d4e5", commits: ["bbb222"] });
  });

  test("creates group for contiguous commits assigned to the same group", () => {
    const commits = [
      makeCommit("aaa111", "Start auth", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "Add login", { "Spry-Commit-Id": "b2" }),
      makeCommit("ccc333", "Add 2FA", { "Spry-Commit-Id": "c3" }),
    ];
    const commitGroups: CommitGroupMap = { a1: "g1", b2: "g1", c3: "g1" };
    const units = detectPRUnits(commits, {}, commitGroups);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      type: "group",
      id: "g1",
      commits: ["aaa111", "bbb222", "ccc333"],
    });
  });

  test("handles mixed singles and groups", () => {
    const commits = [
      makeCommit("aaa111", "Single", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "Group start", { "Spry-Commit-Id": "b2" }),
      makeCommit("ccc333", "Group end", { "Spry-Commit-Id": "c3" }),
      makeCommit("ddd444", "Another single", { "Spry-Commit-Id": "d4" }),
    ];
    const commitGroups: CommitGroupMap = { b2: "g1", c3: "g1" };
    const units = detectPRUnits(commits, {}, commitGroups);
    expect(units).toHaveLength(3);
    expect(units[0]).toMatchObject({ type: "single", id: "a1" });
    expect(units[1]).toMatchObject({ type: "group", id: "g1" });
    expect(units[2]).toMatchObject({ type: "single", id: "d4" });
  });

  test("handles multiple consecutive groups", () => {
    const commits = [
      makeCommit("aaa111", "G1 c1", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "G1 c2", { "Spry-Commit-Id": "b2" }),
      makeCommit("ccc333", "G2 c1", { "Spry-Commit-Id": "c3" }),
      makeCommit("ddd444", "G2 c2", { "Spry-Commit-Id": "d4" }),
    ];
    const commitGroups: CommitGroupMap = { a1: "g1", b2: "g1", c3: "g2", d4: "g2" };
    const units = detectPRUnits(commits, {}, commitGroups);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ type: "group", id: "g1" });
    expect(units[1]).toMatchObject({ type: "group", id: "g2" });
  });

  test("handles commits without Spry-Commit-Id (uses hash prefix)", () => {
    const commits = [makeCommit("aaa111bb", "No ID", {})];
    const units = detectPRUnits(commits);
    expect(units[0]).toMatchObject({ id: "aaa111bb", commitIds: [] });
  });

  test("preserves oldest-first order", () => {
    const commits = [
      makeCommit("first", "First", { "Spry-Commit-Id": "id1" }),
      makeCommit("second", "Second", { "Spry-Commit-Id": "id2" }),
      makeCommit("third", "Third", { "Spry-Commit-Id": "id3" }),
    ];
    expect(detectPRUnits(commits).map((u) => u.commits[0])).toEqual(["first", "second", "third"]);
  });

  test("single-commit group", () => {
    const commits = [makeCommit("aaa111", "Lone grouped", { "Spry-Commit-Id": "a1" })];
    const commitGroups: CommitGroupMap = { a1: "g1" };
    const units = detectPRUnits(commits, {}, commitGroups);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ type: "group", id: "g1" });
  });

  test("uses title from GroupTitles when provided", () => {
    const commits = [makeCommit("aaa111", "First subject", { "Spry-Commit-Id": "a1" })];
    const commitGroups: CommitGroupMap = { a1: "g1" };
    const units = detectPRUnits(commits, { g1: "Custom Title" }, commitGroups);
    expect(units[0]?.title).toBe("Custom Title");
  });

  test("title is undefined when no GroupTitles entry", () => {
    const commits = [makeCommit("aaa111", "First subject", { "Spry-Commit-Id": "a1" })];
    const commitGroups: CommitGroupMap = { a1: "g1" };
    const units = detectPRUnits(commits, {}, commitGroups);
    expect(units[0]?.title).toBeUndefined();
  });

  test("single commits use their subject as title", () => {
    const commits = [makeCommit("aaa111", "My commit", { "Spry-Commit-Id": "a1" })];
    expect(detectPRUnits(commits)[0]?.title).toBe("My commit");
  });
});

describe("parseStack", () => {
  test("returns ok for valid stack", () => {
    const commits = [
      makeCommit("aaa111", "First", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "Second", { "Spry-Commit-Id": "b2" }),
    ];
    const result = parseStack(commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.units).toHaveLength(2);
  });

  test("returns ok for valid groups", () => {
    const commits = [
      makeCommit("aaa111", "G1", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "G1", { "Spry-Commit-Id": "b2" }),
    ];
    const commitGroups: CommitGroupMap = { a1: "g1", b2: "g1" };
    const result = parseStack(commits, {}, commitGroups);
    expect(result.ok).toBe(true);
  });

  test("returns split-group error for non-contiguous group", () => {
    const commits = [
      makeCommit("aaa111", "Group c1", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "Interrupting", { "Spry-Commit-Id": "b2" }),
      makeCommit("ccc333", "Group c2", { "Spry-Commit-Id": "c3" }),
    ];
    const commitGroups: CommitGroupMap = { a1: "g1", c3: "g1" };
    const result = parseStack(commits, {}, commitGroups);
    expect(result).toMatchObject({ ok: false, error: "split-group", group: { id: "g1" } });
    if (!result.ok && result.error === "split-group") {
      expect(result.group.commits).toContain("aaa111");
      expect(result.group.commits).toContain("ccc333");
      expect(result.interruptingCommits).toContain("bbb222");
    }
  });

  test("split-group with multiple interrupting commits", () => {
    const commits = [
      makeCommit("aaa111", "Group c1", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "Int 1", { "Spry-Commit-Id": "b2" }),
      makeCommit("ccc333", "Int 2", { "Spry-Commit-Id": "c3" }),
      makeCommit("ddd444", "Group c2", { "Spry-Commit-Id": "d4" }),
    ];
    const commitGroups: CommitGroupMap = { a1: "g1", d4: "g1" };
    const result = parseStack(commits, {}, commitGroups);
    expect(result).toMatchObject({ ok: false, error: "split-group" });
    if (!result.ok && result.error === "split-group") {
      expect(result.interruptingCommits).toHaveLength(2);
    }
  });

  test("returns ok for empty commits", () => {
    const result = parseStack([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.units).toEqual([]);
  });
});

function makeMerge(
  hash: string,
  subject: string,
  members: CommitWithTrailers[],
): CommitWithTrailers {
  // A merge commit: 2 parents (the actual SHAs don't matter to buildStackModel,
  // only that there are >= 2), plus its expanded side-branch members.
  return {
    hash,
    subject,
    body: subject,
    trailers: {},
    parents: ["p1", "p2"],
    mergeMembers: members,
  };
}

describe("buildStackModel", () => {
  test("all-plain stack yields all commit nodes", () => {
    const commits = [
      makeCommit("aaa", "c1", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb", "c2", { "Spry-Commit-Id": "b2" }),
    ];
    const model = buildStackModel(commits);
    expect(model.map((n) => n.type)).toEqual(["commit", "commit"]);
  });

  test("recognizes a merge commit and nests its members", () => {
    const m1 = makeCommit("m1h", "m1", { "Spry-Commit-Id": "m1" });
    const m2 = makeCommit("m2h", "m2", { "Spry-Commit-Id": "m2" });
    const merge = makeMerge("mergeh", "Merge: group X", [m1, m2]);
    const firstParent = [
      makeCommit("p1h", "p1", { "Spry-Commit-Id": "p1" }),
      merge,
      makeCommit("p4h", "p4", { "Spry-Commit-Id": "p4" }),
    ];
    const mergeGroups: CommitMergeGroupMap = { m1: "mg1", m2: "mg1" };
    const model = buildStackModel(firstParent, mergeGroups);

    expect(model.map((n) => n.type)).toEqual(["commit", "merge", "commit"]);
    const mergeNode = model[1];
    if (mergeNode?.type !== "merge") throw new Error("expected merge node");
    expect(mergeNode.mergeGroupId).toBe("mg1");
    expect(mergeNode.members.map((m) => m.subject)).toEqual(["m1", "m2"]);
    expect(mergeNode.merge.subject).toBe("Merge: group X");
  });

  test("merge with no matching record resolves mergeGroupId to null", () => {
    const merge = makeMerge("mergeh", "Merge", [
      makeCommit("m1h", "m1", { "Spry-Commit-Id": "m1" }),
    ]);
    const model = buildStackModel([merge], {}); // empty map
    const node = model[0];
    if (node?.type !== "merge") throw new Error("expected merge node");
    expect(node.mergeGroupId).toBeNull();
  });

  test("a commit with 2+ parents but no expanded members is still a merge node", () => {
    // Topology says merge (2 parents) even if members weren't expanded.
    const merge: CommitWithTrailers = {
      hash: "mh",
      subject: "Merge",
      body: "Merge",
      trailers: {},
      parents: ["p1", "p2"],
    };
    const model = buildStackModel([merge]);
    expect(model[0]?.type).toBe("merge");
  });
});

function c(
  hash: string,
  subject: string,
  id?: string,
  extra: Partial<CommitWithTrailers> = {},
): CommitWithTrailers {
  return { hash, subject, body: "", trailers: id ? { "Spry-Commit-Id": id } : {}, ...extra };
}

describe("detectPRUnits: merge units", () => {
  test("a merge commit becomes a single unit keyed by its merge-group id, with member ids", () => {
    const m1 = c("aaaa", "feat: add model", "m1m1m1m1");
    const m2 = c("bbbb", "feat: add handler", "m2m2m2m2");
    const merge = c("cccc", "Merge: feat: add model", undefined, {
      parents: ["pppp", "bbbb"],
      mergeMembers: [m1, m2],
    });
    const p1 = c("pppp", "feat: base", "p1p1p1p1");
    const units = detectPRUnits(
      [p1, merge],
      {},
      {},
      { m1m1m1m1: "mgmgmgmg", m2m2m2m2: "mgmgmgmg" },
    );
    expect(units).toHaveLength(2);
    const mergeUnit = units[1];
    expect(mergeUnit?.type).toBe("single");
    expect(mergeUnit?.id).toBe("mgmgmgmg");
    expect(mergeUnit?.commits).toEqual(["cccc"]);
    expect(mergeUnit?.commitIds).toEqual(["m1m1m1m1", "m2m2m2m2"]);
    expect(mergeUnit?.subjects).toEqual(["Merge: feat: add model"]);
    expect(mergeUnit?.mergeMembers?.map((m) => m.hash)).toEqual(["aaaa", "bbbb"]);
  });

  test("an unrecorded merge falls back to the merge SHA prefix but keeps member ids", () => {
    const m1 = c("aaaaaaaa1111", "feat: a", "m1m1m1m1");
    const merge = c("ccccdddd9999", "Merge: feat: a", undefined, {
      parents: ["pppp", "aaaaaaaa1111"],
      mergeMembers: [m1],
    });
    const units = detectPRUnits([merge], {}, {}, {});
    expect(units[0]?.id).toBe("ccccdddd");
    expect(units[0]?.commitIds).toEqual(["m1m1m1m1"]);
    expect(units[0]?.mergeMembers).toHaveLength(1);
  });

  test("a merge-free stack is byte-identical to before (new branch inert)", () => {
    const a = c("h1", "A", "aaa11111");
    const b = c("h2", "B", "bbb22222");
    const withMap = detectPRUnits([a, b], {}, {}, { aaa11111: "ignored" });
    const withoutMap = detectPRUnits([a, b], {}, {});
    expect(withMap).toEqual(withoutMap);
    expect(withMap[0]?.mergeMembers).toBeUndefined();
    expect(withMap[1]?.mergeMembers).toBeUndefined();
  });
});

describe("flattenStackModel", () => {
  test("splices merge members back in place, preserving order", () => {
    const m1 = makeCommit("m1h", "m1", { "Spry-Commit-Id": "m1" });
    const m2 = makeCommit("m2h", "m2", { "Spry-Commit-Id": "m2" });
    const model = buildStackModel([
      makeCommit("p1h", "p1", { "Spry-Commit-Id": "p1" }),
      makeMerge("mergeh", "Merge", [m1, m2]),
      makeCommit("p4h", "p4", { "Spry-Commit-Id": "p4" }),
    ]);
    const flat = flattenStackModel(model);
    expect(flat.map((c) => c.subject)).toEqual(["p1", "m1", "m2", "p4"]);
  });

  test("flattened members feed PR grouping unchanged (merge members join one group)", () => {
    // A merge group's members carry the SAME PR-group id => one group unit.
    const m1 = makeCommit("m1h", "m1", { "Spry-Commit-Id": "m1" });
    const m2 = makeCommit("m2h", "m2", { "Spry-Commit-Id": "m2" });
    const model = buildStackModel([
      makeCommit("p1h", "p1", { "Spry-Commit-Id": "p1" }),
      makeMerge("mergeh", "Merge", [m1, m2]),
    ]);
    const flat = flattenStackModel(model);
    const commitGroups: CommitGroupMap = { p1: "g1", m1: "g1", m2: "g1" };
    const result = parseStack(flat, {}, commitGroups);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.units).toHaveLength(1);
      expect(result.units[0]).toMatchObject({ type: "group", id: "g1" });
      expect(result.units[0]?.commits).toEqual(["p1h", "m1h", "m2h"]);
    }
  });
});
