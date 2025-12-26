import { test, expect, afterEach, describe } from "bun:test";
import { createGitFixture, type GitFixture } from "../../tests/helpers/git-fixture.ts";
import { parseTrailers, getCommitTrailers } from "./trailers.ts";

let fixture: GitFixture | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.cleanup();
    fixture = null;
  }
});

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
      fixture = await createGitFixture();
      await fixture.checkout("feature-trailers", { create: true });

      const hash = await fixture.commit("Add feature", {
        trailers: {
          "Taspr-Commit-Id": "a1b2c3d4",
          "Taspr-Group-Start": "f7e8d9c0",
        },
      });

      const trailers = await getCommitTrailers(hash, { cwd: fixture.path });
      expect(trailers["Taspr-Commit-Id"]).toBe("a1b2c3d4");
      expect(trailers["Taspr-Group-Start"]).toBe("f7e8d9c0");
    });

    test("returns empty object for commit without trailers", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-no-trailers", { create: true });

      const hash = await fixture.commit("Plain commit");

      const trailers = await getCommitTrailers(hash, { cwd: fixture.path });
      expect(trailers).toEqual({});
    });

    test("handles commit with only non-taspr trailers", async () => {
      fixture = await createGitFixture();
      await fixture.checkout("feature-other-trailers", { create: true });

      const hash = await fixture.commit("Collaborative commit", {
        trailers: {
          "Co-authored-by": "Alice <alice@example.com>",
          "Signed-off-by": "Bob <bob@example.com>",
        },
      });

      const trailers = await getCommitTrailers(hash, { cwd: fixture.path });
      expect(trailers["Co-authored-by"]).toBe("Alice <alice@example.com>");
      expect(trailers["Signed-off-by"]).toBe("Bob <bob@example.com>");
      expect(trailers["Taspr-Commit-Id"]).toBeUndefined();
    });
  });
});
