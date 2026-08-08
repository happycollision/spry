import { describe, test, expect, afterAll } from "bun:test";
import {
  loadMergeGroupRecords,
  saveMergeGroupRecord,
  saveAllMergeGroupRecords,
  fetchMergeGroupRecords,
  pushMergeGroupRecords,
} from "../../src/git/merge-groups.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];
const git = createRealGitRunner();

// afterAll, not afterEach: under --concurrent a per-test cleanup hook would delete
// repos out from under still-running sibling tests.
afterAll(async () => {
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

describe("loadMergeGroupRecords", () => {
  test("returns empty object when no merge-group records stored", async () => {
    const repo = await makeRepo();
    const records = await loadMergeGroupRecords(git, { cwd: repo.path });
    expect(records).toEqual({});
  });

  test("returns a stored merge-group record by id, preserving member order", async () => {
    const repo = await makeRepo();
    await saveMergeGroupRecord(
      git,
      "m1",
      { members: ["ccc33333", "aaa11111", "bbb22222"] },
      { cwd: repo.path },
    );

    const records = await loadMergeGroupRecords(git, { cwd: repo.path });
    // Member order is significant (stack order) and must round-trip verbatim.
    expect(records["m1"]).toEqual({ members: ["ccc33333", "aaa11111", "bbb22222"] });
  });

  test("returns multiple stored merge-group records", async () => {
    const repo = await makeRepo();
    await saveMergeGroupRecord(git, "m1", { members: ["aaa11111"] }, { cwd: repo.path });
    await saveMergeGroupRecord(
      git,
      "m2",
      { members: ["bbb22222", "ccc33333"] },
      { cwd: repo.path },
    );

    const records = await loadMergeGroupRecords(git, { cwd: repo.path });
    expect(records["m1"]).toEqual({ members: ["aaa11111"] });
    expect(records["m2"]).toEqual({ members: ["bbb22222", "ccc33333"] });
  });

  test("skips a malformed/legacy blob instead of throwing", async () => {
    const repo = await makeRepo();
    // A valid record...
    await saveMergeGroupRecord(git, "m1", { members: ["aaa11111"] }, { cwd: repo.path });
    // ...plus a hand-planted non-JSON blob under another id, spliced into the ref's
    // tree the same way saveMergeGroupRecord builds it.
    const blob = await git.run(["hash-object", "-w", "--stdin"], {
      cwd: repo.path,
      stdin: "not json at all",
    });
    const ls = await git.run(["ls-tree", "refs/spry/merge-groups"], { cwd: repo.path });
    const entries = ls.stdout
      .trim()
      .split("\n")
      .filter((l) => l);
    entries.push(`100644 blob ${blob.stdout.trim()}\tbogus`);
    const tree = await git.run(["mktree"], {
      cwd: repo.path,
      stdin: entries.join("\n") + "\n",
    });
    const parent = await git.run(["rev-parse", "--verify", "refs/spry/merge-groups"], {
      cwd: repo.path,
    });
    const commit = await git.run(
      ["commit-tree", tree.stdout.trim(), "-p", parent.stdout.trim(), "-m", "plant bogus"],
      { cwd: repo.path },
    );
    await git.run(["update-ref", "refs/spry/merge-groups", commit.stdout.trim()], {
      cwd: repo.path,
    });

    // The valid record survives; the bogus one is silently skipped.
    const records = await loadMergeGroupRecords(git, { cwd: repo.path });
    expect(records["m1"]).toEqual({ members: ["aaa11111"] });
    expect(records["bogus"]).toBeUndefined();
  });
});

describe("saveMergeGroupRecord", () => {
  test("overwrites an existing record for the same id", async () => {
    const repo = await makeRepo();
    await saveMergeGroupRecord(git, "m1", { members: ["aaa11111"] }, { cwd: repo.path });
    await saveMergeGroupRecord(
      git,
      "m1",
      { members: ["aaa11111", "bbb22222"] },
      { cwd: repo.path },
    );

    const records = await loadMergeGroupRecords(git, { cwd: repo.path });
    expect(records["m1"]).toEqual({ members: ["aaa11111", "bbb22222"] });
  });

  test("saving a second id leaves the first intact", async () => {
    const repo = await makeRepo();
    await saveMergeGroupRecord(git, "m1", { members: ["aaa11111"] }, { cwd: repo.path });
    await saveMergeGroupRecord(git, "m2", { members: ["bbb22222"] }, { cwd: repo.path });

    const records = await loadMergeGroupRecords(git, { cwd: repo.path });
    expect(Object.keys(records).sort()).toEqual(["m1", "m2"]);
  });
});

describe("saveAllMergeGroupRecords", () => {
  test("replaces the whole set (records absent from the map are dropped)", async () => {
    const repo = await makeRepo();
    await saveMergeGroupRecord(git, "m1", { members: ["aaa11111"] }, { cwd: repo.path });
    await saveMergeGroupRecord(git, "m2", { members: ["bbb22222"] }, { cwd: repo.path });

    await saveAllMergeGroupRecords(
      git,
      { m2: { members: ["bbb22222", "ccc33333"] } },
      {
        cwd: repo.path,
      },
    );

    const records = await loadMergeGroupRecords(git, { cwd: repo.path });
    expect(Object.keys(records)).toEqual(["m2"]);
    expect(records["m2"]).toEqual({ members: ["bbb22222", "ccc33333"] });
  });

  test("an empty map yields no records", async () => {
    const repo = await makeRepo();
    await saveMergeGroupRecord(git, "m1", { members: ["aaa11111"] }, { cwd: repo.path });
    await saveAllMergeGroupRecords(git, {}, { cwd: repo.path });

    const records = await loadMergeGroupRecords(git, { cwd: repo.path });
    expect(records).toEqual({});
  });
});

describe("fetchMergeGroupRecords", () => {
  test("returns ok when fetch succeeds", async () => {
    const fakeGit = {
      async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const result = await fetchMergeGroupRecords(fakeGit, "origin");
    expect(result.ok).toBe(true);
  });

  test("returns ok when remote has no merge-groups ref", async () => {
    const fakeGit = {
      async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
        return {
          stdout: "",
          stderr: "couldn't find remote ref refs/spry/merge-groups",
          exitCode: 128,
        };
      },
    };
    const result = await fetchMergeGroupRecords(fakeGit, "origin");
    expect(result.ok).toBe(true);
  });

  test("returns warning on other fetch failure", async () => {
    const fakeGit = {
      async run(_args: string[], _opts?: { cwd?: string; stdin?: string }) {
        return { stdout: "", stderr: "Connection refused", exitCode: 1 };
      },
    };
    const result = await fetchMergeGroupRecords(fakeGit, "origin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning).toMatch(/Connection refused/);
  });
});

describe("refs-seam namespacing (remote refspec)", () => {
  test("push refspec is namespaced when SPRY_REMOTE_REFS_PREFIX is set", async () => {
    const prev = process.env.SPRY_REMOTE_REFS_PREFIX;
    process.env.SPRY_REMOTE_REFS_PREFIX = "refs/spry/t-x";
    try {
      let seenArgs: string[] = [];
      const fakeGit = {
        async run(args: string[], _opts?: { cwd?: string; stdin?: string }) {
          seenArgs = args;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      };
      await pushMergeGroupRecords(fakeGit, "origin");
      // Local side untouched, remote side remapped.
      expect(seenArgs).toContain("refs/spry/merge-groups:refs/spry/t-x/merge-groups");
    } finally {
      if (prev === undefined) delete process.env.SPRY_REMOTE_REFS_PREFIX;
      else process.env.SPRY_REMOTE_REFS_PREFIX = prev;
    }
  });

  test("push refspec is identity when SPRY_REMOTE_REFS_PREFIX is unset", async () => {
    const prev = process.env.SPRY_REMOTE_REFS_PREFIX;
    delete process.env.SPRY_REMOTE_REFS_PREFIX;
    try {
      let seenArgs: string[] = [];
      const fakeGit = {
        async run(args: string[], _opts?: { cwd?: string; stdin?: string }) {
          seenArgs = args;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      };
      await pushMergeGroupRecords(fakeGit, "origin");
      expect(seenArgs).toContain("refs/spry/merge-groups:refs/spry/merge-groups");
    } finally {
      if (prev !== undefined) process.env.SPRY_REMOTE_REFS_PREFIX = prev;
    }
  });
});
