import { describe, test, expect } from "bun:test";
import {
  MARKERS,
  BETA_WARNING,
  generateBodyContent,
  generateFooter,
  generateStackLinks,
  buildInitialBody,
  spliceBody,
} from "../../src/gh/pr-body.ts";
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

describe("MARKERS", () => {
  test("info marker matches the spec string exactly", () => {
    expect(MARKERS.INFO).toBe(
      "<!-- spry:info - Your edits outside of spry markers will be preserved on sync. -->",
    );
  });
});

describe("generateBodyContent", () => {
  test("single: strips trailers, keeps prose", () => {
    const unit = singleUnit("aaa11111", "abc", "Add login page");
    const commits = [
      commit("abc", "Add login page", "Implements OAuth.\n\nSpry-Commit-Id: aaa11111"),
    ];
    expect(generateBodyContent(unit, commits)).toBe("Implements OAuth.");
  });

  test("single: empty when body is only trailers", () => {
    const unit = singleUnit("aaa11111", "abc", "Subject");
    const commits = [commit("abc", "Subject", "Spry-Commit-Id: aaa11111")];
    expect(generateBodyContent(unit, commits)).toBe("");
  });

  test("group: bulleted list of subjects", () => {
    const groupUnit: PRUnit = {
      type: "group",
      id: "grp1",
      title: "G",
      commitIds: ["a", "b"],
      commits: ["aaa", "bbb"],
      subjects: ["Add A", "Add B"],
    };
    expect(generateBodyContent(groupUnit, [])).toBe("- Add A\n- Add B");
  });

  test("single: empty when the commit hash is not found", () => {
    const unit = singleUnit("aaa11111", "missing", "Subject");
    expect(generateBodyContent(unit, [])).toBe("");
  });

  test("group: empty string when there are no subjects", () => {
    const groupUnit: PRUnit = {
      type: "group",
      id: "grp1",
      title: "G",
      commitIds: [],
      commits: [],
      subjects: [],
    };
    expect(generateBodyContent(groupUnit, [])).toBe("");
  });
});

describe("generateFooter", () => {
  test("returns the beta warning", () => {
    expect(generateFooter()).toBe(BETA_WARNING);
    expect(BETA_WARNING).toContain("Do not manually merge stacked PRs.");
  });
});

describe("generateStackLinks", () => {
  // stackUnitIds are oldest -> newest (same order sp uses internally).
  // prNumbers maps unitId -> PR number for units that HAVE an open PR.
  test("newest-first with descending manual numbers and this-PR marker", () => {
    const stackUnitIds = ["u1", "u2", "u3"]; // oldest -> newest
    const prNumbers = new Map([
      ["u1", 1428],
      ["u2", 1433],
      ["u3", 1440],
    ]);
    const out = generateStackLinks(stackUnitIds, prNumbers, "u2", "main");
    expect(out).toBe(
      "**Stack** (newest → oldest, targeting `main`):\n" +
        "3\\. #1440\n" +
        "2\\. #1433 ← this PR\n" +
        "1\\. #1428",
    );
  });

  test("only units with an open PR are listed; numbering counts listed PRs", () => {
    const stackUnitIds = ["u1", "u2", "u3"];
    const prNumbers = new Map([
      ["u1", 1428],
      ["u3", 1440],
    ]); // u2 has no PR
    const out = generateStackLinks(stackUnitIds, prNumbers, "u3", "main");
    expect(out).toBe(
      "**Stack** (newest → oldest, targeting `main`):\n" + "2\\. #1440 ← this PR\n" + "1\\. #1428",
    );
  });

  test("empty when no unit has a PR", () => {
    expect(generateStackLinks(["u1"], new Map(), "u1", "main")).toBe("");
  });

  test("single-PR stack renders one escaped line with the marker", () => {
    const out = generateStackLinks(["u1"], new Map([["u1", 1500]]), "u1", "main");
    expect(out).toBe("**Stack** (newest → oldest, targeting `main`):\n1\\. #1500 ← this PR");
  });

  test("no this-PR marker when currentUnitId has no PR yet", () => {
    const out = generateStackLinks(["u1", "u2"], new Map([["u1", 1500]]), "u2", "main");
    expect(out).toBe("**Stack** (newest → oldest, targeting `main`):\n1\\. #1500");
  });
});

