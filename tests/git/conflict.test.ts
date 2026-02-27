import { test, expect, describe, afterAll } from "bun:test";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import type { TestRepo } from "../../tests/lib/index.ts";
import { getFullSha } from "../../src/git/queries.ts";
import {
  getCommitFiles,
  checkFileOverlap,
  parseConflictOutput,
  simulateMerge,
  predictConflict,
  checkReorderConflicts,
} from "../../src/git/conflict.ts";

const git = createRealGitRunner();

// --- Task 14: getCommitFiles, checkFileOverlap, parseConflictOutput ---

describe("getCommitFiles", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns files from a commit with 2 files", async () => {
    repo = await createRepo();
    const sha = await repo.commitFiles(
      { "a.txt": "hello\n", "b.txt": "world\n" },
      "two files",
    );
    const files = await getCommitFiles(git, sha, { cwd: repo.path });
    expect(files.sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("returns [] for empty commit", async () => {
    repo = await createRepo();
    // Create an empty commit using git directly
    await git.run(
      ["commit", "--allow-empty", "-m", "empty commit"],
      { cwd: repo.path },
    );
    const sha = await getFullSha(git, "HEAD", { cwd: repo.path });
    const files = await getCommitFiles(git, sha, { cwd: repo.path });
    expect(files).toEqual([]);
  });
});

describe("checkFileOverlap", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("returns [] for non-overlapping files", async () => {
    repo = await createRepo();
    const base = await getFullSha(git, "HEAD", { cwd: repo.path });

    const shaA = await repo.commitFiles({ "a.txt": "aaa\n" }, "commit A");
    await repo.checkout(base);
    const shaB = await repo.commitFiles({ "b.txt": "bbb\n" }, "commit B");

    const overlap = await checkFileOverlap(git, shaA, shaB, {
      cwd: repo.path,
    });
    expect(overlap).toEqual([]);
  });

  test("returns overlapping file names", async () => {
    repo = await createRepo();
    const base = await getFullSha(git, "HEAD", { cwd: repo.path });

    const shaA = await repo.commitFiles(
      { "shared.txt": "from A\n", "only-a.txt": "a\n" },
      "commit A",
    );
    await repo.checkout(base);
    const shaB = await repo.commitFiles(
      { "shared.txt": "from B\n", "only-b.txt": "b\n" },
      "commit B",
    );

    const overlap = await checkFileOverlap(git, shaA, shaB, {
      cwd: repo.path,
    });
    expect(overlap).toEqual(["shared.txt"]);
  });
});

describe("parseConflictOutput", () => {
  test("extracts files from CONFLICT lines", () => {
    const output = `abc123
CONFLICT (content): Merge conflict in src/main.ts
Auto-merging README.md`;
    const result = parseConflictOutput(output);
    expect(result.files).toEqual(["src/main.ts"]);
  });

  test("returns empty for no conflicts", () => {
    const output = "abc123\nAuto-merging README.md\n";
    const result = parseConflictOutput(output);
    expect(result.files).toEqual([]);
  });

  test("handles Add/add conflicts", () => {
    const output = "CONFLICT (add/add): Add/add src/new.ts";
    const result = parseConflictOutput(output);
    expect(result.files).toEqual(["src/new.ts"]);
  });

  test("deduplicates file names", () => {
    const output = `CONFLICT (content): Merge conflict in file.ts
CONFLICT (content): Merge conflict in file.ts`;
    const result = parseConflictOutput(output);
    expect(result.files).toEqual(["file.ts"]);
  });
});

// --- Task 15: simulateMerge, predictConflict, checkReorderConflicts ---

