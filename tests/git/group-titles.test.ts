import { describe, test, expect, afterEach } from "bun:test";
import {
  loadGroupRecords,
  saveGroupRecord,
  fetchGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
} from "../../src/git/group-titles.ts";
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

describe("loadGroupRecords", () => {
  test("returns empty object when no group records stored", async () => {
    const repo = await makeRepo();
    const records = await loadGroupRecords(git, { cwd: repo.path });
    expect(records).toEqual({});
  });

  test("returns stored group record by group id", async () => {
    const repo = await makeRepo();
    await saveGroupRecord(
      git,
      "g1",
      { title: "Auth Feature", members: ["aaa11111"] },
      { cwd: repo.path },
    );

    const records = await loadGroupRecords(git, { cwd: repo.path });
    expect(records["g1"]).toEqual({ title: "Auth Feature", members: ["aaa11111"] });
  });

  test("returns multiple stored group records", async () => {
    const repo = await makeRepo();
    await saveGroupRecord(
      git,
      "g1",
      { title: "Auth Feature", members: ["aaa11111"] },
      { cwd: repo.path },
    );
    await saveGroupRecord(
      git,
      "g2",
      { title: "Login Flow", members: ["bbb22222", "ccc33333"] },
      { cwd: repo.path },
    );

    const records = await loadGroupRecords(git, { cwd: repo.path });
    expect(records["g1"]).toEqual({ title: "Auth Feature", members: ["aaa11111"] });
    expect(records["g2"]).toEqual({ title: "Login Flow", members: ["bbb22222", "ccc33333"] });
  });
});

describe("saveGroupRecord", () => {
  test("stores a record retrievable by loadGroupRecords", async () => {
    const repo = await makeRepo();
    await saveGroupRecord(
      git,
      "g1",
      { title: "Auth Feature", members: ["aaa11111"] },
      { cwd: repo.path },
    );

    const records = await loadGroupRecords(git, { cwd: repo.path });
    expect(records["g1"]?.title).toBe("Auth Feature");
    expect(records["g1"]?.members).toEqual(["aaa11111"]);
  });

  test("overwrites an existing record for the same group id", async () => {
    const repo = await makeRepo();
    await saveGroupRecord(
      git,
      "g1",
      { title: "Old Title", members: ["aaa11111"] },
      { cwd: repo.path },
    );
    await saveGroupRecord(
      git,
      "g1",
      { title: "New Title", members: ["aaa11111", "bbb22222"] },
      { cwd: repo.path },
    );

    const records = await loadGroupRecords(git, { cwd: repo.path });
    expect(records["g1"]?.title).toBe("New Title");
    expect(records["g1"]?.members).toEqual(["aaa11111", "bbb22222"]);
  });
});

describe("buildCommitGroupMap", () => {
  test("returns empty map for empty records", () => {
    expect(buildCommitGroupMap({})).toEqual({});
  });

  test("maps each member commit ID to its group ID", () => {
    const map = buildCommitGroupMap({
      g1: { title: "Auth", members: ["aaa11111", "bbb22222"] },
      g2: { title: "Login", members: ["ccc33333"] },
    });
    expect(map).toEqual({
      aaa11111: "g1",
      bbb22222: "g1",
      ccc33333: "g2",
    });
  });
});

describe("extractGroupTitles", () => {
  test("extracts title keyed by group ID", () => {
    const titles = extractGroupTitles({
      g1: { title: "Auth Feature", members: ["aaa11111"] },
      g2: { title: "Login Flow", members: [] },
    });
    expect(titles).toEqual({ g1: "Auth Feature", g2: "Login Flow" });
  });
});

describe("fetchGroupRecords", () => {
  test("returns ok when fetch succeeds", async () => {
    const fakeGit = {
      async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const result = await fetchGroupRecords(fakeGit, "origin");
    expect(result.ok).toBe(true);
  });

  test("returns ok when remote has no groups ref", async () => {
    const fakeGit = {
      async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
        return { stdout: "", stderr: "couldn't find remote ref refs/spry/groups", exitCode: 128 };
      },
    };
    const result = await fetchGroupRecords(fakeGit, "origin");
    expect(result.ok).toBe(true);
  });

  test("returns warning on other fetch failure", async () => {
    const fakeGit = {
      async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
        return { stdout: "", stderr: "Connection refused", exitCode: 1 };
      },
    };
    const result = await fetchGroupRecords(fakeGit, "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning).toMatch(/Connection refused/);
  });
});
