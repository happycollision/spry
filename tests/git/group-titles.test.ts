import { describe, test, expect, afterEach } from "bun:test";
import { loadGroupTitles, saveGroupTitle } from "../../src/git/group-titles.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];
const git = createRealGitRunner();

afterEach(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  return repo;
}

describe("loadGroupTitles", () => {
  test("returns empty object when no group titles stored", async () => {
    const repo = await makeRepo();
    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles).toEqual({});
  });

  test("returns stored group title by group id", async () => {
    const repo = await makeRepo();
    const { $ } = await import("bun");
    await $`git config spry-group.g1.title "Auth Feature"`.cwd(repo.path).quiet();

    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles["g1"]).toBe("Auth Feature");
  });

  test("returns multiple stored group titles", async () => {
    const repo = await makeRepo();
    const { $ } = await import("bun");
    await $`git config spry-group.g1.title "Auth Feature"`.cwd(repo.path).quiet();
    await $`git config spry-group.g2.title "Login Flow"`.cwd(repo.path).quiet();

    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles["g1"]).toBe("Auth Feature");
    expect(titles["g2"]).toBe("Login Flow");
  });
});

describe("saveGroupTitle", () => {
  test("stores a group title retrievable by loadGroupTitles", async () => {
    const repo = await makeRepo();
    await saveGroupTitle(git, "g1", "Auth Feature", { cwd: repo.path });

    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles["g1"]).toBe("Auth Feature");
  });

  test("overwrites an existing title for the same group id", async () => {
    const repo = await makeRepo();
    await saveGroupTitle(git, "g1", "Old Title", { cwd: repo.path });
    await saveGroupTitle(git, "g1", "New Title", { cwd: repo.path });

    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles["g1"]).toBe("New Title");
  });
});