describe("buildInitialBody", () => {
  const unit = singleUnit("u1", "abc", "Add login page");
  const commits = [commit("abc", "Add login page", "Implements OAuth.\n\nSpry-Commit-Id: u1")];

  test("assembles info, body, stack-links, footer in canonical order", () => {
    const body = buildInitialBody({
      unit,
      commits,
      stackLinks: "**Stack** (newest → oldest, targeting `main`):\n1\\. #1001 ← this PR",
    });
    expect(body).toBe(
      [
        MARKERS.INFO,
        "",
        MARKERS.BODY_BEGIN,
        "Implements OAuth.",
        MARKERS.BODY_END,
        "",
        MARKERS.STACK_LINKS_BEGIN,
        "**Stack** (newest → oldest, targeting `main`):\n1\\. #1001 ← this PR",
        MARKERS.STACK_LINKS_END,
        "",
        MARKERS.FOOTER_BEGIN,
        BETA_WARNING,
        MARKERS.FOOTER_END,
      ].join("\n"),
    );
  });

  test("seeds the PR template in the user region under the body when provided", () => {
    const body = buildInitialBody({
      unit,
      commits,
      stackLinks: "",
      prTemplate: "## Testing\n\n- [ ]",
    });
    expect(body).toContain(`${MARKERS.BODY_END}\n\n## Testing\n\n- [ ]\n`);
    expect(body).not.toContain(MARKERS.STACK_LINKS_BEGIN);
    expect(body).toContain(MARKERS.FOOTER_BEGIN);
  });

  test("omits stack-links markers entirely when stackLinks is empty", () => {
    const body = buildInitialBody({ unit, commits, stackLinks: "" });
    expect(body).not.toContain(MARKERS.STACK_LINKS_BEGIN);
  });

  test("orders body, then template (user region), then stack-links", () => {
    const links = "**Stack** (newest → oldest, targeting `main`):\n1\\. #1001 ← this PR";
    const body = buildInitialBody({
      unit,
      commits,
      stackLinks: links,
      prTemplate: "## Testing\n\n- [ ]",
    });
    const iBody = body.indexOf(MARKERS.BODY_END);
    const iTemplate = body.indexOf("## Testing");
    const iLinks = body.indexOf(MARKERS.STACK_LINKS_BEGIN);
    expect(iBody).toBeGreaterThan(-1);
    expect(iTemplate).toBeGreaterThan(iBody);
    expect(iLinks).toBeGreaterThan(iTemplate);
  });

  test("empty body content leaves body markers adjacent with no inner content line", () => {
    const emptyUnit = singleUnit("u9", "zzz", "Subject only");
    const emptyCommits = [commit("zzz", "Subject only", "Spry-Commit-Id: u9")];
    const body = buildInitialBody({ unit: emptyUnit, commits: emptyCommits, stackLinks: "" });
    expect(body).toContain(`${MARKERS.BODY_BEGIN}\n${MARKERS.BODY_END}`);
  });
});

