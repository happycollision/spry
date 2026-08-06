import { describe, test, expect } from "bun:test";
import { classifyScope, renderReinvokeHint } from "../../src/commands/land-poll.ts";
import type { UnitBlockers } from "../../src/commands/stack-analysis.ts";

const CI_PENDING = "CI checks are still running";

function blocked(branch: string, reasons: string[]): UnitBlockers {
  // `unit` is unused by classifyScope; a minimal stand-in keeps the test focused.
  return { unit: { id: branch } as never, branch, reasons };
}

// Minimal PRInfo-shaped map: classifyScope only reads `.number` off each entry.
function prNumbers(m: Record<string, number>): Map<string, { number: number } | null> {
  return new Map(Object.entries(m).map(([b, n]) => [b, { number: n }]));
}

describe("classifyScope", () => {
  test("no blockers → ready", () => {
    const v = classifyScope({ blocked: false, perUnit: [] }, prNumbers({}));
    expect(v.kind).toBe("ready");
  });

  test("sole reason CI-pending on every blocked unit → ci-pending with PR numbers", () => {
    const v = classifyScope(
      {
        blocked: true,
        perUnit: [blocked("spry/a", [CI_PENDING]), blocked("spry/b", [CI_PENDING])],
      },
      prNumbers({ "spry/a": 1, "spry/b": 2 }),
    );
    expect(v.kind).toBe("ci-pending");
    if (v.kind === "ci-pending") expect(v.prNumbers).toEqual([1, 2]);
  });

  test("ci-pending: a unit with no PR-number entry is dropped from prNumbers", () => {
    const v = classifyScope(
      {
        blocked: true,
        perUnit: [blocked("spry/a", [CI_PENDING]), blocked("spry/b", [CI_PENDING])],
      },
      prNumbers({ "spry/a": 1 }), // spry/b absent → undefined → dropped
    );
    expect(v.kind).toBe("ci-pending");
    if (v.kind === "ci-pending") expect(v.prNumbers).toEqual([1]);
  });

  test("CI failing → hard", () => {
    const v = classifyScope(
      { blocked: true, perUnit: [blocked("spry/a", ["CI checks are failing"])] },
      prNumbers({ "spry/a": 1 }),
    );
    expect(v.kind).toBe("hard");
  });

  test("CI pending AND changes requested on one unit → hard (mixed is not pollable)", () => {
    const v = classifyScope(
      { blocked: true, perUnit: [blocked("spry/a", [CI_PENDING, "Changes have been requested"])] },
      prNumbers({ "spry/a": 1 }),
    );
    expect(v.kind).toBe("hard");
  });

  test("one unit CI-pending, another changes-requested → hard", () => {
    const v = classifyScope(
      {
        blocked: true,
        perUnit: [
          blocked("spry/a", [CI_PENDING]),
          blocked("spry/b", ["Changes have been requested"]),
        ],
      },
      prNumbers({ "spry/a": 1, "spry/b": 2 }),
    );
    expect(v.kind).toBe("hard");
  });
});

describe("renderReinvokeHint", () => {
  test("embeds the through id and --poll", () => {
    expect(renderReinvokeHint("bbb22222")).toBe(
      "Run `sp land --through bbb22222 --poll` to wait for CI and land automatically.",
    );
  });
});
