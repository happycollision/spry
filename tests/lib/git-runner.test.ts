import { test, expect } from "bun:test";
import { createRealGitRunner } from "./git-runner.ts";

test("runs git --version and returns result", async () => {
  const git = createRealGitRunner();
  const result = await git.run(["--version"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("git version");
  expect(result.stderr).toBe("");
});

test("returns non-zero exit code for invalid commands", async () => {
  const git = createRealGitRunner();
  const result = await git.run(["not-a-real-command"]);

  expect(result.exitCode).not.toBe(0);
});

test("respects cwd option", async () => {
  const git = createRealGitRunner();
  const result = await git.run(["rev-parse", "--show-toplevel"], { cwd: "/tmp" });

  // /tmp is not a git repo, so this should fail
  expect(result.exitCode).not.toBe(0);
});