describe("spliceBody", () => {
  const links = "**Stack** (newest → oldest, targeting `main`):\n1\\. #1001 ← this PR";

  test("replaces content inside each marker pair, preserves everything else verbatim", () => {
    const existing = [
      "User preamble kept.",
      "",
      MARKERS.INFO,
      "",
      MARKERS.BODY_BEGIN,
      "OLD body",
      MARKERS.BODY_END,
      "",
      "User middle text kept exactly.",
      "",
      MARKERS.STACK_LINKS_BEGIN,
      "OLD links",
      MARKERS.STACK_LINKS_END,
      "",
      MARKERS.FOOTER_BEGIN,
      "OLD footer",
      MARKERS.FOOTER_END,
      "",
      "User trailing text kept.",
    ].join("\n");

    const out = spliceBody(existing, { bodyContent: "NEW body", stackLinks: links });

    expect(out).toContain("User preamble kept.");
    expect(out).toContain("User middle text kept exactly.");
    expect(out).toContain("User trailing text kept.");
    expect(out).toContain(`${MARKERS.BODY_BEGIN}\nNEW body\n${MARKERS.BODY_END}`);
    expect(out).toContain(`${MARKERS.STACK_LINKS_BEGIN}\n${links}\n${MARKERS.STACK_LINKS_END}`);
    expect(out).toContain(`${MARKERS.FOOTER_BEGIN}\n${BETA_WARNING}\n${MARKERS.FOOTER_END}`);
    expect(out).not.toContain("OLD body");
    expect(out).not.toContain("OLD links");
    expect(out).not.toContain("OLD footer");
  });

  test("is idempotent: splicing the same content twice yields identical output", () => {
    const existing = [
      MARKERS.INFO,
      "",
      MARKERS.BODY_BEGIN,
      "NEW body",
      MARKERS.BODY_END,
      "",
      MARKERS.STACK_LINKS_BEGIN,
      links,
      MARKERS.STACK_LINKS_END,
      "",
      MARKERS.FOOTER_BEGIN,
      BETA_WARNING,
      MARKERS.FOOTER_END,
    ].join("\n");
    const once = spliceBody(existing, { bodyContent: "NEW body", stackLinks: links });
    const twice = spliceBody(once, { bodyContent: "NEW body", stackLinks: links });
    expect(twice).toBe(once);
    expect(once).toBe(existing);
  });

  test("appends missing sections in canonical order without clobbering user text", () => {
    const existing = "Just my hand-written PR description.\n\n## Testing\n- [x] done";
    const out = spliceBody(existing, { bodyContent: "NEW body", stackLinks: links });

    expect(out.startsWith("Just my hand-written PR description.\n\n## Testing\n- [x] done")).toBe(
      true,
    );
    const iInfo = out.indexOf(MARKERS.INFO);
    const iBody = out.indexOf(MARKERS.BODY_BEGIN);
    const iLinks = out.indexOf(MARKERS.STACK_LINKS_BEGIN);
    const iFooter = out.indexOf(MARKERS.FOOTER_BEGIN);
    expect(iInfo).toBeGreaterThan(-1);
    expect(iInfo).toBeLessThan(iBody);
    expect(iBody).toBeLessThan(iLinks);
    expect(iLinks).toBeLessThan(iFooter);
    expect(out).toContain(`${MARKERS.BODY_BEGIN}\nNEW body\n${MARKERS.BODY_END}`);
  });

  test("appends only the missing section when some markers are present", () => {
    const existing = [MARKERS.INFO, "", MARKERS.BODY_BEGIN, "OLD", MARKERS.BODY_END].join("\n");
    const out = spliceBody(existing, { bodyContent: "NEW body", stackLinks: links });
    expect(out).toContain(`${MARKERS.BODY_BEGIN}\nNEW body\n${MARKERS.BODY_END}`);
    expect(out).toContain(MARKERS.STACK_LINKS_BEGIN); // appended
    expect(out).toContain(MARKERS.FOOTER_BEGIN); // appended
    expect(out.split(MARKERS.INFO).length - 1).toBe(1); // info not duplicated
  });

  test("empty stackLinks removes an existing stack-links region's content but keeps markers", () => {
    const existing = [MARKERS.STACK_LINKS_BEGIN, "OLD links", MARKERS.STACK_LINKS_END].join("\n");
    const out = spliceBody(existing, { bodyContent: "b", stackLinks: "" });
    expect(out).toContain(`${MARKERS.STACK_LINKS_BEGIN}\n${MARKERS.STACK_LINKS_END}`);
    expect(out).not.toContain("OLD links");
  });

  test("heals an orphaned marker: user text survives a second splice", () => {
    // User deleted BODY_END, leaving an orphan BODY_BEGIN and their own note.
    const existing = [
      MARKERS.INFO,
      "",
      MARKERS.BODY_BEGIN,
      "stale",
      "",
      "USER NOTE below the orphan begin",
    ].join("\n");
    const once = spliceBody(existing, { bodyContent: "NEW body", stackLinks: "" });
    const twice = spliceBody(once, { bodyContent: "NEW body", stackLinks: "" });
    // The user's note must survive BOTH splices.
    expect(twice).toContain("USER NOTE below the orphan begin");
    // Exactly one well-formed body region, no orphan left to re-pair.
    expect(twice.split(MARKERS.BODY_BEGIN).length - 1).toBe(1);
    expect(twice.split(MARKERS.BODY_END).length - 1).toBe(1);
  });

  test("does not append an empty stack-links region when there are no links", () => {
    const existing = [
      MARKERS.INFO,
      "",
      MARKERS.BODY_BEGIN,
      "b",
      MARKERS.BODY_END,
      "",
      MARKERS.FOOTER_BEGIN,
      BETA_WARNING,
      MARKERS.FOOTER_END,
    ].join("\n");
    const out = spliceBody(existing, { bodyContent: "b", stackLinks: "" });
    expect(out).not.toContain(MARKERS.STACK_LINKS_BEGIN);
  });
});
