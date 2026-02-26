import { test, expect } from "bun:test";
import { createRealGhClient } from "./gh-client.ts";

test("runs gh --version and returns result", async () => {
  const gh = createRealGhClient();
  const result = await gh.run(["--version"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("gh version");
  expect(result.stderr).toBe("");
});

test("returns non-zero exit code for invalid commands", async () => {
  const gh = createRealGhClient();
  const result = await gh.run(["not-a-real-command"]);

  expect(result.exitCode).not.toBe(0);
});
