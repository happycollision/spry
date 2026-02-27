# Git Operations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the `src/git/` module — config, queries, plumbing, rebase, conflict prediction, and status — all test-first with GitRunner DI.

**Architecture:** Six flat files in `src/git/` with a barrel export. Every function takes `git: GitRunner` as its first parameter. Config is explicit (no auto-detection). Tests use `createRepo()` + `createRealGitRunner()` against real git in temp repos.

**Tech Stack:** Bun (runtime, test runner), TypeScript, git 2.40+ plumbing commands.

**Design doc:** `docs/plans/2026-02-26-git-operations-design.md`

---

## Task 1: Config — types and `trunkRef` helper

**Files:**
- Create: `src/git/config.ts`
- Create: `tests/git/config.test.ts`

**Step 1: Write the failing test**

```ts
// tests/git/config.test.ts
import { test, expect, describe } from "bun:test";
import { trunkRef } from "../../src/git/config.ts";
import type { SpryConfig } from "../../src/git/config.ts";

describe("trunkRef", () => {
  test("combines remote and trunk into ref", () => {
    const config: SpryConfig = { trunk: "main", remote: "origin" };
    expect(trunkRef(config)).toBe("origin/main");
  });

  test("works with non-standard remote and trunk", () => {
    const config: SpryConfig = { trunk: "develop", remote: "upstream" };
    expect(trunkRef(config)).toBe("upstream/develop");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/config.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/git/config.ts
import type { GitRunner } from "../../tests/lib/context.ts";

export interface SpryConfig {
  trunk: string;
  remote: string;
}

export function trunkRef(config: SpryConfig): string {
  return `${config.remote}/${config.trunk}`;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/config.ts tests/git/config.test.ts
git commit -m "feat(git): add SpryConfig type and trunkRef helper"
```

---

## Task 2: Config — `checkGitVersion`

**Files:**
- Modify: `src/git/config.ts`
- Modify: `tests/git/config.test.ts`

**Step 1: Write the failing test**

Append to `tests/git/config.test.ts`:

```ts
import { checkGitVersion } from "../../src/git/config.ts";
import { createRealGitRunner } from "../../tests/lib/index.ts";

const git = createRealGitRunner();

describe("checkGitVersion", () => {
  test("returns version string when git >= 2.40", async () => {
    const version = await checkGitVersion(git);
    // We know our test environment has git >= 2.40
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("throws for git < 2.40", async () => {
    const fakeGit: GitRunner = {
      async run() {
        return { stdout: "git version 2.39.0\n", stderr: "", exitCode: 0 };
      },
    };
    expect(checkGitVersion(fakeGit)).rejects.toThrow("2.40");
  });

  test("throws for unparseable version", async () => {
    const fakeGit: GitRunner = {
      async run() {
        return { stdout: "not a version\n", stderr: "", exitCode: 0 };
      },
    };
    expect(checkGitVersion(fakeGit)).rejects.toThrow();
  });
});
```

Also add the import for `GitRunner`:

```ts
import type { GitRunner } from "../../tests/lib/context.ts";
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/config.test.ts`
Expected: FAIL — checkGitVersion not exported

**Step 3: Write minimal implementation**

Add to `src/git/config.ts`:

```ts
export async function checkGitVersion(git: GitRunner): Promise<string> {
  const result = await git.run(["--version"]);
  const match = result.stdout.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Could not parse git version from: ${result.stdout.trim()}`);
  }

  const major = parseInt(match[1]!, 10);
  const minor = parseInt(match[2]!, 10);
  const version = `${major}.${minor}.${match[3]!}`;

  if (major < 2 || (major === 2 && minor < 40)) {
    throw new Error(
      `spry requires git 2.40 or later (found ${version}).\n` +
        `Update git: https://git-scm.com/downloads`,
    );
  }

  return version;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/config.ts tests/git/config.test.ts
git commit -m "feat(git): add git version check (requires 2.40+)"
```

---

## Task 3: Config — `readConfig`

**Files:**
- Modify: `src/git/config.ts`
- Modify: `tests/git/config.test.ts`

**Step 1: Write the failing test**

Append to `tests/git/config.test.ts`:

```ts
import { readConfig } from "../../src/git/config.ts";
import { createRepo } from "../../tests/lib/index.ts";

