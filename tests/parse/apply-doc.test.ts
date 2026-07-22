import { test, expect } from "bun:test";
import { parseApplyDoc, reconcile } from "../../src/parse/apply-doc.ts";
import type { GroupRecords } from "../../src/parse/types.ts";

function ok(json: string) {
  const r = parseApplyDoc(json);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.doc;
}
function err(json: string): string {
  const r = parseApplyDoc(json);
  if (r.ok) throw new Error("expected error");
  return r.error;
}

test("malformed JSON errors", () => {
  expect(err("{not json")).toMatch(/json/i);
});

test("missing type errors", () => {
  expect(err(JSON.stringify({ stack: [{ id: "aaaaaaaa" }] }))).toMatch(/type/i);
});

test("commit with missing id errors (omission != null)", () => {
  expect(err(JSON.stringify({ stack: [{ type: "commit" }] }))).toMatch(/id/i);
});

test("commit with id:null errors (only new groups may be null)", () => {
  expect(err(JSON.stringify({ stack: [{ type: "commit", id: null }] }))).toMatch(/null/i);
});

test("sha present as input field errors", () => {
  expect(
    err(JSON.stringify({ stack: [{ type: "commit", id: "aaaaaaaa", sha: "deadbeef" }] })),
  ).toMatch(/sha/i);
});

test("empty group errors", () => {
  expect(err(JSON.stringify({ stack: [{ type: "group", id: null, commits: [] }] }))).toMatch(
    /empty|member/i,
  );
});

test("group with no commits key errors", () => {
  expect(err(JSON.stringify({ stack: [{ type: "group", id: null }] }))).toMatch(/commits/i);
});

test("reissueId:true with id:null errors (contradiction)", () => {
  expect(
    err(
      JSON.stringify({
        stack: [
          {
            type: "group",
            id: null,
            reissueId: true,
            commits: [{ type: "commit", id: "aaaaaaaa" }],
          },
        ],
      }),
    ),
  ).toMatch(/reissue|contradiction|null/i);
});

test("pr value other than CLOSE/ADOPT errors", () => {
  expect(err(JSON.stringify({ stack: [{ type: "commit", id: "aaaaaaaa", pr: "MERGE" }] }))).toMatch(
    /pr/i,
  );
});

test("duplicate commit id across positions errors", () => {
  expect(
    err(
      JSON.stringify({
        stack: [
          { type: "commit", id: "aaaaaaaa" },
          { type: "commit", id: "aaaaaaaa" },
        ],
      }),
    ),
  ).toMatch(/duplicate/i);
});

test("title tri-state: omitted -> {set:false}, null -> {set:true,null}, string -> {set:true,value}", () => {
  const omitted = ok(
    JSON.stringify({
      stack: [{ type: "group", id: null, commits: [{ type: "commit", id: "aaaaaaaa" }] }],
    }),
  );
  const g0 = omitted.stack[0]!;
  if (g0.kind !== "group") throw new Error("group");
  expect(g0.titleField).toEqual({ set: false });

  const wiped = ok(
    JSON.stringify({
      stack: [
        { type: "group", id: null, title: null, commits: [{ type: "commit", id: "aaaaaaaa" }] },
      ],
    }),
  );
  const g1 = wiped.stack[0]!;
  if (g1.kind !== "group") throw new Error("group");
  expect(g1.titleField).toEqual({ set: true, value: null });

  const setStr = ok(
    JSON.stringify({
      stack: [
        {
          type: "group",
          id: "aaaaaaaa",
          title: "T",
          commits: [{ type: "commit", id: "aaaaaaaa" }],
        },
      ],
    }),
  );
  const g2 = setStr.stack[0]!;
  if (g2.kind !== "group") throw new Error("group");
  expect(g2.titleField).toEqual({ set: true, value: "T" });
});

test("empty title string is treated as wipe (set:true,null)", () => {
  const doc = ok(
    JSON.stringify({
      stack: [
        { type: "group", id: null, title: "", commits: [{ type: "commit", id: "aaaaaaaa" }] },
      ],
    }),
  );
  const g = doc.stack[0]!;
  if (g.kind !== "group") throw new Error("group");
  expect(g.titleField).toEqual({ set: true, value: null });
});

test("valid minimal doc parses", () => {
  const doc = ok(JSON.stringify({ stack: [{ type: "commit", id: "aaaaaaaa" }] }));
  expect(doc.stack).toHaveLength(1);
  expect(doc.stack[0]!).toMatchObject({ kind: "commit", id: "aaaaaaaa", reissueId: false });
});

