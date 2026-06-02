import { describe, test, expect, afterEach } from "bun:test";
import { loadGroupTitles, saveGroupTitle, fetchGroupTitles } from "../../src/git/group-titles.ts";
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
    await saveGroupTitle(git, "g1", "Auth Feature", { cwd: repo.path });

    const titles = await loadGroupTitles(git, { cwd: repo.path });
    expect(titles["g1"]).toBe("Auth Feature");
  });

  test("returns multiple stored group titles", async () => {
    const repo = await makeRepo();
    await saveGroupTitle(git, "g1", "Auth Feature", { cwd: repo.path });
    await saveGroupTitle(git, "g2", "Login Flow", { cwd: repo.path });

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

describe("fetchGroupTitles", () => {
  test("returns ok when fetch succeeds", async () => {
    const fakeGit = {
      async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const result = await fetchGroupTitles(fakeGit, "origin");
    expect(result.ok).toBe(true);
  });

  test("returns ok when remote has no groups ref", async () => {
    const fakeGit = {
      async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
        return { stdout: "", stderr: "couldn't find remote ref refs/spry/groups", exitCode: 128 };
      },
    };
    const result = await fetchGroupTitles(fakeGit, "origin");
    expect(result.ok).toBe(true);
  });

  test("returns warning on other fetch failure", async () => {
    const fakeGit = {
      async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
        return { stdout: "", stderr: "Connection refused", exitCode: 1 };
      },
    };
    const result = await fetchGroupTitles(fakeGit, "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning).toMatch(/Connection refused/);
  });
});
