import { test, expect } from "bun:test";
import { parseApplyDoc } from "../../src/parse/apply-doc.ts";

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
