import { test, expect } from "bun:test";
import { replaceCommitId } from "../../src/parse/trailers.ts";
import { createRealGitRunner } from "../../src/lib/context.ts";

test("replaceCommitId replaces an existing Spry-Commit-Id (no duplicate)", async () => {
  const git = createRealGitRunner();
  const msg = "feat: x\n\nSpry-Commit-Id: aaaaaaaa\n";
  const out = await replaceCommitId(msg, "bbbbbbbbb", git);
  const matches = out.match(/Spry-Commit-Id:/g) ?? [];
  expect(matches).toHaveLength(1);
  expect(out).toContain("Spry-Commit-Id: bbbbbbbb");
  expect(out).not.toContain("aaaaaaaa");
});

test("replaceCommitId adds when missing", async () => {
  const git = createRealGitRunner();
  const out = await replaceCommitId("feat: y\n", "cccccccc", git);
  expect(out).toContain("Spry-Commit-Id: cccccccc");
});
