import { describe, test, expect } from "bun:test";
import { parseCommitTrailers } from "../../src/parse/trailers.ts";
import { createRealGitRunner } from "../../tests/lib/index.ts";
import type { CommitInfo } from "../../src/parse/types.ts";

const git = createRealGitRunner();

describe("parseCommitTrailers", () => {
  test("parses trailers from multiple commits", async () => {
    const commits: CommitInfo[] = [
      {
        hash: "abc123",
        subject: "First commit",
        body: "First commit\n\nSpry-Commit-Id: aaa11111\n",
        trailers: {},
      },
      {
        hash: "def456",
        subject: "Second commit",
        body: "Second commit\n\nSpry-Commit-Id: bbb22222\nSpry-Group: grp1\n",
        trailers: {},
      },
      {
        hash: "ghi789",
        subject: "Third commit",
        body: "Third commit\n",
        trailers: {},
      },
    ];

    const result = await parseCommitTrailers(commits, git);
    expect(result).toHaveLength(3);
    expect(result[0]!.trailers["Spry-Commit-Id"]).toBe("aaa11111");
    expect(result[1]!.trailers["Spry-Commit-Id"]).toBe("bbb22222");
    expect(result[1]!.trailers["Spry-Group"]).toBe("grp1");
    expect(result[2]!.trailers["Spry-Commit-Id"]).toBeUndefined();
  });

  test("returns empty trailers for commits with empty bodies", async () => {
    const commits: CommitInfo[] = [{ hash: "abc123", subject: "Commit", body: "", trailers: {} }];

    const result = await parseCommitTrailers(commits, git);
    expect(result).toHaveLength(1);
    expect(result[0]!.trailers).toEqual({});
  });

  test("preserves hash, subject, and body in output", async () => {
    // body is the post-`%b` shape: trailer-only, no subject prefix
    const commits: CommitInfo[] = [
      {
        hash: "abc123",
        subject: "My subject",
        body: "Spry-Commit-Id: id1\n",
        trailers: {},
      },
    ];

    const result = await parseCommitTrailers(commits, git);
    expect(result[0]!.hash).toBe("abc123");
    expect(result[0]!.subject).toBe("My subject");
    expect(result[0]!.body).toBe("Spry-Commit-Id: id1\n");
  });

  test("returns empty array for empty input", async () => {
    const result = await parseCommitTrailers([], git);
    expect(result).toHaveLength(0);
  });
});
