import { test, expect, describe } from "bun:test";
import { parseTrailers, addTrailers } from "../../src/parse/trailers.ts";
import { createRealGitRunner } from "../../tests/lib/index.ts";

const git = createRealGitRunner();

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

describe("addTrailers", () => {
  test("adds single trailer to message", async () => {
    const result = await addTrailers("Add feature\n\nSome description.", { "Spry-Commit-Id": "a1b2c3d4" }, git);
    expect(result).toContain("Spry-Commit-Id: a1b2c3d4");
    expect(result).toContain("Add feature");
  });

  test("adds multiple trailers", async () => {
    const result = await addTrailers("Add feature", { "Spry-Commit-Id": "a1b2c3d4", "Spry-Group": "f7e8d9c0" }, git);
    expect(result).toContain("Spry-Commit-Id: a1b2c3d4");
    expect(result).toContain("Spry-Group: f7e8d9c0");
  });

  test("returns original message when no trailers provided", async () => {
    const message = "Add feature\n\nSome description.";
    expect(await addTrailers(message, {}, git)).toBe(message);
  });

  test("roundtrip: added trailers can be parsed back", async () => {
    const withTrailers = await addTrailers("Add feature", { "Spry-Commit-Id": "a1b2c3d4", "Spry-Group": "f7e8d9c0" }, git);
    const parsed = await parseTrailers(withTrailers, git);
    expect(parsed["Spry-Commit-Id"]).toBe("a1b2c3d4");
    expect(parsed["Spry-Group"]).toBe("f7e8d9c0");
  });
});