test("parseApplyDoc: missing/non-array stack root errors", () => {
  expect(err("{}")).toMatch(/stack/i);
  expect(err(JSON.stringify({ stack: {} }))).toMatch(/stack/i);
});
test("parseApplyDoc: nested member missing id errors with path", () => {
  expect(
    err(JSON.stringify({ stack: [{ type: "group", id: null, commits: [{ type: "commit" }] }] })),
  ).toMatch(/id/i);
});
test("parseApplyDoc: nested group inside group commits errors", () => {
  expect(
    err(
      JSON.stringify({
        stack: [
          {
            type: "group",
            id: null,
            commits: [{ type: "group", id: null, commits: [{ type: "commit", id: "aaaaaaaa" }] }],
          },
        ],
      }),
    ),
  ).toMatch(/commit/i);
});

function recOk(
  json: string,
  live: {
    liveIds: string[];
    liveHashById: Record<string, string>;
    liveGroups?: GroupRecords;
    openPrIds?: string[];
  },
) {
  const p = parseApplyDoc(json);
  if (!p.ok) throw new Error(`parse failed: ${p.error}`);
  const r = reconcile(p.doc, {
    liveIds: live.liveIds,
    liveHashById: live.liveHashById,
    liveGroups: live.liveGroups ?? {},
    openPrIds: new Set(live.openPrIds ?? []),
  });
  if (!r.ok) throw new Error(`reconcile failed: ${r.error}`);
  return r.plan;
}
function recErr(
  json: string,
  live: {
    liveIds: string[];
    liveHashById: Record<string, string>;
    liveGroups?: GroupRecords;
    openPrIds?: string[];
  },
): string {
  const p = parseApplyDoc(json);
  if (!p.ok) return p.error;
  const r = reconcile(p.doc, {
    liveIds: live.liveIds,
    liveHashById: live.liveHashById,
    liveGroups: live.liveGroups ?? {},
    openPrIds: new Set(live.openPrIds ?? []),
  });
  return r.ok ? "" : r.error;
}

const LIVE2 = {
  liveIds: ["aaaaaaaa", "bbbbbbbb"],
  liveHashById: { aaaaaaaa: "h_a", bbbbbbbb: "h_b" },
};

test("reconcile: doc omits a live commit -> missing-id error", () => {
  expect(recErr(JSON.stringify({ stack: [{ type: "commit", id: "aaaaaaaa" }] }), LIVE2)).toMatch(
    /missing|account/i,
  );
});

test("reconcile: doc names a non-live id -> unknown-id error", () => {
  expect(
    recErr(
      JSON.stringify({
        stack: [
          { type: "commit", id: "aaaaaaaa" },
          { type: "commit", id: "bbbbbbbb" },
          { type: "commit", id: "cccccccc" },
        ],
      }),
      LIVE2,
    ),
  ).toMatch(/unknown|not.*live|not present/i);
});

test("reconcile: complete ungrouped doc -> empty records, order matches -> newOrder null", () => {
  const plan = recOk(
    JSON.stringify({
      stack: [
        { type: "commit", id: "aaaaaaaa" },
        { type: "commit", id: "bbbbbbbb" },
      ],
    }),
    LIVE2,
  );
  expect(plan.records).toEqual({});
  expect(plan.newOrder).toBeNull();
});

test("reconcile: reversed order -> newOrder is hashes in doc order", () => {
  const plan = recOk(
    JSON.stringify({
      stack: [
        { type: "commit", id: "bbbbbbbb" },
        { type: "commit", id: "aaaaaaaa" },
      ],
    }),
    LIVE2,
  );
  expect(plan.newOrder).toEqual(["h_b", "h_a"]);
});

