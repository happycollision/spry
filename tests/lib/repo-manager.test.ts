import { test, expect } from "bun:test";
import { stat } from "node:fs/promises";
import { repoManager } from "./repo-manager.ts";

const repos = repoManager();

test("creates repos that are automatically tracked", async () => {
  const repo = await repos.create();
  const s = await stat(repo.path);
  expect(s.isDirectory()).toBe(true);
});

test("supports creating multiple repos in one test", async () => {
  const repo1 = await repos.create();
  const repo2 = await repos.create();
  expect(repo1.path).not.toBe(repo2.path);
  expect(repo1.uniqueId).not.toBe(repo2.uniqueId);
});
