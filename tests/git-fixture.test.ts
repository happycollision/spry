import { test, expect, afterEach } from "bun:test";
import { repoManager } from "./helpers/local-repo.ts";
import { $ } from "bun";

const repos = repoManager();

test("creates a git repository with initial commit", async () => {
  const repo = await repos.create();

  const result = await $`git -C ${repo.path} log --oneline`.text();
  expect(result).toContain("Initial commit");
});

test("can create commits", async () => {
  const repo = await repos.create();

  await repo.commit();

  const result = await $`git -C ${repo.path} log -1 --format=%B`.text();
  expect(result).toContain(repo.uniqueId);
});

test("can create commits with specific files", async () => {
  const repo = await repos.create();

  await repo.commitFiles({ "config.json": '{"key": "value"}\n' });

  const content = await $`cat ${repo.path}/config.json`.text();
  expect(content).toContain('"key": "value"');
});

test("updateOriginMain creates a commit on origin/main", async () => {
  const repo = await repos.create();

  // Create feature branch
  await repo.branch("feature");
  await repo.commit();

  // Update origin/main
  await repo.updateOriginMain("Main update", { "main-file.txt": "content\n" });

  // Fetch and verify
  await repo.fetch();
  const log = await $`git -C ${repo.path} log origin/main --oneline -2`.text();
  expect(log).toContain("Main update");
});