describe("readConfig", () => {
  test("reads trunk and remote from git config", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      const config = await readConfig(git, { cwd: repo.path });
      expect(config.trunk).toBe("main");
      expect(config.remote).toBe("origin");
    } finally {
      await repo.cleanup();
    }
  });

  test("throws with suggestion when spry.trunk is not set", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      await expect(readConfig(git, { cwd: repo.path })).rejects.toThrow("spry.trunk");
    } finally {
      await repo.cleanup();
    }
  });

  test("throws with suggestion when spry.remote is not set", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });

      await expect(readConfig(git, { cwd: repo.path })).rejects.toThrow("spry.remote");
    } finally {
      await repo.cleanup();
    }
  });

  test("error suggests branches when trunk missing and origin/main exists", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      // origin/main exists by default in createRepo()

      try {
        await readConfig(git, { cwd: repo.path });
      } catch (e: any) {
        expect(e.message).toContain("main");
        expect(e.message).toContain("git config spry.trunk");
      }
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/config.test.ts`
Expected: FAIL — readConfig not exported

**Step 3: Write minimal implementation**

Add to `src/git/config.ts`:

```ts
export interface ConfigOptions {
  cwd?: string;
}

export async function readConfig(
  git: GitRunner,
  options?: ConfigOptions,
): Promise<SpryConfig> {
  const cwd = options?.cwd;

  const trunkResult = await git.run(["config", "--get", "spry.trunk"], { cwd });
  const remoteResult = await git.run(["config", "--get", "spry.remote"], { cwd });

  if (trunkResult.exitCode !== 0) {
    const suggestion = await suggestTrunk(git, remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : undefined, cwd);
    throw new Error(
      `spry.trunk is not configured.\n\n` +
        `Set it with:\n  git config spry.trunk <branch>\n` +
        suggestion,
    );
  }

  if (remoteResult.exitCode !== 0) {
    const remotes = await listRemotes(git, cwd);
    const suggestion = remotes.length > 0
      ? `\nRemotes found: ${remotes.join(", ")}`
      : "";
    throw new Error(
      `spry.remote is not configured.\n\n` +
        `Set it with:\n  git config spry.remote <remote>\n` +
        suggestion,
    );
  }

  return {
    trunk: trunkResult.stdout.trim(),
    remote: remoteResult.stdout.trim(),
  };
}

async function suggestTrunk(
  git: GitRunner,
  remote: string | undefined,
  cwd?: string,
): Promise<string> {
  if (!remote) return "";

  const result = await git.run(
    ["branch", "-r", "--format=%(refname:short)"],
    { cwd },
  );
  if (result.exitCode !== 0) return "";

  const branches = result.stdout
    .trim()
    .split("\n")
    .filter((b) => b.startsWith(`${remote}/`))
    .map((b) => b.replace(`${remote}/`, ""))
    .filter((b) => b !== "HEAD");

  if (branches.length === 0) return "";
  return `\nBranches found on ${remote}: ${branches.join(", ")}`;
}

async function listRemotes(git: GitRunner, cwd?: string): Promise<string[]> {
  const result = await git.run(["remote"], { cwd });
  if (result.exitCode !== 0) return [];
  return result.stdout.trim().split("\n").filter((r) => r.length > 0);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/config.ts tests/git/config.test.ts
git commit -m "feat(git): add readConfig with explicit trunk/remote requirement"
```

---

## Task 4: Config — `loadConfig`

**Files:**
- Modify: `src/git/config.ts`
- Modify: `tests/git/config.test.ts`

**Step 1: Write the failing test**

Append to `tests/git/config.test.ts`:

```ts
import { loadConfig } from "../../src/git/config.ts";

describe("loadConfig", () => {
  test("returns config when both trunk and remote are set", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      const config = await loadConfig(git, { cwd: repo.path });
      expect(config.trunk).toBe("main");
      expect(config.remote).toBe("origin");
    } finally {
      await repo.cleanup();
    }
  });

  test("throws if git version too old", async () => {
    const fakeGit: GitRunner = {
      async run(args) {
        if (args[0] === "--version") {
          return { stdout: "git version 2.39.0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    await expect(loadConfig(fakeGit)).rejects.toThrow("2.40");
  });

  test("throws if config missing (checked after version)", async () => {
    const repo = await createRepo();
    try {
      // Don't set spry.trunk or spry.remote
      await expect(loadConfig(git, { cwd: repo.path })).rejects.toThrow("spry.");
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/config.test.ts`
Expected: FAIL — loadConfig not exported

**Step 3: Write minimal implementation**

Add to `src/git/config.ts`:

```ts
export async function loadConfig(
  git: GitRunner,
  options?: ConfigOptions,
): Promise<SpryConfig> {
  await checkGitVersion(git);
  return readConfig(git, options);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/config.ts tests/git/config.test.ts
git commit -m "feat(git): add loadConfig (version check + config read)"
```

---

## Task 5: Queries — `getCurrentBranch`, `isDetachedHead`

**Files:**
- Create: `src/git/queries.ts`
- Create: `tests/git/queries.test.ts`

**Step 1: Write the failing test**

```ts
// tests/git/queries.test.ts
import { test, expect, describe } from "bun:test";
import { getCurrentBranch, isDetachedHead } from "../../src/git/queries.ts";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";

const git = createRealGitRunner();

describe("getCurrentBranch", () => {
  test("returns branch name when on a branch", async () => {
    const repo = await createRepo();
    try {
      const branch = await getCurrentBranch(git, { cwd: repo.path });
      expect(branch).toBe("main");
    } finally {
      await repo.cleanup();
    }
  });

  test("returns HEAD in detached HEAD state", async () => {
    const repo = await createRepo();
    try {
      const sha = await repo.commit("some commit");
      await git.run(["checkout", sha], { cwd: repo.path });

      const branch = await getCurrentBranch(git, { cwd: repo.path });
      expect(branch).toBe("HEAD");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("isDetachedHead", () => {
  test("returns false when on a branch", async () => {
    const repo = await createRepo();
    try {
      expect(await isDetachedHead(git, { cwd: repo.path })).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns true when HEAD is detached", async () => {
    const repo = await createRepo();
    try {
      const sha = await repo.commit("some commit");
      await git.run(["checkout", sha], { cwd: repo.path });

      expect(await isDetachedHead(git, { cwd: repo.path })).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/queries.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/git/queries.ts
import type { GitRunner, CommandOptions } from "../../tests/lib/context.ts";
import type { CommitInfo } from "../parse/types.ts";

export interface QueryOptions {
  cwd?: string;
}

export async function getCurrentBranch(
  git: GitRunner,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get current branch: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function isDetachedHead(
  git: GitRunner,
  options?: QueryOptions,
): Promise<boolean> {
  const branch = await getCurrentBranch(git, options);
  return branch === "HEAD";
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/queries.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/queries.ts tests/git/queries.test.ts
git commit -m "feat(git): add getCurrentBranch and isDetachedHead queries"
```

---

## Task 6: Queries — `hasUncommittedChanges`, `getFullSha`, `getShortSha`, `getCommitMessage`

**Files:**
- Modify: `src/git/queries.ts`
- Modify: `tests/git/queries.test.ts`

**Step 1: Write the failing tests**

Append to `tests/git/queries.test.ts`:

```ts
import {
  hasUncommittedChanges,
  getFullSha,
  getShortSha,
  getCommitMessage,
} from "../../src/git/queries.ts";

describe("hasUncommittedChanges", () => {
  test("returns false for clean working tree", async () => {
    const repo = await createRepo();
    try {
      expect(await hasUncommittedChanges(git, { cwd: repo.path })).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns true when files are modified", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(`${repo.path}/README.md`, "modified");
      expect(await hasUncommittedChanges(git, { cwd: repo.path })).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getFullSha", () => {
  test("returns 40-char hex SHA for HEAD", async () => {
    const repo = await createRepo();
    try {
      const sha = await getFullSha(git, "HEAD", { cwd: repo.path });
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns 40-char hex SHA for a branch name", async () => {
    const repo = await createRepo();
    try {
      const sha = await getFullSha(git, "main", { cwd: repo.path });
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getShortSha", () => {
  test("returns abbreviated SHA", async () => {
    const repo = await createRepo();
    try {
      const sha = await getShortSha(git, "HEAD", { cwd: repo.path });
      expect(sha.length).toBeGreaterThanOrEqual(4);
      expect(sha.length).toBeLessThanOrEqual(12);
      expect(sha).toMatch(/^[a-f0-9]+$/);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getCommitMessage", () => {
  test("returns full commit message", async () => {
    const repo = await createRepo();
    try {
      await repo.commit("Test message for getCommitMessage");
      const msg = await getCommitMessage(git, "HEAD", { cwd: repo.path });
      expect(msg).toContain("Test message for getCommitMessage");
    } finally {
      await repo.cleanup();
    }
  });

  test("preserves multi-line messages", async () => {
    const repo = await createRepo();
    try {
      await git.run(
        ["commit", "--allow-empty", "-m", "Subject line\n\nBody paragraph."],
        { cwd: repo.path },
      );
      const msg = await getCommitMessage(git, "HEAD", { cwd: repo.path });
      expect(msg).toContain("Subject line");
      expect(msg).toContain("Body paragraph.");
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/queries.test.ts`
Expected: FAIL — functions not exported

**Step 3: Write minimal implementation**

Add to `src/git/queries.ts`:

```ts
export async function hasUncommittedChanges(
  git: GitRunner,
  options?: QueryOptions,
): Promise<boolean> {
  const result = await git.run(["status", "--porcelain"], { cwd: options?.cwd });
  return result.stdout.trim().length > 0;
}

export async function getFullSha(
  git: GitRunner,
  ref: string,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", ref], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to resolve ref '${ref}': ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function getShortSha(
  git: GitRunner,
  ref: string,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", "--short", ref], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to resolve ref '${ref}': ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function getCommitMessage(
  git: GitRunner,
  commit: string,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["log", "-1", "--format=%B", commit], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get commit message for '${commit}': ${result.stderr}`);
  }
  return result.stdout.replace(/\n+$/, "");
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/queries.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/queries.ts tests/git/queries.test.ts
git commit -m "feat(git): add hasUncommittedChanges, SHA, and commit message queries"
```

---

## Task 7: Queries — `getMergeBase`, `getStackCommits`, `getStackCommitsForBranch`

**Files:**
- Modify: `src/git/queries.ts`
- Modify: `tests/git/queries.test.ts`

**Step 1: Write the failing tests**

Append to `tests/git/queries.test.ts`:

```ts
import {
  getMergeBase,
  getStackCommits,
  getStackCommitsForBranch,
} from "../../src/git/queries.ts";

describe("getMergeBase", () => {
  test("returns merge-base SHA between HEAD and trunk", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      const branchName = await repo.branch("feature");
      await repo.commit("feature work");

      const base = await getMergeBase(git, "origin/main", { cwd: repo.path });
      expect(base).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getStackCommits", () => {
  test("returns empty array when no commits ahead of trunk", async () => {
    const repo = await createRepo();
    try {
      const commits = await getStackCommits(git, "origin/main", { cwd: repo.path });
      expect(commits).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns commits in oldest-first order", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      await repo.commit("first");
      await repo.commit("second");
      await repo.commit("third");

      const commits = await getStackCommits(git, "origin/main", { cwd: repo.path });
      expect(commits).toHaveLength(3);
      expect(commits[0]!.subject).toContain("first");
      expect(commits[1]!.subject).toContain("second");
      expect(commits[2]!.subject).toContain("third");
    } finally {
      await repo.cleanup();
    }
  });

  test("populates hash, subject, and body fields", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      await repo.commit("My subject");

      const commits = await getStackCommits(git, "origin/main", { cwd: repo.path });
      expect(commits).toHaveLength(1);
      expect(commits[0]!.hash).toMatch(/^[a-f0-9]{40}$/);
      expect(commits[0]!.subject).toContain("My subject");
      expect(commits[0]!.body).toBeDefined();
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getStackCommitsForBranch", () => {
  test("returns commits for a specific branch", async () => {
    const repo = await createRepo();
    try {
      const branchName = await repo.branch("feature");
      await repo.commit("branch work");
      await repo.checkout("main");

      const commits = await getStackCommitsForBranch(git, branchName, "origin/main", { cwd: repo.path });
      expect(commits).toHaveLength(1);
      expect(commits[0]!.subject).toContain("branch work");
    } finally {
      await repo.cleanup();
    }
  });

  test("returns empty array for branch at trunk", async () => {
    const repo = await createRepo();
    try {
      const commits = await getStackCommitsForBranch(git, "main", "origin/main", { cwd: repo.path });
      expect(commits).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/queries.test.ts`
Expected: FAIL — functions not exported

**Step 3: Write minimal implementation**

Add to `src/git/queries.ts`:

```ts
export async function getMergeBase(
  git: GitRunner,
  trunkRef: string,
  options?: QueryOptions,
): Promise<string> {
  const result = await git.run(["merge-base", "HEAD", trunkRef], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to find merge-base with ${trunkRef}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function parseCommitLog(output: string): CommitInfo[] {
  if (!output.trim()) return [];

  const records = output.split("\x01").filter((r) => r.trim());
  const commits: CommitInfo[] = [];

  for (const record of records) {
    const [hashRaw, subject, body] = record.split("\x00");
    if (hashRaw && subject !== undefined && body !== undefined) {
      commits.push({
        hash: hashRaw.trim(),
        subject,
        body,
        trailers: {},
      });
    }
  }

  return commits;
}

export async function getStackCommits(
  git: GitRunner,
  trunkRef: string,
  options?: QueryOptions,
): Promise<CommitInfo[]> {
  const mergeBase = await getMergeBase(git, trunkRef, options);
  const result = await git.run(
    ["log", "--reverse", "--format=%H%x00%s%x00%B%x01", `${mergeBase}..HEAD`],
    { cwd: options?.cwd },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get stack commits: ${result.stderr}`);
  }
  return parseCommitLog(result.stdout);
}

export async function getStackCommitsForBranch(
  git: GitRunner,
  branch: string,
  trunkRef: string,
  options?: QueryOptions,
): Promise<CommitInfo[]> {
  const result = await git.run(
    ["log", "--reverse", "--format=%H%x00%s%x00%B%x01", `${trunkRef}..${branch}`],
    { cwd: options?.cwd },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get commits for branch '${branch}': ${result.stderr}`);
  }
  return parseCommitLog(result.stdout);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/queries.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/queries.ts tests/git/queries.test.ts
git commit -m "feat(git): add getMergeBase and stack commit queries"
```

---

## Task 8: Plumbing — `getTree`, `getParent`, `getParents`

**Files:**
- Create: `src/git/plumbing.ts`
- Create: `tests/git/plumbing.test.ts`

**Step 1: Write the failing test**

```ts
// tests/git/plumbing.test.ts
import { test, expect, describe } from "bun:test";
import { getTree, getParent, getParents } from "../../src/git/plumbing.ts";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import { $ } from "bun";

const git = createRealGitRunner();

describe("getTree", () => {
  test("returns tree SHA from HEAD", async () => {
    const repo = await createRepo();
    try {
      const tree = await getTree(git, "HEAD", { cwd: repo.path });
      expect(tree).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns tree SHA from a commit hash", async () => {
    const repo = await createRepo();
    try {
      const sha = await repo.commit("test");
      const tree = await getTree(git, sha, { cwd: repo.path });
      expect(tree).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getParent", () => {
  test("returns first parent of a commit", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const sha = await repo.commit("child");
      const parent = await getParent(git, sha, { cwd: repo.path });
      expect(parent).toMatch(/^[a-f0-9]{40}$/);
      expect(parent).not.toBe(sha);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getParents", () => {
  test("returns single parent for normal commit", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const sha = await repo.commit("child");
      const parents = await getParents(git, sha, { cwd: repo.path });
      expect(parents).toHaveLength(1);
      expect(parents[0]).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns empty array for root commit", async () => {
    const repo = await createRepo();
    try {
      const rootResult = await git.run(
        ["rev-list", "--max-parents=0", "HEAD"],
        { cwd: repo.path },
      );
      const rootCommit = rootResult.stdout.trim();
      const parents = await getParents(git, rootCommit, { cwd: repo.path });
      expect(parents).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/plumbing.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/git/plumbing.ts
import type { GitRunner } from "../../tests/lib/context.ts";

export interface PlumbingOptions {
  cwd?: string;
}

export async function getTree(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", `${commit}^{tree}`], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get tree for '${commit}': ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function getParent(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string> {
  const result = await git.run(["rev-parse", `${commit}^`], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get parent for '${commit}': ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function getParents(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string[]> {
  const result = await git.run(["rev-parse", `${commit}^@`], { cwd: options?.cwd });
  if (result.exitCode !== 0 && !result.stderr.includes("unknown revision")) {
    // For root commits, rev-parse commit^@ may fail or return empty
    return [];
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) return [];
  return trimmed.split("\n").map((line) => line.trim());
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/plumbing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/plumbing.ts tests/git/plumbing.test.ts
git commit -m "feat(git): add tree and parent plumbing queries"
```

---

## Task 9: Plumbing — `getAuthorEnv`, `getAuthorAndCommitterEnv`, `createCommit`

**Files:**
- Modify: `src/git/plumbing.ts`
- Modify: `tests/git/plumbing.test.ts`

**Step 1: Write the failing tests**

Append to `tests/git/plumbing.test.ts`:

```ts
import {
  getAuthorEnv,
  getAuthorAndCommitterEnv,
  createCommit,
} from "../../src/git/plumbing.ts";
import { getFullSha } from "../../src/git/queries.ts";

describe("getAuthorEnv", () => {
  test("returns author name, email, and date", async () => {
    const repo = await createRepo();
    try {
      await repo.commit("test commit");
      const env = await getAuthorEnv(git, "HEAD", { cwd: repo.path });
      expect(env.GIT_AUTHOR_NAME).toBe("Test User");
      expect(env.GIT_AUTHOR_EMAIL).toBe("test@example.com");
      expect(env.GIT_AUTHOR_DATE).toBeDefined();
    } finally {
      await repo.cleanup();
    }
  });
});

describe("getAuthorAndCommitterEnv", () => {
  test("returns both author and committer fields", async () => {
    const repo = await createRepo();
    try {
      await repo.commit("test commit");
      const env = await getAuthorAndCommitterEnv(git, "HEAD", { cwd: repo.path });
      expect(env.GIT_AUTHOR_NAME).toBeDefined();
      expect(env.GIT_COMMITTER_NAME).toBeDefined();
      expect(env.GIT_AUTHOR_EMAIL).toBeDefined();
      expect(env.GIT_COMMITTER_EMAIL).toBeDefined();
      expect(env.GIT_AUTHOR_DATE).toBeDefined();
      expect(env.GIT_COMMITTER_DATE).toBeDefined();
    } finally {
      await repo.cleanup();
    }
  });
});

describe("createCommit", () => {
  test("creates a new commit object", async () => {
    const repo = await createRepo();
    try {
      const tree = await getTree(git, "HEAD", { cwd: repo.path });
      const parentSha = await getFullSha(git, "HEAD", { cwd: repo.path });
      const env = await getAuthorEnv(git, "HEAD", { cwd: repo.path });

      const newSha = await createCommit(
        git,
        tree,
        [parentSha],
        "Test plumbing commit",
        env,
        { cwd: repo.path },
      );

      expect(newSha).toMatch(/^[a-f0-9]{40}$/);
      expect(newSha).not.toBe(parentSha);
    } finally {
      await repo.cleanup();
    }
  });

  test("created commit has correct message", async () => {
    const repo = await createRepo();
    try {
      const tree = await getTree(git, "HEAD", { cwd: repo.path });
      const parentSha = await getFullSha(git, "HEAD", { cwd: repo.path });
      const env = await getAuthorEnv(git, "HEAD", { cwd: repo.path });

      const newSha = await createCommit(
        git,
        tree,
        [parentSha],
        "Specific message here",
        env,
        { cwd: repo.path },
      );

      const msgResult = await git.run(["log", "-1", "--format=%B", newSha], { cwd: repo.path });
      expect(msgResult.stdout).toContain("Specific message here");
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/plumbing.test.ts`
Expected: FAIL — functions not exported

**Step 3: Write minimal implementation**

Add to `src/git/plumbing.ts`:

```ts
export async function getAuthorEnv(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<Record<string, string>> {
  const result = await git.run(
    ["log", "-1", "--format=%an%x00%ae%x00%ai", commit],
    { cwd: options?.cwd },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get author info for '${commit}': ${result.stderr}`);
  }
  const [name = "", email = "", date = ""] = result.stdout.trim().split("\x00");
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
  };
}

export async function getAuthorAndCommitterEnv(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<Record<string, string>> {
  const result = await git.run(
    ["log", "-1", "--format=%an%x00%ae%x00%ai%x00%cn%x00%ce%x00%ci", commit],
    { cwd: options?.cwd },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get author/committer info for '${commit}': ${result.stderr}`);
  }
  const [
    authorName = "",
    authorEmail = "",
    authorDate = "",
    committerName = "",
    committerEmail = "",
    committerDate = "",
  ] = result.stdout.trim().split("\x00");

  return {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
    GIT_COMMITTER_DATE: committerDate,
  };
}

export async function createCommit(
  git: GitRunner,
  tree: string,
  parents: string[],
  message: string,
  env: Record<string, string>,
  options?: PlumbingOptions,
): Promise<string> {
  const parentFlags = parents.flatMap((p) => ["-p", p]);
  const result = await git.run(
    ["commit-tree", tree, ...parentFlags],
    { cwd: options?.cwd, env, stdin: message },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create commit: ${result.stderr}`);
  }
  return result.stdout.trim();
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/plumbing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/plumbing.ts tests/git/plumbing.test.ts
git commit -m "feat(git): add author env extraction and commit creation plumbing"
```

---

## Task 10: Plumbing — `mergeTree`, `updateRef`, `resetToCommit`

**Files:**
- Modify: `src/git/plumbing.ts`
- Modify: `tests/git/plumbing.test.ts`

**Step 1: Write the failing tests**

Append to `tests/git/plumbing.test.ts`:

```ts
import { mergeTree, updateRef, resetToCommit } from "../../src/git/plumbing.ts";

describe("mergeTree", () => {
  test("returns tree SHA for clean merge", async () => {
    const repo = await createRepo();
    try {
      // Create a branch with one file, main with another file — no overlap
      const base = await getFullSha(git, "HEAD", { cwd: repo.path });
      await repo.branch("feature");
      await repo.commitFiles({ "feature.txt": "feature content" }, "feature file");
      const featureSha = await getFullSha(git, "HEAD", { cwd: repo.path });

      await repo.checkout("main");
      await repo.commitFiles({ "main.txt": "main content" }, "main file");
      const mainSha = await getFullSha(git, "HEAD", { cwd: repo.path });

      const result = await mergeTree(git, base, mainSha, featureSha, { cwd: repo.path });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.tree).toMatch(/^[a-f0-9]{40}$/);
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("returns conflict info for conflicting merge", async () => {
    const repo = await createRepo();
    try {
      const base = await getFullSha(git, "HEAD", { cwd: repo.path });
      await repo.branch("feature");
      await repo.commitFiles({ "shared.txt": "feature version" }, "feature change");
      const featureSha = await getFullSha(git, "HEAD", { cwd: repo.path });

      await repo.checkout("main");
      await repo.commitFiles({ "shared.txt": "main version" }, "main change");
      const mainSha = await getFullSha(git, "HEAD", { cwd: repo.path });

      const result = await mergeTree(git, base, mainSha, featureSha, { cwd: repo.path });
      expect(result.ok).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("updateRef", () => {
  test("updates a branch ref", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("test-branch");
      await repo.commit("new commit");
      const newSha = await getFullSha(git, "HEAD", { cwd: repo.path });

      await repo.checkout("main");
      const oldMainSha = await getFullSha(git, "main", { cwd: repo.path });

      await updateRef(git, "refs/heads/main", newSha, oldMainSha, { cwd: repo.path });

      const updatedSha = await getFullSha(git, "main", { cwd: repo.path });
      expect(updatedSha).toBe(newSha);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("resetToCommit", () => {
  test("resets working directory to match commit", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      await repo.commitFiles({ "new-file.txt": "content" }, "add file");

      // Working directory should have new-file.txt
      const exists = await Bun.file(`${repo.path}/new-file.txt`).exists();
      expect(exists).toBe(true);

      // Reset to main (which doesn't have the file)
      const mainSha = await getFullSha(git, "origin/main", { cwd: repo.path });
      await resetToCommit(git, mainSha, { cwd: repo.path });

      const existsAfter = await Bun.file(`${repo.path}/new-file.txt`).exists();
      expect(existsAfter).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/plumbing.test.ts`
Expected: FAIL — functions not exported

**Step 3: Write minimal implementation**

Add to `src/git/plumbing.ts`:

```ts
export type MergeTreeResult =
  | { ok: true; tree: string }
  | { ok: false; conflictInfo: string };

export async function mergeTree(
  git: GitRunner,
  base: string,
  ours: string,
  theirs: string,
  options?: PlumbingOptions,
): Promise<MergeTreeResult> {
  const result = await git.run(
    ["merge-tree", "--write-tree", `--merge-base=${base}`, ours, theirs],
    { cwd: options?.cwd },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      conflictInfo: result.stdout + result.stderr,
    };
  }
  const tree = result.stdout.trim().split("\n")[0]!;
  return { ok: true, tree };
}

export async function updateRef(
  git: GitRunner,
  ref: string,
  newSha: string,
  oldSha?: string,
  options?: PlumbingOptions,
): Promise<void> {
  const args = oldSha
    ? ["update-ref", ref, newSha, oldSha]
    : ["update-ref", ref, newSha];
  const result = await git.run(args, { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to update ref '${ref}': ${result.stderr}`);
  }
}

export async function resetToCommit(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<void> {
  const result = await git.run(["reset", "--hard", commit], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to reset to '${commit}': ${result.stderr}`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/plumbing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/plumbing.ts tests/git/plumbing.test.ts
git commit -m "feat(git): add mergeTree, updateRef, and resetToCommit plumbing"
```

---

## Task 11: Plumbing — `rewriteCommitChain`

**Files:**
- Modify: `src/git/plumbing.ts`
- Modify: `tests/git/plumbing.test.ts`

**Step 1: Write the failing tests**

Append to `tests/git/plumbing.test.ts`:

```ts
import { rewriteCommitChain } from "../../src/git/plumbing.ts";
import type { ChainRewriteResult } from "../../src/git/plumbing.ts";
import { getCommitMessage } from "../../src/git/queries.ts";

describe("rewriteCommitChain", () => {
  test("rewrites message for a single commit", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const sha = await repo.commit("original message");

      const result = await rewriteCommitChain(
        git,
        [sha],
        new Map([[sha, "rewritten message"]]),
        { cwd: repo.path },
      );

      expect(result.newTip).toMatch(/^[a-f0-9]{40}$/);
      expect(result.newTip).not.toBe(sha);
      expect(result.mapping.size).toBe(1);

      const msg = await getCommitMessage(git, result.newTip, { cwd: repo.path });
      expect(msg).toContain("rewritten message");
    } finally {
      await repo.cleanup();
    }
  });

  test("rewrites only specified commits in a chain", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const sha1 = await repo.commit("first");
      const sha2 = await repo.commit("second");
      const sha3 = await repo.commit("third");

      // Only rewrite the middle commit
      const result = await rewriteCommitChain(
        git,
        [sha1, sha2, sha3],
        new Map([[sha2, "REWRITTEN second"]]),
        { cwd: repo.path },
      );

      expect(result.mapping.size).toBe(3);

      // Check middle commit got new message
      const newSha2 = result.mapping.get(sha2)!;
      const msg2 = await getCommitMessage(git, newSha2, { cwd: repo.path });
      expect(msg2).toContain("REWRITTEN second");

      // Check first and third kept original messages
      const newSha1 = result.mapping.get(sha1)!;
      const msg1 = await getCommitMessage(git, newSha1, { cwd: repo.path });
      expect(msg1).toContain("first");

      const msg3 = await getCommitMessage(git, result.newTip, { cwd: repo.path });
      expect(msg3).toContain("third");
    } finally {
      await repo.cleanup();
    }
  });

  test("preserves tree contents across rewrite", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const sha = await repo.commitFiles({ "test.txt": "content" }, "add file");

      const originalTree = await getTree(git, sha, { cwd: repo.path });
      const result = await rewriteCommitChain(
        git,
        [sha],
        new Map([[sha, "new message"]]),
        { cwd: repo.path },
      );
      const newTree = await getTree(git, result.newTip, { cwd: repo.path });

      expect(newTree).toBe(originalTree);
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/plumbing.test.ts`
Expected: FAIL — rewriteCommitChain not exported

**Step 3: Write minimal implementation**

Add to `src/git/plumbing.ts`:

```ts
export interface ChainRewriteResult {
  newTip: string;
  mapping: Map<string, string>;
}

export async function rewriteCommitChain(
  git: GitRunner,
  commits: string[],
  rewrites: Map<string, string>,
  options?: PlumbingOptions,
): Promise<ChainRewriteResult> {
  if (commits.length === 0) {
    throw new Error("Cannot rewrite empty commit chain");
  }

  const mapping = new Map<string, string>();
  let currentParent = await getParent(git, commits[0]!, options);

  for (const originalHash of commits) {
    const tree = await getTree(git, originalHash, options);
    const env = await getAuthorAndCommitterEnv(git, originalHash, options);
    const message = rewrites.get(originalHash)
      ?? (await getCommitMessageInternal(git, originalHash, options));
    const newHash = await createCommit(git, tree, [currentParent], message, env, options);
    mapping.set(originalHash, newHash);
    currentParent = newHash;
  }

  return { newTip: currentParent, mapping };
}

async function getCommitMessageInternal(
  git: GitRunner,
  commit: string,
  options?: PlumbingOptions,
): Promise<string> {
  const result = await git.run(["log", "-1", "--format=%B", commit], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get commit message for '${commit}': ${result.stderr}`);
  }
  return result.stdout.replace(/\n+$/, "");
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/plumbing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/plumbing.ts tests/git/plumbing.test.ts
git commit -m "feat(git): add rewriteCommitChain plumbing"
```

---

## Task 12: Plumbing — `rebasePlumbing`, `finalizeRewrite`

**Files:**
- Modify: `src/git/plumbing.ts`
- Modify: `tests/git/plumbing.test.ts`

**Step 1: Write the failing tests**

Append to `tests/git/plumbing.test.ts`:

```ts
import { rebasePlumbing, finalizeRewrite } from "../../src/git/plumbing.ts";
import type { PlumbingRebaseResult } from "../../src/git/plumbing.ts";

describe("rebasePlumbing", () => {
  test("rebases commits onto a new base", async () => {
    const repo = await createRepo();
    try {
      // Create main with some work
      await repo.commitFiles({ "main-file.txt": "main content" }, "main work");
      await git.run(["push", "origin", "main"], { cwd: repo.path });
      await repo.fetch();

      // Create feature branch from earlier point
      await git.run(["checkout", "-b", `feature-${repo.uniqueId}`, "origin/main~1"], { cwd: repo.path });
      const sha1 = await repo.commitFiles({ "feat.txt": "feature" }, "feature work");

      // Rebase feature onto latest main
      const mainSha = await getFullSha(git, "origin/main", { cwd: repo.path });
      const result = await rebasePlumbing(git, mainSha, [sha1], { cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.newTip).toMatch(/^[a-f0-9]{40}$/);
        expect(result.newTip).not.toBe(sha1);
        expect(result.mapping.size).toBe(1);
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("returns empty mapping for empty commits array", async () => {
    const repo = await createRepo();
    try {
      const sha = await getFullSha(git, "HEAD", { cwd: repo.path });
      const result = await rebasePlumbing(git, sha, [], { cwd: repo.path });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.newTip).toBe(sha);
        expect(result.mapping.size).toBe(0);
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("detects conflicts during rebase", async () => {
    const repo = await createRepo();
    try {
      const base = await getFullSha(git, "HEAD", { cwd: repo.path });

      // Create conflicting changes on two branches
      await repo.commitFiles({ "conflict.txt": "main version" }, "main change");
      const mainSha = await getFullSha(git, "HEAD", { cwd: repo.path });

      await git.run(["checkout", "-b", `feature-${repo.uniqueId}`, base], { cwd: repo.path });
      const featureSha = await repo.commitFiles({ "conflict.txt": "feature version" }, "feature change");

      const result = await rebasePlumbing(git, mainSha, [featureSha], { cwd: repo.path });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.conflictCommit).toBe(featureSha);
      }
    } finally {
      await repo.cleanup();
    }
  });
});

describe("finalizeRewrite", () => {
  test("updates branch ref after message-only rewrite (no reset needed)", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const sha = await repo.commit("original");
      const oldTip = await getFullSha(git, "HEAD", { cwd: repo.path });

      const result = await rewriteCommitChain(
        git,
        [sha],
        new Map([[sha, "rewritten"]]),
        { cwd: repo.path },
      );

      const branch = await git.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.path });
      await finalizeRewrite(git, branch.stdout.trim(), oldTip, result.newTip, { cwd: repo.path });

      const newHead = await getFullSha(git, "HEAD", { cwd: repo.path });
      expect(newHead).toBe(result.newTip);
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/plumbing.test.ts`
Expected: FAIL — functions not exported

**Step 3: Write minimal implementation**

Add to `src/git/plumbing.ts`:

```ts
export type PlumbingRebaseResult =
  | { ok: true; newTip: string; mapping: Map<string, string> }
  | { ok: false; conflictCommit: string; conflictInfo: string };

export async function rebasePlumbing(
  git: GitRunner,
  onto: string,
  commits: string[],
  options?: PlumbingOptions,
): Promise<PlumbingRebaseResult> {
  if (commits.length === 0) {
    return { ok: true, newTip: onto, mapping: new Map() };
  }

  const mapping = new Map<string, string>();
  let currentTip = onto;

  for (const commit of commits) {
    const originalParent = await getParent(git, commit, options);
    const mergeResult = await mergeTree(git, originalParent, currentTip, commit, options);

    if (!mergeResult.ok) {
      return {
        ok: false,
        conflictCommit: commit,
        conflictInfo: mergeResult.conflictInfo,
      };
    }

    const message = await getCommitMessageInternal(git, commit, options);
    const env = await getAuthorEnv(git, commit, options);
    const newHash = await createCommit(git, mergeResult.tree, [currentTip], message, env, options);

    mapping.set(commit, newHash);
    currentTip = newHash;
  }

  return { ok: true, newTip: currentTip, mapping };
}

export async function finalizeRewrite(
  git: GitRunner,
  branch: string,
  oldTip: string,
  newTip: string,
  options?: PlumbingOptions,
): Promise<void> {
  const oldTree = await getTree(git, oldTip, options);
  const newTree = await getTree(git, newTip, options);

  await updateRef(git, `refs/heads/${branch}`, newTip, oldTip, options);

  if (oldTree !== newTree) {
    await resetToCommit(git, newTip, options);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/plumbing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/plumbing.ts tests/git/plumbing.test.ts
git commit -m "feat(git): add rebasePlumbing and finalizeRewrite"
```

---

## Task 13: Status — `getWorkingTreeStatus`, `requireCleanWorkingTree`

**Files:**
- Create: `src/git/status.ts`
- Create: `tests/git/status.test.ts`

**Step 1: Write the failing test**

```ts
// tests/git/status.test.ts
import { test, expect, describe } from "bun:test";
import { getWorkingTreeStatus, requireCleanWorkingTree } from "../../src/git/status.ts";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";

const git = createRealGitRunner();

describe("getWorkingTreeStatus", () => {
  test("reports clean tree", async () => {
    const repo = await createRepo();
    try {
      const status = await getWorkingTreeStatus(git, { cwd: repo.path });
      expect(status.isDirty).toBe(false);
      expect(status.hasUnstagedChanges).toBe(false);
      expect(status.hasStagedChanges).toBe(false);
      expect(status.hasUntrackedFiles).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  test("detects unstaged changes", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(`${repo.path}/README.md`, "modified content");
      const status = await getWorkingTreeStatus(git, { cwd: repo.path });
      expect(status.isDirty).toBe(true);
      expect(status.hasUnstagedChanges).toBe(true);
      expect(status.hasStagedChanges).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  test("detects staged changes", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(`${repo.path}/README.md`, "modified content");
      await git.run(["add", "README.md"], { cwd: repo.path });
      const status = await getWorkingTreeStatus(git, { cwd: repo.path });
      expect(status.isDirty).toBe(true);
      expect(status.hasStagedChanges).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("detects untracked files", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(`${repo.path}/untracked.txt`, "new file");
      const status = await getWorkingTreeStatus(git, { cwd: repo.path });
      expect(status.isDirty).toBe(true);
      expect(status.hasUntrackedFiles).toBe(true);
      expect(status.hasUnstagedChanges).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("requireCleanWorkingTree", () => {
  test("does not throw for clean tree", async () => {
    const repo = await createRepo();
    try {
      await expect(requireCleanWorkingTree(git, { cwd: repo.path })).resolves.toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  test("throws for unstaged changes", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(`${repo.path}/README.md`, "modified");
      await expect(requireCleanWorkingTree(git, { cwd: repo.path })).rejects.toThrow("uncommitted");
    } finally {
      await repo.cleanup();
    }
  });

  test("does not throw for untracked files only", async () => {
    const repo = await createRepo();
    try {
      await Bun.write(`${repo.path}/untracked.txt`, "new file");
      await expect(requireCleanWorkingTree(git, { cwd: repo.path })).resolves.toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/status.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/git/status.ts
import type { GitRunner } from "../../tests/lib/context.ts";

export interface StatusOptions {
  cwd?: string;
}

export interface WorkingTreeStatus {
  isDirty: boolean;
  hasUnstagedChanges: boolean;
  hasStagedChanges: boolean;
  hasUntrackedFiles: boolean;
}

export async function getWorkingTreeStatus(
  git: GitRunner,
  options?: StatusOptions,
): Promise<WorkingTreeStatus> {
  const result = await git.run(["status", "--porcelain"], { cwd: options?.cwd });
  const lines = result.stdout.split("\n").filter((l) => l.length > 0);

  return {
    isDirty: lines.length > 0,
    hasUnstagedChanges: lines.some((l) => l[1] !== " " && l[1] !== "?"),
    hasStagedChanges: lines.some((l) => l[0] !== " " && l[0] !== "?"),
    hasUntrackedFiles: lines.some((l) => l.startsWith("??")),
  };
}

export async function requireCleanWorkingTree(
  git: GitRunner,
  options?: StatusOptions,
): Promise<void> {
  const status = await getWorkingTreeStatus(git, options);

  if (status.hasStagedChanges || status.hasUnstagedChanges) {
    const parts: string[] = [];
    if (status.hasStagedChanges) parts.push("staged changes");
    if (status.hasUnstagedChanges) parts.push("unstaged changes");
    throw new Error(`Cannot proceed with uncommitted changes: ${parts.join(" and ")}`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/status.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/status.ts tests/git/status.test.ts
git commit -m "feat(git): add working tree status queries"
```

---

## Task 14: Conflict — `getCommitFiles`, `checkFileOverlap`, `parseConflictOutput`

**Files:**
- Create: `src/git/conflict.ts`
- Create: `tests/git/conflict.test.ts`

**Step 1: Write the failing test**

```ts
// tests/git/conflict.test.ts
import { test, expect, describe } from "bun:test";
import {
  getCommitFiles,
  checkFileOverlap,
  parseConflictOutput,
} from "../../src/git/conflict.ts";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";

const git = createRealGitRunner();

describe("getCommitFiles", () => {
  test("returns files modified by a commit", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const sha = await repo.commitFiles(
        { "a.txt": "a", "b.txt": "b" },
        "add two files",
      );
      const files = await getCommitFiles(git, sha, { cwd: repo.path });
      expect(files).toContain("a.txt");
      expect(files).toContain("b.txt");
    } finally {
      await repo.cleanup();
    }
  });

  test("returns empty array for commit with no file changes", async () => {
    const repo = await createRepo();
    try {
      await git.run(["commit", "--allow-empty", "-m", "empty"], { cwd: repo.path });
      const shaResult = await git.run(["rev-parse", "HEAD"], { cwd: repo.path });
      const sha = shaResult.stdout.trim();
      const files = await getCommitFiles(git, sha, { cwd: repo.path });
      expect(files).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("checkFileOverlap", () => {
  test("returns empty array for non-overlapping commits", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const sha1 = await repo.commitFiles({ "a.txt": "a" }, "file a");
      const sha2 = await repo.commitFiles({ "b.txt": "b" }, "file b");

      const overlap = await checkFileOverlap(git, sha1, sha2, { cwd: repo.path });
      expect(overlap).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns overlapping file names", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const sha1 = await repo.commitFiles({ "shared.txt": "version 1" }, "first version");
      const sha2 = await repo.commitFiles({ "shared.txt": "version 2" }, "second version");

      const overlap = await checkFileOverlap(git, sha1, sha2, { cwd: repo.path });
      expect(overlap).toContain("shared.txt");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("parseConflictOutput", () => {
  test("extracts file names from CONFLICT lines", () => {
    const output = `
CONFLICT (content): Merge conflict in src/main.ts
CONFLICT (content): Merge conflict in src/util.ts
`;
    const result = parseConflictOutput(output);
    expect(result.files).toContain("src/main.ts");
    expect(result.files).toContain("src/util.ts");
  });

  test("returns empty for no conflicts", () => {
    const result = parseConflictOutput("clean merge output");
    expect(result.files).toEqual([]);
  });

  test("handles Add/add conflicts", () => {
    const output = "CONFLICT (Add/add): Merge conflict in new-file.ts";
    const result = parseConflictOutput(output);
    expect(result.files).toContain("new-file.ts");
  });

  test("deduplicates file names", () => {
    const output = `
CONFLICT (content): Merge conflict in file.ts
CONFLICT (content): Merge conflict in file.ts
`;
    const result = parseConflictOutput(output);
    expect(result.files).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/conflict.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/git/conflict.ts
import type { GitRunner } from "../../tests/lib/context.ts";

export interface ConflictOptions {
  cwd?: string;
}

export interface ConflictResult {
  status: "clean" | "warning" | "conflict";
  files?: string[];
}

export async function getCommitFiles(
  git: GitRunner,
  hash: string,
  options?: ConflictOptions,
): Promise<string[]> {
  const result = await git.run(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", hash],
    { cwd: options?.cwd },
  );
  return result.stdout
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

export async function checkFileOverlap(
  git: GitRunner,
  commitA: string,
  commitB: string,
  options?: ConflictOptions,
): Promise<string[]> {
  const [filesA, filesB] = await Promise.all([
    getCommitFiles(git, commitA, options),
    getCommitFiles(git, commitB, options),
  ]);
  const setA = new Set(filesA);
  return filesB.filter((f) => setA.has(f));
}

export function parseConflictOutput(output: string): { files: string[] } {
  const files: string[] = [];
  const regex = /CONFLICT \([^)]+\): (?:Merge conflict in|Add\/add|Rename\/rename) (.+)/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const file = match[1]?.trim();
    if (file && !files.includes(file)) {
      files.push(file);
    }
  }
  return { files };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/conflict.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/conflict.ts tests/git/conflict.test.ts
git commit -m "feat(git): add commit file queries and conflict output parsing"
```

---

## Task 15: Conflict — `simulateMerge`, `predictConflict`, `checkReorderConflicts`

**Files:**
- Modify: `src/git/conflict.ts`
- Modify: `tests/git/conflict.test.ts`

**Step 1: Write the failing tests**

Append to `tests/git/conflict.test.ts`:

```ts
import {
  simulateMerge,
  predictConflict,
  checkReorderConflicts,
} from "../../src/git/conflict.ts";
import { getFullSha } from "../../src/git/queries.ts";

describe("simulateMerge", () => {
  test("returns clean for non-conflicting changes to same file", async () => {
    const repo = await createRepo();
    try {
      // Create file with two sections
      await repo.commitFiles(
        { "shared.txt": "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n" },
        "base file",
      );
      const base = await getFullSha(git, "HEAD", { cwd: repo.path });

      // Commit A modifies top
      const shaA = await repo.commitFiles(
        { "shared.txt": "MODIFIED\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n" },
        "modify top",
      );

      // Commit B modifies bottom
      await git.run(["checkout", base], { cwd: repo.path });
      const shaB = await repo.commitFiles(
        { "shared.txt": "line1\nline2\nline3\nline4\nline5\nline6\nline7\nMODIFIED\n" },
        "modify bottom",
      );

      const result = await simulateMerge(git, base, shaA, shaB, ["shared.txt"], { cwd: repo.path });
      // Non-conflicting overlapping files = warning or clean depending on merge result
      expect(["clean", "warning"]).toContain(result.status);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns conflict for conflicting changes to same lines", async () => {
    const repo = await createRepo();
    try {
      await repo.commitFiles({ "file.txt": "original" }, "base");
      const base = await getFullSha(git, "HEAD", { cwd: repo.path });

      const shaA = await repo.commitFiles({ "file.txt": "version A" }, "change A");

      await git.run(["checkout", base], { cwd: repo.path });
      const shaB = await repo.commitFiles({ "file.txt": "version B" }, "change B");

      const result = await simulateMerge(git, base, shaA, shaB, ["file.txt"], { cwd: repo.path });
      expect(result.status).toBe("conflict");
      expect(result.files).toContain("file.txt");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("predictConflict", () => {
  test("returns clean for commits touching different files", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const base = await getFullSha(git, "HEAD", { cwd: repo.path });
      const shaA = await repo.commitFiles({ "a.txt": "a" }, "file a");
      const shaB = await repo.commitFiles({ "b.txt": "b" }, "file b");

      const result = await predictConflict(git, shaA, shaB, base, { cwd: repo.path });
      expect(result.status).toBe("clean");
    } finally {
      await repo.cleanup();
    }
  });

  test("returns conflict for commits with conflicting changes", async () => {
    const repo = await createRepo();
    try {
      await repo.commitFiles({ "file.txt": "original" }, "base");
      const base = await getFullSha(git, "HEAD", { cwd: repo.path });

      const shaA = await repo.commitFiles({ "file.txt": "version A" }, "change A");
      await git.run(["checkout", base], { cwd: repo.path });
      const shaB = await repo.commitFiles({ "file.txt": "version B" }, "change B");

      const result = await predictConflict(git, shaA, shaB, base, { cwd: repo.path });
      expect(result.status).toBe("conflict");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("checkReorderConflicts", () => {
  test("returns empty map when order unchanged", async () => {
    const repo = await createRepo();
    try {
      await repo.branch("feature");
      const base = await getFullSha(git, "HEAD", { cwd: repo.path });
      const sha1 = await repo.commitFiles({ "a.txt": "a" }, "a");
      const sha2 = await repo.commitFiles({ "b.txt": "b" }, "b");

      const order = [sha1, sha2];
      const conflicts = await checkReorderConflicts(git, order, order, base, { cwd: repo.path });
      expect(conflicts.size).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("detects conflict when reordering commits that touch same file", async () => {
    const repo = await createRepo();
    try {
      await repo.commitFiles({ "file.txt": "original" }, "base");
      const base = await getFullSha(git, "HEAD", { cwd: repo.path });
      const sha1 = await repo.commitFiles({ "file.txt": "version 1" }, "v1");
      const sha2 = await repo.commitFiles({ "file.txt": "version 2" }, "v2");

      const currentOrder = [sha1, sha2];
      const newOrder = [sha2, sha1]; // Reversed

      const conflicts = await checkReorderConflicts(git, currentOrder, newOrder, base, { cwd: repo.path });
      expect(conflicts.size).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/conflict.test.ts`
Expected: FAIL — functions not exported

**Step 3: Write minimal implementation**

Add to `src/git/conflict.ts`:

```ts
import { mergeTree } from "./plumbing.ts";

export async function simulateMerge(
  git: GitRunner,
  base: string,
  commitA: string,
  commitB: string,
  overlappingFiles: string[],
  options?: ConflictOptions,
): Promise<ConflictResult> {
  const result = await mergeTree(git, base, commitA, commitB, options);

  if (!result.ok) {
    const { files } = parseConflictOutput(result.conflictInfo);
    return {
      status: "conflict",
      files: files.length > 0 ? files : overlappingFiles,
    };
  }

  if (overlappingFiles.length > 0) {
    return { status: "warning", files: overlappingFiles };
  }

  return { status: "clean" };
}

export async function predictConflict(
  git: GitRunner,
  commitA: string,
  commitB: string,
  mergeBase: string,
  options?: ConflictOptions,
): Promise<ConflictResult> {
  const overlapping = await checkFileOverlap(git, commitA, commitB, options);
  if (overlapping.length === 0) {
    return { status: "clean" };
  }
  return simulateMerge(git, mergeBase, commitA, commitB, overlapping, options);
}

export async function checkReorderConflicts(
  git: GitRunner,
  currentOrder: string[],
  newOrder: string[],
  mergeBase: string,
  options?: ConflictOptions,
): Promise<Map<string, ConflictResult>> {
  const conflicts = new Map<string, ConflictResult>();

  for (let i = 0; i < newOrder.length; i++) {
    for (let j = i + 1; j < newOrder.length; j++) {
      const commitI = newOrder[i]!;
      const commitJ = newOrder[j]!;

      const origPosI = currentOrder.indexOf(commitI);
      const origPosJ = currentOrder.indexOf(commitJ);

      if (origPosI !== -1 && origPosJ !== -1 && origPosI > origPosJ) {
        const result = await predictConflict(git, commitI, commitJ, mergeBase, options);
        if (result.status !== "clean") {
          conflicts.set(`${commitI}:${commitJ}`, result);
        }
      }
    }
  }

  return conflicts;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/conflict.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/conflict.ts tests/git/conflict.test.ts
git commit -m "feat(git): add merge simulation and conflict prediction"
```

---

## Task 16: Rebase — `injectMissingIds`

**Files:**
- Create: `src/git/rebase.ts`
- Create: `tests/git/rebase.test.ts`

**Step 1: Write the failing test**

```ts
// tests/git/rebase.test.ts
import { test, expect, describe } from "bun:test";
import { injectMissingIds } from "../../src/git/rebase.ts";
import { createRealGitRunner, createRepo } from "../../tests/lib/index.ts";
import { getStackCommits, getFullSha, getCommitMessage } from "../../src/git/queries.ts";
import { parseTrailers } from "../../src/parse/trailers.ts";

const git = createRealGitRunner();

describe("injectMissingIds", () => {
  test("injects IDs into commits missing Spry-Commit-Id", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      await repo.branch("feature");
      await repo.commit("first");
      await repo.commit("second");

      const result = await injectMissingIds(git, "origin/main", { cwd: repo.path });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modifiedCount).toBe(2);
        expect(result.rebasePerformed).toBe(true);
      }

      // Verify trailers were added
      const commits = await getStackCommits(git, "origin/main", { cwd: repo.path });
      for (const commit of commits) {
        const trailers = await parseTrailers(commit.body, git);
        expect(trailers["Spry-Commit-Id"]).toBeDefined();
        expect(trailers["Spry-Commit-Id"]!).toMatch(/^[a-f0-9]{8}$/);
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("returns modifiedCount=0 when all commits already have IDs", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      await repo.branch("feature");
      await repo.commit("first");

      // Inject once
      await injectMissingIds(git, "origin/main", { cwd: repo.path });

      // Inject again — should be no-op
      const result = await injectMissingIds(git, "origin/main", { cwd: repo.path });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modifiedCount).toBe(0);
        expect(result.rebasePerformed).toBe(false);
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("returns error for detached HEAD", async () => {
    const repo = await createRepo();
    try {
      const sha = await repo.commit("commit");
      await git.run(["checkout", sha], { cwd: repo.path });

      const result = await injectMissingIds(git, "origin/main", { cwd: repo.path });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("detached-head");
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("returns ok for empty stack", async () => {
    const repo = await createRepo();
    try {
      const result = await injectMissingIds(git, "origin/main", { cwd: repo.path });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.modifiedCount).toBe(0);
        expect(result.rebasePerformed).toBe(false);
      }
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/rebase.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/git/rebase.ts
import type { GitRunner } from "../../tests/lib/context.ts";
import { generateCommitId } from "../parse/id.ts";
import { parseTrailers, addTrailers } from "../parse/trailers.ts";
import {
  getCurrentBranch,
  isDetachedHead,
  getStackCommits,
  getCommitMessage,
  getFullSha,
} from "./queries.ts";
import { rewriteCommitChain, finalizeRewrite } from "./plumbing.ts";

export interface RebaseOptions {
  cwd?: string;
  branch?: string;
}

export type InjectIdsResult =
  | { ok: true; modifiedCount: number; rebasePerformed: boolean }
  | { ok: false; reason: "detached-head" };

export async function injectMissingIds(
  git: GitRunner,
  trunkRef: string,
  options?: RebaseOptions,
): Promise<InjectIdsResult> {
  const cwd = options?.cwd;

  if (await isDetachedHead(git, { cwd })) {
    return { ok: false, reason: "detached-head" };
  }

  const branch = await getCurrentBranch(git, { cwd });
  const commits = await getStackCommits(git, trunkRef, { cwd });

  if (commits.length === 0) {
    return { ok: true, modifiedCount: 0, rebasePerformed: false };
  }

  // Parse trailers for each commit to find which need IDs
  const needsId: string[] = [];
  for (const commit of commits) {
    const trailers = await parseTrailers(commit.body, git);
    if (!trailers["Spry-Commit-Id"]) {
      needsId.push(commit.hash);
    }
  }

  if (needsId.length === 0) {
    return { ok: true, modifiedCount: 0, rebasePerformed: false };
  }

  // Build rewrites map
  const rewrites = new Map<string, string>();
  for (const hash of needsId) {
    const newId = generateCommitId();
    const originalMessage = await getCommitMessage(git, hash, { cwd });
    const newMessage = await addTrailers(originalMessage, { "Spry-Commit-Id": newId }, git);
    rewrites.set(hash, newMessage);
  }

  const allHashes = commits.map((c) => c.hash);
  const oldTip = allHashes.at(-1)!;

  const result = await rewriteCommitChain(git, allHashes, rewrites, { cwd });
  await finalizeRewrite(git, branch, oldTip, result.newTip, { cwd });

  return { ok: true, modifiedCount: needsId.length, rebasePerformed: true };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/rebase.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/rebase.ts tests/git/rebase.test.ts
git commit -m "feat(git): add injectMissingIds rebase operation"
```

---

## Task 17: Rebase — `rebaseOntoTrunk`

**Files:**
- Modify: `src/git/rebase.ts`
- Modify: `tests/git/rebase.test.ts`

**Step 1: Write the failing tests**

Append to `tests/git/rebase.test.ts`:

```ts
import { rebaseOntoTrunk } from "../../src/git/rebase.ts";
import type { RebaseResult } from "../../src/git/rebase.ts";
import { loadConfig, trunkRef } from "../../src/git/config.ts";

describe("rebaseOntoTrunk", () => {
  test("rebases stack onto updated trunk", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      // Create feature branch
      await repo.branch("feature");
      await repo.commit("feature work");

      // Simulate trunk advancing: add commit on main, push it
      await repo.checkout("main");
      await repo.commit("main advance");
      await git.run(["push", "origin", "main"], { cwd: repo.path });

      // Go back to feature
      const branchName = await repo.currentBranch();
      // Need to find the feature branch — checkout the feature branch
      // Actually, we need the branch name from repo.branch()
      // Let's restructure:
    } finally {
      await repo.cleanup();
    }
  });
});
```

Actually, let me restructure this test more carefully:

```ts
import { rebaseOntoTrunk } from "../../src/git/rebase.ts";
import type { RebaseResult } from "../../src/git/rebase.ts";

describe("rebaseOntoTrunk", () => {
  test("rebases stack onto updated trunk", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      // Create feature from initial main
      const featureBranch = await repo.branch("feature");
      await repo.commit("feature work");

      // Advance main and push
      await repo.checkout("main");
      await repo.commit("main advance");
      await git.run(["push", "origin", "main"], { cwd: repo.path });
      await repo.fetch();

      // Back to feature
      await repo.checkout(featureBranch);

      const config = { trunk: "main", remote: "origin" };
      const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.commitCount).toBe(1);
        expect(result.newTip).toMatch(/^[a-f0-9]{40}$/);
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("returns ok with commitCount 0 for empty stack", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      const config = { trunk: "main", remote: "origin" };
      const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.commitCount).toBe(0);
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("returns error for detached HEAD", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      const sha = await repo.commit("commit");
      await git.run(["checkout", sha], { cwd: repo.path });

      const config = { trunk: "main", remote: "origin" };
      const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("detached-head");
      }
    } finally {
      await repo.cleanup();
    }
  });

  test("detects conflict during rebase", async () => {
    const repo = await createRepo();
    try {
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      // Create file on feature
      const featureBranch = await repo.branch("feature");
      await repo.commitFiles({ "conflict.txt": "feature version" }, "feature");

      // Create conflicting file on main
      await repo.checkout("main");
      await repo.commitFiles({ "conflict.txt": "main version" }, "main conflict");
      await git.run(["push", "origin", "main"], { cwd: repo.path });
      await repo.fetch();

      await repo.checkout(featureBranch);

      const config = { trunk: "main", remote: "origin" };
      const result = await rebaseOntoTrunk(git, config, { cwd: repo.path });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("conflict");
      }
    } finally {
      await repo.cleanup();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/rebase.test.ts`
Expected: FAIL — rebaseOntoTrunk not exported

**Step 3: Write minimal implementation**

Add to `src/git/rebase.ts`:

```ts
import type { SpryConfig } from "./config.ts";
import { trunkRef } from "./config.ts";
import { getStackCommits } from "./queries.ts";
import { rebasePlumbing } from "./plumbing.ts";

export type RebaseResult =
  | { ok: true; commitCount: number; newTip: string }
  | { ok: false; reason: "detached-head" | "conflict"; conflictFile?: string };

export async function rebaseOntoTrunk(
  git: GitRunner,
  config: SpryConfig,
  options?: RebaseOptions,
): Promise<RebaseResult> {
  const cwd = options?.cwd;

  if (await isDetachedHead(git, { cwd })) {
    return { ok: false, reason: "detached-head" };
  }

  const ref = trunkRef(config);
  const commits = await getStackCommits(git, ref, { cwd });
  const commitCount = commits.length;

  if (commitCount === 0) {
    const currentTip = await getFullSha(git, "HEAD", { cwd });
    return { ok: true, commitCount: 0, newTip: currentTip };
  }

  const ontoSha = await getFullSha(git, ref, { cwd });
  const commitHashes = commits.map((c) => c.hash);

  const result = await rebasePlumbing(git, ontoSha, commitHashes, { cwd });

  if (!result.ok) {
    const { files } = parseConflictOutputImported(result.conflictInfo);
    return { ok: false, reason: "conflict", conflictFile: files[0] };
  }

  const branch = await getCurrentBranch(git, { cwd });
  const oldTip = commitHashes.at(-1)!;
  await finalizeRewrite(git, branch, oldTip, result.newTip, { cwd });

  return { ok: true, commitCount, newTip: result.newTip };
}
```

Note: add the import for `parseConflictOutput` from `./conflict.ts`:

```ts
import { parseConflictOutput as parseConflictOutputImported } from "./conflict.ts";
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/rebase.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/rebase.ts tests/git/rebase.test.ts
git commit -m "feat(git): add rebaseOntoTrunk operation"
```

---

## Task 18: Rebase — `getConflictInfo`, `formatConflictError`

**Files:**
- Modify: `src/git/rebase.ts`
- Modify: `tests/git/rebase.test.ts`

**Step 1: Write the failing tests**

Append to `tests/git/rebase.test.ts`:

```ts
import { getConflictInfo, formatConflictError } from "../../src/git/rebase.ts";
import type { ConflictInfo } from "../../src/git/rebase.ts";

describe("getConflictInfo", () => {
  test("returns null when not in a rebase", async () => {
    const repo = await createRepo();
    try {
      const info = await getConflictInfo(git, { cwd: repo.path });
      expect(info).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });
});

describe("formatConflictError", () => {
  test("formats conflict info into readable message", () => {
    const info: ConflictInfo = {
      files: ["src/main.ts", "src/util.ts"],
      currentCommit: "abc12345",
      currentSubject: "Add feature X",
    };
    const message = formatConflictError(info);
    expect(message).toContain("abc12345");
    expect(message).toContain("Add feature X");
    expect(message).toContain("src/main.ts");
    expect(message).toContain("src/util.ts");
    expect(message).toContain("rebase --continue");
    expect(message).toContain("rebase --abort");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/git/rebase.test.ts`
Expected: FAIL — functions not exported

**Step 3: Write minimal implementation**

Add to `src/git/rebase.ts`:

```ts
import { join } from "node:path";
import { stat } from "node:fs/promises";

export interface ConflictInfo {
  files: string[];
  currentCommit: string;
  currentSubject: string;
}

export async function getConflictInfo(
  git: GitRunner,
  options?: RebaseOptions,
): Promise<ConflictInfo | null> {
  const cwd = options?.cwd;

  // Check for rebase-merge or rebase-apply directory
  const rebaseMergeResult = await git.run(["rev-parse", "--git-path", "rebase-merge"], { cwd });
  const rebaseApplyResult = await git.run(["rev-parse", "--git-path", "rebase-apply"], { cwd });

  const rebaseMergePath = cwd
    ? join(cwd, rebaseMergeResult.stdout.trim())
    : rebaseMergeResult.stdout.trim();
  const rebaseApplyPath = cwd
    ? join(cwd, rebaseApplyResult.stdout.trim())
    : rebaseApplyResult.stdout.trim();

  let inRebase = false;
  try { await stat(rebaseMergePath); inRebase = true; } catch {}
  if (!inRebase) {
    try { await stat(rebaseApplyPath); inRebase = true; } catch {}
  }

  if (!inRebase) return null;

  // Get conflicting files
  const statusResult = await git.run(["status", "--porcelain"], { cwd });
  const conflicts = statusResult.stdout
    .split("\n")
    .filter((line) => /^(?:UU|AA|DD|AU|UA|DU|UD) /.test(line))
    .map((line) => line.slice(3));

  // Get the commit being applied
  const rebaseHeadResult = await git.run(["rev-parse", "REBASE_HEAD"], { cwd });
  let currentCommit = "unknown";
  let currentSubject = "unknown";

  if (rebaseHeadResult.exitCode === 0) {
    currentCommit = rebaseHeadResult.stdout.trim().slice(0, 8);
    const subjectResult = await git.run(["log", "-1", "--format=%s", "REBASE_HEAD"], { cwd });
    currentSubject = subjectResult.stdout.trim();
  }

  return { files: conflicts, currentCommit, currentSubject };
}

export function formatConflictError(info: ConflictInfo): string {
  const fileList = info.files.map((f) => `  - ${f}`).join("\n");

  return (
    `Rebase conflict while applying commit ${info.currentCommit}\n` +
    `  "${info.currentSubject}"\n\n` +
    `Conflicting files:\n${fileList}\n\n` +
    `To resolve:\n` +
    `  1. Edit the conflicting files\n` +
    `  2. git add <fixed files>\n` +
    `  3. git rebase --continue\n` +
    `  4. sp sync\n\n` +
    `To abort:\n` +
    `  git rebase --abort`
  );
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/git/rebase.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/rebase.ts tests/git/rebase.test.ts
git commit -m "feat(git): add getConflictInfo and formatConflictError"
```

---

## Task 19: Barrel export — `src/git/index.ts`

**Files:**
- Create: `src/git/index.ts`

**Step 1: Write the barrel export**

```ts
// src/git/index.ts
export type { SpryConfig, ConfigOptions } from "./config.ts";
export { trunkRef, checkGitVersion, readConfig, loadConfig } from "./config.ts";

export type { QueryOptions } from "./queries.ts";
export {
  getCurrentBranch,
  isDetachedHead,
  hasUncommittedChanges,
  getFullSha,
  getShortSha,
  getCommitMessage,
  getMergeBase,
  getStackCommits,
  getStackCommitsForBranch,
} from "./queries.ts";

export type {
  PlumbingOptions,
  MergeTreeResult,
  ChainRewriteResult,
  PlumbingRebaseResult,
} from "./plumbing.ts";
export {
  getTree,
  getParent,
  getParents,
  getAuthorEnv,
  getAuthorAndCommitterEnv,
  createCommit,
  mergeTree,
  updateRef,
  resetToCommit,
  rewriteCommitChain,
  rebasePlumbing,
  finalizeRewrite,
} from "./plumbing.ts";

export type { StatusOptions, WorkingTreeStatus } from "./status.ts";
export { getWorkingTreeStatus, requireCleanWorkingTree } from "./status.ts";

export type { ConflictOptions, ConflictResult } from "./conflict.ts";
export {
  getCommitFiles,
  checkFileOverlap,
  parseConflictOutput,
  simulateMerge,
  predictConflict,
  checkReorderConflicts,
} from "./conflict.ts";

export type { RebaseOptions, InjectIdsResult, RebaseResult, ConflictInfo } from "./rebase.ts";
export {
  injectMissingIds,
  rebaseOntoTrunk,
  getConflictInfo,
  formatConflictError,
} from "./rebase.ts";
```

**Step 2: Run all tests to verify nothing broke**

Run: `bun test`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add src/git/index.ts
git commit -m "feat(git): add barrel export for git module"
```

---

## Task 20: Full integration test + changelog

**Files:**
- Modify: `CHANGELOG.md`

**Step 1: Run the full test suite**

Run: `bun test`
Expected: All tests PASS (132 existing + new git tests)

**Step 2: Run lint and type check**

Run: `bun run check`
Expected: PASS

**Step 3: Update CHANGELOG.md**

Add under `## [Unreleased]`:

```markdown
### Added
- Git operations module (`src/git/`) with explicit config, queries, plumbing, rebase, conflict prediction, and status
- Explicit `spry.trunk` and `spry.remote` config (no auto-detection)
- Git version check (requires 2.40+) at config load
```

**Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "chore: update changelog for git operations module"
```

**Step 5: Run `bd sync`**

```bash
bd sync
```