describe("simulateMerge", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("non-conflicting changes to same file returns clean or warning", async () => {
    repo = await createRepo();
    // Create base with multi-line file
    const baseCommit = await repo.commitFiles(
      { "shared.txt": "line1\nline2\nline3\nline4\nline5\nline6\n" },
      "base file",
    );
    const base = await getFullSha(git, baseCommit, { cwd: repo.path });

    // Branch A: modify top
    const shaA = await repo.commitFiles(
      { "shared.txt": "MODIFIED-TOP\nline2\nline3\nline4\nline5\nline6\n" },
      "modify top",
    );

    // Branch B: modify bottom (from base)
    await repo.checkout(base);
    const shaB = await repo.commitFiles(
      { "shared.txt": "line1\nline2\nline3\nline4\nline5\nMODIFIED-BOTTOM\n" },
      "modify bottom",
    );

    const result = await simulateMerge(
      git,
      base,
      shaA,
      shaB,
      ["shared.txt"],
      { cwd: repo.path },
    );
    // Non-conflicting merge with overlapping files -> warning
    expect(["clean", "warning"]).toContain(result.status);
  });

  test("conflicting changes returns conflict with file in result", async () => {
    repo = await createRepo();
    const baseCommit = await repo.commitFiles(
      { "shared.txt": "original content\n" },
      "base file",
    );
    const base = await getFullSha(git, baseCommit, { cwd: repo.path });

    // Both modify the same line
    const shaA = await repo.commitFiles(
      { "shared.txt": "version A\n" },
      "modify A",
    );

    await repo.checkout(base);
    const shaB = await repo.commitFiles(
      { "shared.txt": "version B\n" },
      "modify B",
    );

    const result = await simulateMerge(
      git,
      base,
      shaA,
      shaB,
      ["shared.txt"],
      { cwd: repo.path },
    );
    expect(result.status).toBe("conflict");
    expect(result.files).toContain("shared.txt");
  });
});

describe("predictConflict", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("different files returns clean", async () => {
    repo = await createRepo();
    const base = await getFullSha(git, "HEAD", { cwd: repo.path });

    const shaA = await repo.commitFiles({ "a.txt": "aaa\n" }, "commit A");
    await repo.checkout(base);
    const shaB = await repo.commitFiles({ "b.txt": "bbb\n" }, "commit B");

    const result = await predictConflict(git, shaA, shaB, base, {
      cwd: repo.path,
    });
    expect(result.status).toBe("clean");
  });

  test("conflicting same file returns conflict", async () => {
    repo = await createRepo();
    const baseCommit = await repo.commitFiles(
      { "shared.txt": "original\n" },
      "base",
    );
    const base = await getFullSha(git, baseCommit, { cwd: repo.path });

    const shaA = await repo.commitFiles(
      { "shared.txt": "version A\n" },
      "A",
    );
    await repo.checkout(base);
    const shaB = await repo.commitFiles(
      { "shared.txt": "version B\n" },
      "B",
    );

    const result = await predictConflict(git, shaA, shaB, base, {
      cwd: repo.path,
    });
    expect(result.status).toBe("conflict");
  });
});

describe("checkReorderConflicts", () => {
  let repo: TestRepo;

  afterAll(async () => {
    if (repo) await repo.cleanup();
  });

  test("same order returns empty map", async () => {
    repo = await createRepo();
    const base = await getFullSha(git, "HEAD", { cwd: repo.path });

    const sha1 = await repo.commitFiles({ "a.txt": "aaa\n" }, "commit 1");
    const sha2 = await repo.commitFiles({ "b.txt": "bbb\n" }, "commit 2");

    const result = await checkReorderConflicts(
      git,
      [sha1, sha2],
      [sha1, sha2],
      base,
      { cwd: repo.path },
    );
    expect(result.size).toBe(0);
  });

  test("reversed order with conflicting file changes returns map with entries", async () => {
    repo = await createRepo();
    const baseCommit = await repo.commitFiles(
      { "shared.txt": "original\n" },
      "base",
    );
    const base = await getFullSha(git, baseCommit, { cwd: repo.path });

    // Two commits that both modify the same file
    const sha1 = await repo.commitFiles(
      { "shared.txt": "version 1\n" },
      "commit 1",
    );
    // sha2 builds on sha1, but we treat them as independent for conflict check
    const sha2 = await repo.commitFiles(
      { "shared.txt": "version 2\n" },
      "commit 2",
    );

    const result = await checkReorderConflicts(
      git,
      [sha1, sha2],
      [sha2, sha1], // reversed
      base,
      { cwd: repo.path },
    );
    expect(result.size).toBeGreaterThan(0);
    // The key should be "sha2:sha1" since sha2 comes before sha1 in new order
    // and their relative order changed (sha1 was before sha2 originally)
    for (const [_key, value] of result) {
      expect(["warning", "conflict"]).toContain(value.status);
    }
  });
});