test("reconcile: new group (id:null) -> minted 8-hex id, members recorded", () => {
  const plan = recOk(
    JSON.stringify({
      stack: [
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
    }),
    LIVE2,
  );
  const ids = Object.keys(plan.records);
  expect(ids).toHaveLength(1);
  expect(ids[0]).toMatch(/^[0-9a-f]{8}$/);
  expect(plan.records[ids[0]!]).toEqual({ title: "G", members: ["aaaaaaaa", "bbbbbbbb"] });
});

test("reconcile: title omitted on existing group -> retains stored title", () => {
  const liveGroups: GroupRecords = {
    aaaaaaaa: { title: "Old", members: ["aaaaaaaa", "bbbbbbbb"] },
  };
  const plan = recOk(
    JSON.stringify({
      stack: [
        {
          type: "group",
          id: "aaaaaaaa",
          commits: [
            { type: "commit", id: "aaaaaaaa" },
            { type: "commit", id: "bbbbbbbb" },
          ],
        },
      ],
    }),
    { ...LIVE2, liveGroups, openPrIds: ["aaaaaaaa"] },
  );
  expect(plan.records["aaaaaaaa"]!.title).toBe("Old");
});

test("reconcile: title null on group -> wiped to empty", () => {
  const liveGroups: GroupRecords = {
    aaaaaaaa: { title: "Old", members: ["aaaaaaaa", "bbbbbbbb"] },
  };
  const plan = recOk(
    JSON.stringify({
      stack: [
        {
          type: "group",
          id: "aaaaaaaa",
          title: null,
          commits: [
            { type: "commit", id: "aaaaaaaa" },
            { type: "commit", id: "bbbbbbbb" },
          ],
        },
      ],
    }),
    { ...LIVE2, liveGroups, openPrIds: ["aaaaaaaa"] },
  );
  expect(plan.records["aaaaaaaa"]!.title).toBe("");
});

test("reconcile: reissue a commit with open PR without pr:CLOSE -> error", () => {
  expect(
    recErr(
      JSON.stringify({
        stack: [
          { type: "commit", id: "aaaaaaaa", reissueId: true },
          { type: "commit", id: "bbbbbbbb" },
        ],
      }),
      { ...LIVE2, openPrIds: ["aaaaaaaa"] },
    ),
  ).toMatch(/close|acknowledge/i);
});

test("reconcile: reissue with pr:CLOSE -> reissueIds + prCloses set", () => {
  const plan = recOk(
    JSON.stringify({
      stack: [
        { type: "commit", id: "aaaaaaaa", reissueId: true, pr: "CLOSE" },
        { type: "commit", id: "bbbbbbbb" },
      ],
    }),
    { ...LIVE2, openPrIds: ["aaaaaaaa"] },
  );
  expect(plan.reissueIds).toContain("aaaaaaaa");
  expect(plan.prCloses).toContain("aaaaaaaa");
});

test("reconcile: pr:CLOSE where nothing would close -> error", () => {
  expect(
    recErr(
      JSON.stringify({
        stack: [
          { type: "commit", id: "aaaaaaaa", pr: "CLOSE" },
          { type: "commit", id: "bbbbbbbb" },
        ],
      }),
      LIVE2,
    ),
  ).toMatch(/nothing.*close|no.*pr/i);
});

test("reconcile: group adopts member PR (id=member) requires pr:ADOPT", () => {
  expect(
    recErr(
      JSON.stringify({
        stack: [
          {
            type: "group",
            id: "aaaaaaaa",
            commits: [
              { type: "commit", id: "aaaaaaaa" },
              { type: "commit", id: "bbbbbbbb" },
            ],
          },
        ],
      }),
      { ...LIVE2, openPrIds: ["aaaaaaaa"] },
    ),
  ).toMatch(/adopt/i);
});

test("reconcile: pr:ADOPT where declared id has no open PR -> error", () => {
  expect(
    recErr(
      JSON.stringify({
        stack: [
          {
            type: "group",
            id: "aaaaaaaa",
            pr: "ADOPT",
            commits: [
              { type: "commit", id: "aaaaaaaa" },
              { type: "commit", id: "bbbbbbbb" },
            ],
          },
        ],
      }),
      LIVE2,
    ),
  ).toMatch(/adopt|no.*pr/i);
});

test("reconcile: group id equal to a NON-member live id -> foreign identity error", () => {
  const live3 = {
    liveIds: ["aaaaaaaa", "bbbbbbbb", "cccccccc"],
    liveHashById: { aaaaaaaa: "h_a", bbbbbbbb: "h_b", cccccccc: "h_c" },
  };
  expect(
    recErr(
      JSON.stringify({
        stack: [
          {
            type: "group",
            id: "cccccccc",
            pr: "ADOPT",
            commits: [
              { type: "commit", id: "aaaaaaaa" },
              { type: "commit", id: "bbbbbbbb" },
            ],
          },
          { type: "commit", id: "cccccccc" },
        ],
      }),
      { ...live3, openPrIds: ["cccccccc"] },
    ),
  ).toMatch(/foreign|not a member|member/i);
});

test("reconcile: existing group with a MINTED (non-member) id is editable, no ADOPT needed", () => {
  // A group created earlier with id:null got a minted id "99999999" that is NOT
  // any member's id. A round-tripped doc references it by that id; editing it
  // (e.g. renaming) must succeed WITHOUT pr:ADOPT and WITHOUT a foreign-identity error.
  const liveGroups: GroupRecords = {
    "99999999": { title: "Old", members: ["aaaaaaaa", "bbbbbbbb"] },
  };
  const plan = recOk(
    JSON.stringify({
      stack: [
        {
          type: "group",
          id: "99999999",
          title: "Renamed",
          commits: [
            { type: "commit", id: "aaaaaaaa" },
            { type: "commit", id: "bbbbbbbb" },
          ],
        },
      ],
    }),
    { ...LIVE2, liveGroups },
  );
  expect(plan.records["99999999"]).toEqual({ title: "Renamed", members: ["aaaaaaaa", "bbbbbbbb"] });
  expect(plan.prAdopts).not.toContain("99999999");
});

test("reconcile: pr:ADOPT on an already-existing (already-held) group -> error", () => {
  const liveGroups: GroupRecords = { aaaaaaaa: { title: "G", members: ["aaaaaaaa", "bbbbbbbb"] } };
  expect(
    recErr(
      JSON.stringify({
        stack: [
          {
            type: "group",
            id: "aaaaaaaa",
            pr: "ADOPT",
            commits: [
              { type: "commit", id: "aaaaaaaa" },
              { type: "commit", id: "bbbbbbbb" },
            ],
          },
        ],
      }),
      { ...LIVE2, liveGroups, openPrIds: ["aaaaaaaa"] },
    ),
  ).toMatch(/already holds|remove pr:ADOPT|adopt/i);
});

test("reconcile: reissuing a grouped member is rejected in v1", () => {
  expect(
    recErr(
      JSON.stringify({
        stack: [
          {
            type: "group",
            id: null,
            commits: [
              { type: "commit", id: "aaaaaaaa", reissueId: true, pr: "CLOSE" },
              { type: "commit", id: "bbbbbbbb" },
            ],
          },
        ],
      }),
      { ...LIVE2, openPrIds: ["aaaaaaaa"] },
    ),
  ).toMatch(/member of a group|ungroup|not supported/i);
});

test("reconcile: group newly adopts a member's open PR -> prAdopts + records set", () => {
  const plan = recOk(
    JSON.stringify({
      stack: [
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
    }),
    { ...LIVE2, openPrIds: ["aaaaaaaa"] },
  ); // aaaaaaaa NOT in liveGroups -> adoption transition
  expect(plan.prAdopts).toEqual(["aaaaaaaa"]);
  expect(plan.records["aaaaaaaa"]).toEqual({ title: "G", members: ["aaaaaaaa", "bbbbbbbb"] });
});

test("reconcile: reissue an existing group with open PR requires pr:CLOSE", () => {
  const liveGroups: GroupRecords = {
    "99999999": { title: "G", members: ["aaaaaaaa", "bbbbbbbb"] },
  };
  expect(
    recErr(
      JSON.stringify({
        stack: [
          {
            type: "group",
            id: "99999999",
            reissueId: true,
            commits: [
              { type: "commit", id: "aaaaaaaa" },
              { type: "commit", id: "bbbbbbbb" },
            ],
          },
        ],
      }),
      { ...LIVE2, liveGroups, openPrIds: ["99999999"] },
    ),
  ).toMatch(/close/i);
});

test("reconcile: reissue an existing group with pr:CLOSE -> reissueIds + prCloses", () => {
  const liveGroups: GroupRecords = {
    "99999999": { title: "G", members: ["aaaaaaaa", "bbbbbbbb"] },
  };
  const plan = recOk(
    JSON.stringify({
      stack: [
        {
          type: "group",
          id: "99999999",
          reissueId: true,
          pr: "CLOSE",
          commits: [
            { type: "commit", id: "aaaaaaaa" },
            { type: "commit", id: "bbbbbbbb" },
          ],
        },
      ],
    }),
    { ...LIVE2, liveGroups, openPrIds: ["99999999"] },
  );
  expect(plan.reissueIds).toContain("99999999");
  expect(plan.prCloses).toContain("99999999");
});

test("reconcile: reissue + reorder in one doc -> error", () => {
  expect(
    recErr(
      JSON.stringify({
        stack: [
          { type: "commit", id: "bbbbbbbb" },
          { type: "commit", id: "aaaaaaaa", reissueId: true, pr: "CLOSE" },
        ],
      }),
      { ...LIVE2, openPrIds: ["aaaaaaaa"] },
    ),
  ).toMatch(/reorder.*reissue|separate/i);
});
