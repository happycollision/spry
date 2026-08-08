import { describe, test, expect } from "bun:test";
import { formatPRTitle, stripTrailers } from "../../src/gh/pr-body.ts";
import type { CommitInfo, PRUnit } from "../../src/parse/types.ts";

function commit(hash: string, subject: string, body: string): CommitInfo {
  return { hash, subject, body, trailers: {} };
}

function singleUnit(id: string, hash: string, subject: string): PRUnit {
  return {
    type: "single",
    id,
    title: subject,
    commitIds: [id],
    commits: [hash],
    subjects: [subject],
  };
}

describe("stripTrailers", () => {
  test("returns body unchanged when there are no trailers", () => {
    expect(stripTrailers("Just prose.\nMore prose.")).toBe("Just prose.\nMore prose.");
  });

  test("strips a contiguous trailer block at the end", () => {
    const body = "Prose paragraph.\n\nSpry-Commit-Id: aaa11111\nCo-Authored-By: A <a@x>";
    expect(stripTrailers(body)).toBe("Prose paragraph.");
  });

  test("strips ALL trailer types (Spry, Co-Authored-By, Signed-off-by)", () => {
    const body =
      "Description.\n\nSigned-off-by: B <b@x>\nCo-Authored-By: A <a@x>\nSpry-Commit-Id: aaa11111";
    expect(stripTrailers(body)).toBe("Description.");
  });

  test("returns empty string when body is only trailers", () => {
    const body = "Spry-Commit-Id: aaa11111\nCo-Authored-By: A <a@x>";
    expect(stripTrailers(body)).toBe("");
  });

  test("does not strip a line that looks like a trailer but is not at the end", () => {
    const body = "Discussion: see ticket #1\n\nThis paragraph follows.";
    expect(stripTrailers(body)).toBe("Discussion: see ticket #1\n\nThis paragraph follows.");
  });

  test("requires a blank line before the trailer block", () => {
    const body = "Prose ends here.\nSpry-Commit-Id: aaa11111";
    // No blank line → not a real trailer block; keep as-is (sans trailing whitespace)
    expect(stripTrailers(body)).toBe("Prose ends here.\nSpry-Commit-Id: aaa11111");
  });

  test("trims trailing blank lines", () => {
    expect(stripTrailers("Prose.\n\n\n")).toBe("Prose.");
  });
});

describe("formatPRTitle", () => {
  test("returns commit subject for a single unit", () => {
    const unit = singleUnit("aaa11111", "abc", "Add login page");
    const commits = [commit("abc", "Add login page", "")];
    expect(formatPRTitle(unit, commits)).toBe("Add login page");
  });

  test("falls back to unit.title when commit not found in list", () => {
    const unit = singleUnit("aaa11111", "missing", "Cached title");
    expect(formatPRTitle(unit, [])).toBe("Cached title");
  });
});

// --- merge-note region (step 8) ---
import {
  generateMergeNote,
  buildInitialBody,
  spliceBody,
  MARKERS,
  type MergeNote,
} from "../../src/gh/pr-body.ts";

describe("generateMergeNote", () => {
  test("empty for no merges", () => {
    expect(generateMergeNote([])).toBe("");
  });

  test("one merge: warning + one relationship block, members newest-first", () => {
    const merges: MergeNote[] = [
      {
        subject: "Ship auth",
        memberSubjects: ["add model", "add handler"],
        mergeParentSubject: "base",
      },
    ];
    const out = generateMergeNote(merges);
    expect(out).toMatch(/contains 1 merge commit\b/i);
    expect(out).toContain("Merge: Ship auth");
    // newest-first under the side branch
    const iHandler = out.indexOf("add handler");
    const iModel = out.indexOf("add model");
    expect(iHandler).toBeGreaterThan(-1);
    expect(iHandler).toBeLessThan(iModel);
    expect(out).toContain("* base");
  });

  test("two merges: plural warning + two blocks", () => {
    const out = generateMergeNote([
      { subject: "A", memberSubjects: ["a1"] },
      { subject: "B", memberSubjects: ["b1"] },
    ]);
    expect(out).toMatch(/contains 2 merge commits/i);
    expect(out).toContain("Merge: A");
    expect(out).toContain("Merge: B");
  });
});

describe("buildInitialBody merge-note", () => {
  const unit: PRUnit = {
    type: "single",
    id: "aaaaaaaa",
    title: undefined,
    commitIds: ["aaaaaaaa"],
    commits: ["h1"],
    subjects: ["feat: a"],
  };

  test("omits the merge-note region entirely when there is no note", () => {
    const body = buildInitialBody({ unit, commits: [commit("h1", "feat: a", "")], stackLinks: "" });
    expect(body).not.toContain(MARKERS.MERGE_NOTE_BEGIN);
  });

  test("emits the merge-note region (before stack-links) when a note is present", () => {
    const note = generateMergeNote([{ subject: "M", memberSubjects: ["x"] }]);
    const body = buildInitialBody({
      unit,
      commits: [commit("h1", "feat: a", "")],
      stackLinks: "",
      mergeNote: note,
    });
    expect(body).toContain(MARKERS.MERGE_NOTE_BEGIN);
    expect(body).toContain("Merge: M");
    // ordering: merge-note before stack-links
    expect(body.indexOf(MARKERS.MERGE_NOTE_BEGIN)).toBeLessThan(
      body.indexOf(MARKERS.STACK_LINKS_BEGIN),
    );
  });
});

describe("spliceBody merge-note", () => {
  test("replaces an existing merge-note region in place", () => {
    const note = generateMergeNote([{ subject: "M", memberSubjects: ["x"] }]);
    const initial = buildInitialBody({
      unit: {
        type: "single",
        id: "a",
        title: undefined,
        commitIds: ["a"],
        commits: ["h"],
        subjects: ["s"],
      },
      commits: [commit("h", "s", "")],
      stackLinks: "",
      mergeNote: note,
    });
    const note2 = generateMergeNote([{ subject: "M2", memberSubjects: ["y"] }]);
    const out = spliceBody(initial, { bodyContent: "s", stackLinks: "", mergeNote: note2 });
    expect(out).toContain("Merge: M2");
    // the old member subject "x" is gone, replaced by "y" (avoid the "Merge: M"
    // substring-of-"Merge: M2" trap).
    expect(out).toContain("| * y");
    expect(out).not.toContain("| * x");
    // exactly one merge-note region
    expect(out.split(MARKERS.MERGE_NOTE_BEGIN).length - 1).toBe(1);
  });

  test("a body with no merge-note region and no note stays without one", () => {
    const initial = buildInitialBody({
      unit: {
        type: "single",
        id: "a",
        title: undefined,
        commitIds: ["a"],
        commits: ["h"],
        subjects: ["s"],
      },
      commits: [commit("h", "s", "")],
      stackLinks: "",
    });
    const out = spliceBody(initial, { bodyContent: "s", stackLinks: "" });
    expect(out).not.toContain(MARKERS.MERGE_NOTE_BEGIN);
  });
});
