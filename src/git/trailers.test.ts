import { test, expect, describe } from "bun:test";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import { parseTrailers, getCommitTrailers, addTrailers } from "./trailers.ts";

const repos = repoManager();

describe("git/trailers", () => {
  describe("parseTrailers", () => {
    test("returns empty object for empty body", async () => {
      const trailers = await parseTrailers("");
      expect(trailers).toEqual({});
    });

    test("returns empty object for whitespace-only body", async () => {
      const trailers = await parseTrailers("   \n\n   ");
      expect(trailers).toEqual({});
    });

    test("returns empty object for body without trailers", async () => {
      const body = `This is a commit message

With some description but no trailers at all.`;
      const trailers = await parseTrailers(body);
      expect(trailers).toEqual({});
    });

    test("parses single trailer", async () => {
      const body = `Add feature

Taspr-Commit-Id: a1b2c3d4`;
      const trailers = await parseTrailers(body);
      expect(trailers).toEqual({
        "Taspr-Commit-Id": "a1b2c3d4",
      });
    });

    test("parses multiple trailers", async () => {
      const body = `Add feature

Taspr-Commit-Id: a1b2c3d4
Taspr-Group-Start: f7e8d9c0
Taspr-Group-Title: Authentication feature`;
      const trailers = await parseTrailers(body);
      expect(trailers).toEqual({
        "Taspr-Commit-Id": "a1b2c3d4",
        "Taspr-Group-Start": "f7e8d9c0",
        "Taspr-Group-Title": "Authentication feature",
      });
    });

    test("parses mixed taspr and other trailers", async () => {
      const body = `Fix bug

Fixes a critical issue with login.

Taspr-Commit-Id: a1b2c3d4
Co-authored-by: Alice <alice@example.com>
Reviewed-by: Bob <bob@example.com>`;
      const trailers = await parseTrailers(body);
      expect(trailers).toEqual({
        "Taspr-Commit-Id": "a1b2c3d4",
        "Co-authored-by": "Alice <alice@example.com>",
        "Reviewed-by": "Bob <bob@example.com>",
      });
    });

    test("handles trailers with colons in value", async () => {
      const body = `Add config

Config-Value: key:value:with:colons`;
      const trailers = await parseTrailers(body);
      expect(trailers["Config-Value"]).toBe("key:value:with:colons");
    });

    test("handles trailers with special characters in value", async () => {
      const body = `Update

Taspr-Group-Title: Fix "quoted" strings & <special> chars`;
      const trailers = await parseTrailers(body);
      expect(trailers["Taspr-Group-Title"]).toBe('Fix "quoted" strings & <special> chars');
    });

    test("uses last value when key appears multiple times", async () => {
      const body = `Commit

Taspr-Commit-Id: first
Taspr-Commit-Id: second
Taspr-Commit-Id: third`;
      const trailers = await parseTrailers(body);
      expect(trailers["Taspr-Commit-Id"]).toBe("third");
    });

    test("parses all taspr trailer types", async () => {
      const body = `Group commit

Taspr-Commit-Id: a1b2c3d4
Taspr-Group-Start: f7e8d9c0
Taspr-Group-Title: My Feature PR
Taspr-Group-End: f7e8d9c0`;
      const trailers = await parseTrailers(body);
      expect(trailers).toEqual({
        "Taspr-Commit-Id": "a1b2c3d4",
        "Taspr-Group-Start": "f7e8d9c0",
        "Taspr-Group-Title": "My Feature PR",
        "Taspr-Group-End": "f7e8d9c0",
      });
    });
  });

  describe("getCommitTrailers", () => {
    test("returns trailers from a commit", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const hash = await repo.commit({
        trailers: {
          "Taspr-Commit-Id": "a1b2c3d4",
          "Taspr-Group-Start": "f7e8d9c0",
        },
      });

      const trailers = await getCommitTrailers(hash, { cwd: repo.path });
      expect(trailers["Taspr-Commit-Id"]).toBe("a1b2c3d4");
      expect(trailers["Taspr-Group-Start"]).toBe("f7e8d9c0");
    });

    test("returns empty object for commit without trailers", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const hash = await repo.commit();

      const trailers = await getCommitTrailers(hash, { cwd: repo.path });
      expect(trailers).toEqual({});
    });

    test("handles commit with only non-taspr trailers", async () => {
      const repo = await repos.create();
      await repo.branch("feature");

      const hash = await repo.commit({
        trailers: {
          "Co-authored-by": "Alice <alice@example.com>",
          "Signed-off-by": "Bob <bob@example.com>",
        },
      });

      const trailers = await getCommitTrailers(hash, { cwd: repo.path });
      expect(trailers["Co-authored-by"]).toBe("Alice <alice@example.com>");
      expect(trailers["Signed-off-by"]).toBe("Bob <bob@example.com>");
      expect(trailers["Taspr-Commit-Id"]).toBeUndefined();
    });
  });

  describe("addTrailers", () => {
    test("adds single trailer to message without trailers", async () => {
      const message = "Add feature\n\nSome description.";
      const result = await addTrailers(message, { "Taspr-Commit-Id": "a1b2c3d4" });

      expect(result).toContain("Taspr-Commit-Id: a1b2c3d4");
      expect(result).toContain("Add feature");
      expect(result).toContain("Some description.");
    });

    test("adds multiple trailers", async () => {
      const message = "Add feature";
      const result = await addTrailers(message, {
        "Taspr-Commit-Id": "a1b2c3d4",
        "Taspr-Group-Start": "f7e8d9c0",
      });

      expect(result).toContain("Taspr-Commit-Id: a1b2c3d4");
      expect(result).toContain("Taspr-Group-Start: f7e8d9c0");
    });

    test("preserves existing trailers", async () => {
      const message = "Add feature\n\nCo-authored-by: Alice <alice@example.com>";
      const result = await addTrailers(message, { "Taspr-Commit-Id": "a1b2c3d4" });

      expect(result).toContain("Co-authored-by: Alice <alice@example.com>");
      expect(result).toContain("Taspr-Commit-Id: a1b2c3d4");
    });

    test("returns original message when no trailers provided", async () => {
      const message = "Add feature\n\nSome description.";
      const result = await addTrailers(message, {});

      expect(result).toBe(message);
    });

    test("works with message that has no body", async () => {
      const message = "Add feature";
      const result = await addTrailers(message, { "Taspr-Commit-Id": "a1b2c3d4" });

      expect(result).toContain("Add feature");
      expect(result).toContain("Taspr-Commit-Id: a1b2c3d4");
    });

    test("roundtrip: added trailers can be parsed back", async () => {
      const message = "Add feature";
      const withTrailers = await addTrailers(message, {
        "Taspr-Commit-Id": "a1b2c3d4",
        "Taspr-Group-Start": "f7e8d9c0",
      });

      const parsed = await parseTrailers(withTrailers);
      expect(parsed["Taspr-Commit-Id"]).toBe("a1b2c3d4");
      expect(parsed["Taspr-Group-Start"]).toBe("f7e8d9c0");
    });
  });
});
