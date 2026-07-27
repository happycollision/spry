import { test, expect, describe } from "bun:test";
import { parseTrailers, parseTrailersSync, addTrailers } from "../../src/parse/trailers.ts";
import { createRealGitRunner } from "../../tests/lib/index.ts";

const git = createRealGitRunner();

/** Parse trailers via the REAL `git interpret-trailers --parse` (the oracle). */
async function gitParse(message: string): Promise<Record<string, string>> {
  const result = await git.run(["interpret-trailers", "--parse"], { stdin: message });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  const out: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

describe("parseTrailers", () => {
  test("returns empty object for empty body", async () => {
    expect(await parseTrailers("", git)).toEqual({});
  });

  test("returns empty object for whitespace-only body", async () => {
    expect(await parseTrailers("   \n\n   ", git)).toEqual({});
  });

  test("returns empty object for body without trailers", async () => {
    const body = "This is a commit message\n\nWith description but no trailers.";
    expect(await parseTrailers(body, git)).toEqual({});
  });

  test("parses single trailer", async () => {
    const body = "Add feature\n\nSpry-Commit-Id: a1b2c3d4";
    const trailers = await parseTrailers(body, git);
    expect(trailers).toEqual({ "Spry-Commit-Id": "a1b2c3d4" });
  });

  test("parses multiple trailers", async () => {
    const body = "Add feature\n\nSpry-Commit-Id: a1b2c3d4\nSpry-Group: f7e8d9c0";
    const trailers = await parseTrailers(body, git);
    expect(trailers).toEqual({
      "Spry-Commit-Id": "a1b2c3d4",
      "Spry-Group": "f7e8d9c0",
    });
  });

  test("handles trailers with colons in value", async () => {
    const body = "Add config\n\nConfig-Value: key:value:with:colons";
    const trailers = await parseTrailers(body, git);
    expect(trailers["Config-Value"]).toBe("key:value:with:colons");
  });

  test("uses last value when key appears multiple times", async () => {
    const body = "Commit\n\nSpry-Commit-Id: first\nSpry-Commit-Id: second\nSpry-Commit-Id: third";
    const trailers = await parseTrailers(body, git);
    expect(trailers["Spry-Commit-Id"]).toBe("third");
  });
});

describe("parseTrailersSync matches git interpret-trailers --parse", () => {
  // The in-process parser (spry-b5wn.4) replaced a per-commit `git
  // interpret-trailers` subprocess. This differential battery proves it agrees
  // with real git for the trailer shapes spry actually reads/produces. (Folded
  // continuation trailers are intentionally out of scope — spry never emits
  // them; see the parser's doc comment.)
  const cases: Array<[string, string]> = [
    ["empty", ""],
    ["subject only", "Add a thing"],
    ["prose, no trailers", "Add a thing\n\nSome longer description here.\nSecond line."],
    ["one trailer", "Add feature\n\nSpry-Commit-Id: a1b2c3d4"],
    [
      "trailer with co-author",
      "Fix bug\n\nSome body.\n\nSpry-Commit-Id: deadbeef\nCo-Authored-By: A B <a@b.co>",
    ],
    ["colon in value", "Add config\n\nConfig-Value: key:value:colons"],
    ["dup keys last-wins", "Commit\n\nX-Id: first\nX-Id: second\nX-Id: third"],
    ["trailing blank lines", "Add feature\n\nSpry-Commit-Id: abc123\n\n\n"],
    ["url value", "Doc\n\nSee: https://example.com/x?y=1"],
    // Trailer-looking line glued to prose (no blank line before) → NOT trailers.
    ["glued to prose", "Subject\n\nprose line\nSpry-Commit-Id: abc123"],
    // A block that is a mix of prose and a trailer is not a clean trailer block.
    ["mixed block", "Subject\n\nfoo bar baz\nSpry-Commit-Id: abc123\nmore prose"],
  ];

  for (const [name, message] of cases) {
    test(name, async () => {
      const oracle = await gitParse(message);
      expect(parseTrailersSync(message)).toEqual(oracle);
    });
  }
});

describe("addTrailers", () => {
  test("adds single trailer to message", async () => {
    const result = await addTrailers(
      "Add feature\n\nSome description.",
      { "Spry-Commit-Id": "a1b2c3d4" },
      git,
    );
    expect(result).toContain("Spry-Commit-Id: a1b2c3d4");
    expect(result).toContain("Add feature");
  });

  test("adds multiple trailers", async () => {
    const result = await addTrailers(
      "Add feature",
      { "Spry-Commit-Id": "a1b2c3d4", "Spry-Group": "f7e8d9c0" },
      git,
    );
    expect(result).toContain("Spry-Commit-Id: a1b2c3d4");
    expect(result).toContain("Spry-Group: f7e8d9c0");
  });

  test("returns original message when no trailers provided", async () => {
    const message = "Add feature\n\nSome description.";
    expect(await addTrailers(message, {}, git)).toBe(message);
  });

  test("roundtrip: added trailers can be parsed back", async () => {
    const withTrailers = await addTrailers(
      "Add feature",
      { "Spry-Commit-Id": "a1b2c3d4", "Spry-Group": "f7e8d9c0" },
      git,
    );
    const parsed = await parseTrailers(withTrailers, git);
    expect(parsed["Spry-Commit-Id"]).toBe("a1b2c3d4");
    expect(parsed["Spry-Group"]).toBe("f7e8d9c0");
  });
});
