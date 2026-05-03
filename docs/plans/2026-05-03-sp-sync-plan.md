# sp sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `sp sync` as the first writer in the rebuild — bare sync pushes existing branches and retargets PRs whose base ref doesn't match the local stack; `--open <ids>` creates PRs for selected single-commit units; `--open` boolean drops into a multi-select TUI.

**Architecture:** Build foundations bottom-up: pure git push helpers, pure body/title formatters, gh write ops (createPR/retargetPR), the TUI selector, then the orchestrating `syncCommand`. Trailer injection (existing `injectMissingIds`) runs first; bare sync uses `git ls-remote` (no gh) to decide what to push, then runs gh enrichment for retargeting and falls back gracefully if gh is unavailable. Groups, body updates, auto-rebase, and merged-PR cleanup are out of scope — see [design doc](2026-05-03-sp-sync-design.md).

**Tech Stack:** Bun, TypeScript, Commander, kleur, `gh` CLI (graphql + pr edit/create), Bun's test runner, `TerminalDriver` PTY infrastructure (Phase 1).

**Design reference:** [docs/plans/2026-05-03-sp-sync-design.md](2026-05-03-sp-sync-design.md)

**Important notes:**

- This machine has an old git version. Run all tests via `bun run test:docker`. Use `bun run test:local:docker` for `*.doc.test.ts` per project convention.
- Each task ends with a commit. No `--no-verify`. CHANGELOG only updated in the final task.
- Doc-fragment scrub: every `docTest` that creates a repo MUST call `doc.scrub(repo)` immediately after `repos.push(repo)`.
- `createPR` and `retargetPR` cassettes are NOT part of this step — write tests use stub `GhClient`s. Cassettes can be added later if a real-fixture test reveals a stub mismatch.
- Trailer injection rewrites SHAs. After it runs, the unit list reflects the new SHAs; branch names (keyed on unit IDs) are unchanged.

---

## Task 1: `pushBranch` and `listRemoteBranches` in `src/gh/push.ts`

**Files:**

- Create: `src/gh/push.ts`
- Create: `tests/gh/push.test.ts`
- Modify: `src/gh/index.ts` (re-exports)

**Step 1: Write the failing tests**

Create [tests/gh/push.test.ts](tests/gh/push.test.ts):

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { pushBranch, listRemoteBranches } from "../../src/gh/push.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const repos: TestRepo[] = [];

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

describe("pushBranch", () => {
  test("pushes a commit to a new remote ref", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha = await repo.commit("Work");

    const result = await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    expect(result.ok).toBe(true);

    const ls = await git.run(
      ["ls-remote", "--heads", "origin", "spry/test/aaa11111"],
      { cwd: repo.path },
    );
    expect(ls.stdout).toContain("spry/test/aaa11111");
  });

  test("force-with-lease succeeds when local has the latest remote tip", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha1 = await repo.commit("v1");
    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha: sha1,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    const sha2 = await repo.commit("v2");
    const result = await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha: sha2,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    expect(result.ok).toBe(true);
  });

  test("force-with-lease rejects when remote diverged", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha1 = await repo.commit("v1");
    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha: sha1,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });

    // Simulate someone else pushing — write directly to bare repo's ref
    const otherSha = (
      await git.run(["rev-parse", "HEAD~1"], { cwd: repo.path })
    ).stdout.trim();
    await git.run(
      ["update-ref", "refs/heads/spry/test/aaa11111", otherSha],
      { cwd: repo.originPath },
    );

    const sha2 = await repo.commit("v2");
    const result = await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha: sha2,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stale-ref");
    }
  });
});

describe("listRemoteBranches", () => {
  test("returns only branches under the given prefix", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    await repo.branch("feature");
    const sha = await repo.commit("Work");

    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "spry/test/aaa11111",
      forceWithLease: true,
    });
    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "spry/test/bbb22222",
      forceWithLease: true,
    });
    await pushBranch(git, {
      cwd: repo.path,
      remote: "origin",
      sha,
      branch: "other/zzz",
      forceWithLease: true,
    });

    const set = await listRemoteBranches(git, "origin", "spry/test", { cwd: repo.path });
    expect(set.has("spry/test/aaa11111")).toBe(true);
    expect(set.has("spry/test/bbb22222")).toBe(true);
    expect(set.has("other/zzz")).toBe(false);
  });

  test("returns empty set when no matching branches exist", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    const set = await listRemoteBranches(git, "origin", "spry/nope", { cwd: repo.path });
    expect(set.size).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker tests/gh/push.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement `pushBranch` and `listRemoteBranches`**

Create [src/gh/push.ts](src/gh/push.ts):

```ts
import type { GitRunner } from "../lib/context.ts";

export interface PushOptions {
  cwd?: string;
  remote: string;
  sha: string;
  branch: string;
  forceWithLease: boolean;
}

export type PushResult =
  | { ok: true }
  | { ok: false; reason: "rejected" | "stale-ref"; stderr: string };

const STALE_REF_PATTERNS = [
  /stale info/i,
  /rejected.*non-fast-forward/i,
  /failed to push some refs/i,
];

export async function pushBranch(
  git: GitRunner,
  opts: PushOptions,
): Promise<PushResult> {
  const refspec = `${opts.sha}:refs/heads/${opts.branch}`;
  const args = ["push", opts.remote, refspec];
  if (opts.forceWithLease) args.push("--force-with-lease");
  const result = await git.run(args, { cwd: opts.cwd });
  if (result.exitCode === 0) return { ok: true };
  const stderr = result.stderr;
  if (STALE_REF_PATTERNS.some((p) => p.test(stderr))) {
    return { ok: false, reason: "stale-ref", stderr };
  }
  return { ok: false, reason: "rejected", stderr };
}

export async function listRemoteBranches(
  git: GitRunner,
  remote: string,
  prefix: string,
  opts?: { cwd?: string },
): Promise<Set<string>> {
  const result = await git.run(
    ["ls-remote", "--heads", remote, `${prefix}/*`],
    { cwd: opts?.cwd },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ls-remote failed: ${result.stderr.trim()}`);
  }
  const set = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const ref = trimmed.slice(tab + 1);
    if (ref.startsWith("refs/heads/")) {
      set.add(ref.slice("refs/heads/".length));
    }
  }
  return set;
}
```

Add to [src/gh/index.ts](src/gh/index.ts):

```ts
export { pushBranch, listRemoteBranches } from "./push.ts";
export type { PushOptions, PushResult } from "./push.ts";
```

**Step 4: Run tests to verify they pass**

```bash
bun run test:docker tests/gh/push.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/gh/push.ts src/gh/index.ts tests/gh/push.test.ts
git commit -m "feat(gh): add pushBranch and listRemoteBranches helpers"
```

---

## Task 2: `pr-body.ts` — pure formatters

**Files:**

- Create: `src/gh/pr-body.ts`
- Create: `tests/gh/pr-body.test.ts`
- Modify: `src/gh/index.ts` (re-exports)

**Step 1: Write the failing tests**

Create [tests/gh/pr-body.test.ts](tests/gh/pr-body.test.ts):

```ts
import { describe, test, expect } from "bun:test";
import { formatPRTitle, formatPRBody, stripTrailers } from "../../src/gh/pr-body.ts";
import type { CommitInfo, PRUnit } from "../../src/parse/types.ts";

function commit(hash: string, subject: string, body: string): CommitInfo {
  return { hash, subject, body, trailers: {} };
}

function singleUnit(id: string, hash: string, subject: string): PRUnit {
  return {
    type: "single",
    id,
    title: subject,
    commitIds: [id],
    commits: [hash],
    subjects: [subject],
  };
}

describe("stripTrailers", () => {
  test("returns body unchanged when there are no trailers", () => {
    expect(stripTrailers("Just prose.\nMore prose.")).toBe("Just prose.\nMore prose.");
  });

  test("strips a contiguous trailer block at the end", () => {
    const body = "Prose paragraph.\n\nSpry-Commit-Id: aaa11111\nCo-Authored-By: A <a@x>";
    expect(stripTrailers(body)).toBe("Prose paragraph.");
  });

  test("strips ALL trailer types (Spry, Co-Authored-By, Signed-off-by)", () => {
    const body =
      "Description.\n\nSigned-off-by: B <b@x>\nCo-Authored-By: A <a@x>\nSpry-Commit-Id: aaa11111";
    expect(stripTrailers(body)).toBe("Description.");
  });

  test("returns empty string when body is only trailers", () => {
    const body = "Spry-Commit-Id: aaa11111\nCo-Authored-By: A <a@x>";
    expect(stripTrailers(body)).toBe("");
  });

  test("does not strip a line that looks like a trailer but is not at the end", () => {
    const body = "Discussion: see ticket #1\n\nThis paragraph follows.";
    expect(stripTrailers(body)).toBe("Discussion: see ticket #1\n\nThis paragraph follows.");
  });

  test("requires a blank line before the trailer block", () => {
    const body = "Prose ends here.\nSpry-Commit-Id: aaa11111";
    // No blank line → not a real trailer block; keep as-is (sans trailing whitespace)
    expect(stripTrailers(body)).toBe("Prose ends here.\nSpry-Commit-Id: aaa11111");
  });

  test("trims trailing blank lines", () => {
    expect(stripTrailers("Prose.\n\n\n")).toBe("Prose.");
  });
});

describe("formatPRTitle", () => {
  test("returns commit subject for a single unit", () => {
    const unit = singleUnit("aaa11111", "abc", "Add login page");
    const commits = [commit("abc", "Add login page", "")];
    expect(formatPRTitle(unit, commits)).toBe("Add login page");
  });

  test("falls back to unit.title when commit not found in list", () => {
    const unit = singleUnit("aaa11111", "missing", "Cached title");
    expect(formatPRTitle(unit, [])).toBe("Cached title");
  });
});

describe("formatPRBody", () => {
  test("returns commit prose with trailers stripped", () => {
    const unit = singleUnit("aaa11111", "abc", "Add login page");
    const commits = [
      commit(
        "abc",
        "Add login page",
        "Implements OAuth via the platform SDK.\n\nSpry-Commit-Id: aaa11111",
      ),
    ];
    expect(formatPRBody(unit, commits)).toBe("Implements OAuth via the platform SDK.");
  });

  test("returns empty string when commit has no body", () => {
    const unit = singleUnit("aaa11111", "abc", "Subject");
    const commits = [commit("abc", "Subject", "")];
    expect(formatPRBody(unit, commits)).toBe("");
  });

  test("throws for groups (not supported in Step 6)", () => {
    const groupUnit: PRUnit = {
      type: "group",
      id: "grp1",
      title: "G",
      commitIds: ["a", "b"],
      commits: ["aaa", "bbb"],
      subjects: ["A", "B"],
    };
    expect(() => formatPRBody(groupUnit, [])).toThrow(/groups not supported/i);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker tests/gh/pr-body.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement**

Create [src/gh/pr-body.ts](src/gh/pr-body.ts):

```ts
import type { CommitInfo, PRUnit } from "../parse/types.ts";

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*\s*:\s.+$/;

export function stripTrailers(body: string): string {
  const lines = body.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;

  let trailerStart = end;
  while (trailerStart > 0 && TRAILER_LINE.test(lines[trailerStart - 1]!)) {
    trailerStart--;
  }
  if (trailerStart === end) {
    return lines.slice(0, end).join("\n");
  }
  if (trailerStart > 0 && lines[trailerStart - 1]!.trim() !== "") {
    return lines.slice(0, end).join("\n");
  }
  let prose = trailerStart;
  while (prose > 0 && lines[prose - 1]!.trim() === "") prose--;
  return lines.slice(0, prose).join("\n");
}

export function formatPRTitle(unit: PRUnit, commits: CommitInfo[]): string {
  if (unit.type === "single") {
    const commit = commits.find((c) => c.hash === unit.commits[0]);
    return commit?.subject ?? unit.title ?? "Untitled";
  }
  return unit.title ?? "Untitled group";
}

export function formatPRBody(unit: PRUnit, commits: CommitInfo[]): string {
  if (unit.type !== "single") {
    throw new Error("formatPRBody: groups not supported in Step 6");
  }
  const commit = commits.find((c) => c.hash === unit.commits[0]);
  if (!commit) return "";
  return stripTrailers(commit.body);
}
```

Add to [src/gh/index.ts](src/gh/index.ts):

```ts
export { formatPRTitle, formatPRBody, stripTrailers } from "./pr-body.ts";
```

**Step 4: Run tests to verify they pass**

```bash
bun run test:docker tests/gh/pr-body.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/gh/pr-body.ts src/gh/index.ts tests/gh/pr-body.test.ts
git commit -m "feat(gh): add pure pr-body formatters"
```

---

## Task 3: `createPR` and `retargetPR` (gh writes)

**Files:**

- Modify: `src/gh/pr.ts` (add write ops)
- Create: `tests/gh/pr-write.test.ts`
- Modify: `src/gh/index.ts` (re-exports)

**Step 1: Write the failing tests**

Create [tests/gh/pr-write.test.ts](tests/gh/pr-write.test.ts):

```ts
import { describe, test, expect } from "bun:test";
import { createPR, retargetPR } from "../../src/gh/pr.ts";
import { GhAuthError, GhNotInstalledError } from "../../src/gh/errors.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  GitRunner,
  SpryContext,
} from "../../src/lib/context.ts";

interface Call {
  args: string[];
  stdin?: string;
  cwd?: string;
}

function makeCtx(responses: CommandResult[]): { ctx: SpryContext; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const gh: GhClient = {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      calls.push({ args, stdin: options?.stdin, cwd: options?.cwd });
      const r = responses[i++];
      if (!r) throw new Error("stub gh: no more responses");
      return r;
    },
  };
  const git: GitRunner = {
    async run() {
      throw new Error("createPR/retargetPR should not call git");
    },
  };
  return { ctx: { git, gh }, calls };
}

describe("createPR", () => {
  test("returns parsed PR number and url on success", async () => {
    const { ctx, calls } = makeCtx([
      { stdout: "https://github.com/owner/repo/pull/42\n", stderr: "", exitCode: 0 },
    ]);

    const result = await createPR(ctx, {
      title: "Add login",
      head: "spry/test/aaa",
      base: "main",
      body: "Body content",
    });
    expect(result).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "pr",
      "create",
      "--title",
      "Add login",
      "--head",
      "spry/test/aaa",
      "--base",
      "main",
      "--body-file",
      "-",
    ]);
    expect(calls[0]!.stdin).toBe("Body content");
  });

  test("retries on transient stderr, succeeds on second attempt", async () => {
    const { ctx, calls } = makeCtx([
      { stdout: "", stderr: "HTTP 503: Service Unavailable", exitCode: 1 },
      { stdout: "https://github.com/owner/repo/pull/7\n", stderr: "", exitCode: 0 },
    ]);
    const result = await createPR(ctx, {
      title: "T",
      head: "h",
      base: "b",
      body: "",
    });
    expect(result.number).toBe(7);
    expect(calls).toHaveLength(2);
  });

  test("throws GhAuthError when stderr indicates auth failure", async () => {
    const { ctx } = makeCtx([
      { stdout: "", stderr: "You are not logged into any GitHub hosts.", exitCode: 4 },
    ]);
    await expect(
      createPR(ctx, { title: "T", head: "h", base: "b", body: "" }),
    ).rejects.toBeInstanceOf(GhAuthError);
  });

  test("throws GhNotInstalledError when gh is missing", async () => {
    const { ctx } = makeCtx([
      { stdout: "", stderr: "/bin/sh: gh: command not found", exitCode: 127 },
    ]);
    await expect(
      createPR(ctx, { title: "T", head: "h", base: "b", body: "" }),
    ).rejects.toBeInstanceOf(GhNotInstalledError);
  });

  test("throws plain Error after retry exhaustion on transient failures", async () => {
    const transient: CommandResult = {
      stdout: "",
      stderr: "HTTP 503: Service Unavailable",
      exitCode: 1,
    };
    const { ctx } = makeCtx([transient, transient, transient]);
    await expect(
      createPR(ctx, { title: "T", head: "h", base: "b", body: "" }),
    ).rejects.toThrow(/gh failed/);
  });

  test("does not retry on non-transient failures", async () => {
    const { ctx, calls } = makeCtx([
      { stdout: "", stderr: "validation error: branch already has open PR", exitCode: 1 },
    ]);
    await expect(
      createPR(ctx, { title: "T", head: "h", base: "b", body: "" }),
    ).rejects.toThrow(/gh failed/);
    expect(calls).toHaveLength(1);
  });
});

describe("retargetPR", () => {
  test("calls gh pr edit <number> --base <newBase>", async () => {
    const { ctx, calls } = makeCtx([{ stdout: "", stderr: "", exitCode: 0 }]);
    await retargetPR(ctx, 123, "spry/test/aaa");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "pr",
      "edit",
      "123",
      "--base",
      "spry/test/aaa",
    ]);
  });

  test("retries on transient failures", async () => {
    const { ctx, calls } = makeCtx([
      { stdout: "", stderr: "HTTP 502: Bad Gateway", exitCode: 1 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);
    await retargetPR(ctx, 1, "main");
    expect(calls).toHaveLength(2);
  });

  test("throws on auth failure", async () => {
    const { ctx } = makeCtx([
      { stdout: "", stderr: "authentication required", exitCode: 4 },
    ]);
    await expect(retargetPR(ctx, 1, "main")).rejects.toBeInstanceOf(GhAuthError);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker tests/gh/pr-write.test.ts
```

Expected: FAIL — `createPR` / `retargetPR` not exported.

**Step 3: Add `createPR` and `retargetPR` to `src/gh/pr.ts`**

Append to [src/gh/pr.ts](src/gh/pr.ts) (after the existing `findPRsForBranches`):

```ts
export interface CreatePRParams {
  title: string;
  head: string;
  base: string;
  body: string;
}

export interface CreatePRResult {
  number: number;
  url: string;
}

export interface CreatePROptions {
  cwd?: string;
}

const PR_URL_PATTERN = /https:\/\/[^\s]+\/pull\/(\d+)/;

export async function createPR(
  ctx: SpryContext,
  params: CreatePRParams,
  options?: CreatePROptions,
): Promise<CreatePRResult> {
  const args = [
    "pr",
    "create",
    "--title",
    params.title,
    "--head",
    params.head,
    "--base",
    params.base,
    "--body-file",
    "-",
  ];
  const result = await withRetry(
    () => ctx.gh.run(args, { cwd: options?.cwd, stdin: params.body }),
    (r) => {
      if (r.exitCode === 0) return false;
      if (classifyError(r.stderr) !== "other") return false;
      return isTransientFailure(r);
    },
  );
  if (result.exitCode !== 0) throwForFailure(result);
  const url = result.stdout.trim().split("\n").pop() ?? "";
  const match = url.match(PR_URL_PATTERN);
  if (!match) {
    throw new Error(`createPR: could not parse PR URL from gh output: ${result.stdout}`);
  }
  return { number: Number(match[1]), url };
}

export async function retargetPR(
  ctx: SpryContext,
  prNumber: number,
  newBase: string,
  options?: { cwd?: string },
): Promise<void> {
  const args = ["pr", "edit", String(prNumber), "--base", newBase];
  const result = await withRetry(
    () => ctx.gh.run(args, { cwd: options?.cwd }),
    (r) => {
      if (r.exitCode === 0) return false;
      if (classifyError(r.stderr) !== "other") return false;
      return isTransientFailure(r);
    },
  );
  if (result.exitCode !== 0) throwForFailure(result);
}
```

Note: `CommandOptions` already includes `stdin?: string`. The existing `createRealGhClient` passes args but doesn't yet pass stdin — confirm by reading [src/lib/context.ts](src/lib/context.ts):

If `createRealGhClient` doesn't pipe stdin, extend it to match `createRealGitRunner`'s pattern:

```ts
export function createRealGhClient(): GhClient {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const input = options?.stdin ? Buffer.from(options.stdin) : undefined;
      let proc = input
        ? $`gh ${args} < ${input}`.nothrow().quiet()
        : $`gh ${args}`.nothrow().quiet();
      if (options?.cwd) proc = proc.cwd(options.cwd);
      if (options?.env) proc = proc.env(options.env);
      const result = await proc;
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      };
    },
  };
}
```

Add to [src/gh/index.ts](src/gh/index.ts):

```ts
export { createPR, retargetPR } from "./pr.ts";
export type { CreatePRParams, CreatePRResult, CreatePROptions } from "./pr.ts";
```

**Step 4: Run tests to verify they pass**

```bash
bun run test:docker tests/gh/pr-write.test.ts
```

Expected: PASS.

**Step 5: Run full gh suite to check for regressions**

```bash
bun run test:docker tests/gh/
```

Expected: all green.

**Step 6: Commit**

```bash
git add src/gh/pr.ts src/gh/index.ts src/lib/context.ts tests/gh/pr-write.test.ts
git commit -m "feat(gh): add createPR and retargetPR write operations"
```

---

## Task 4: TUI multi-select widget in `src/tui/select.ts`

**Files:**

- Create: `src/tui/select.ts`
- Create: `src/tui/index.ts`
- Create: `tests/tui/select.test.ts`

**Step 1: Write the failing tests**

Create a small driver-script approach so we can spawn the widget in a PTY. Create [src/tui/select-cli.ts](src/tui/select-cli.ts) (a tiny harness that the test spawns):

```ts
#!/usr/bin/env bun
// Test harness: reads JSON options from argv[2], runs selectUnits, writes
// JSON {cancelled, selectedIds} to stdout.
import { selectUnits } from "./select.ts";

const arg = process.argv[2] ?? "[]";
const options = JSON.parse(arg);
const result = await selectUnits(options);
process.stdout.write(JSON.stringify(result));
```

Create [tests/tui/select.test.ts](tests/tui/select.test.ts):

```ts
import { describe, test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { createTerminalDriver } from "../lib/index.ts";
import type { TerminalDriver } from "../lib/index.ts";

const harness = join(import.meta.dir, "../../src/tui/select-cli.ts");

const drivers: TerminalDriver[] = [];
afterAll(async () => {
  for (const d of drivers) await d.close().catch(() => {});
});

async function spawn(optionsJson: string): Promise<TerminalDriver> {
  const driver = await createTerminalDriver("bun", [harness, optionsJson], {
    cols: 80,
    rows: 24,
  });
  drivers.push(driver);
  return driver;
}

async function readResult(driver: TerminalDriver): Promise<{ cancelled: boolean; selectedIds: string[] }> {
  // After the widget closes, the harness writes the final JSON. We capture
  // it via `waitForText` on the trailing brace, then parse from the buffer.
  await driver.waitForText("}", { timeout: 5000 });
  const snap = driver.capture();
  const text = snap.text;
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(text.slice(start, end + 1));
}

describe("selectUnits", () => {
  test("Esc cancels", async () => {
    const driver = await spawn(
      JSON.stringify([{ id: "a", label: "Alpha" }, { id: "b", label: "Bravo" }]),
    );
    await driver.waitForText("Alpha");
    driver.press("Escape");
    const result = await readResult(driver);
    expect(result.cancelled).toBe(true);
    expect(result.selectedIds).toEqual([]);
  });

  test("Space then Enter selects the highlighted item", async () => {
    const driver = await spawn(
      JSON.stringify([{ id: "a", label: "Alpha" }, { id: "b", label: "Bravo" }]),
    );
    await driver.waitForText("Alpha");
    driver.press("Space");
    driver.press("Enter");
    const result = await readResult(driver);
    expect(result.cancelled).toBe(false);
    expect(result.selectedIds).toEqual(["a"]);
  });

  test("ArrowDown moves cursor; selects second item", async () => {
    const driver = await spawn(
      JSON.stringify([
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
        { id: "c", label: "Charlie" },
      ]),
    );
    await driver.waitForText("Charlie");
    driver.press("ArrowDown");
    driver.press("Space");
    driver.press("Enter");
    const result = await readResult(driver);
    expect(result.selectedIds).toEqual(["b"]);
  });

  test("'a' toggles all", async () => {
    const driver = await spawn(
      JSON.stringify([
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ]),
    );
    await driver.waitForText("Alpha");
    driver.type("a");
    driver.press("Enter");
    const result = await readResult(driver);
    expect(result.selectedIds).toEqual(["a", "b"]);
  });

  test("empty options → cancelled, no waiting", async () => {
    const driver = await spawn("[]");
    const result = await readResult(driver);
    expect(result.cancelled).toBe(true);
    expect(result.selectedIds).toEqual([]);
  });

  test("Ctrl+C cancels", async () => {
    const driver = await spawn(
      JSON.stringify([{ id: "a", label: "Alpha" }]),
    );
    await driver.waitForText("Alpha");
    driver.press("Ctrl+c");
    const result = await readResult(driver);
    expect(result.cancelled).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker tests/tui/select.test.ts
```

Expected: FAIL — modules not found.

**Step 3: Implement the selector**

Create [src/tui/select.ts](src/tui/select.ts):

```ts
import kleur from "kleur";

export interface SelectOption {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface SelectResult {
  cancelled: boolean;
  selectedIds: string[];
}

export interface SelectOptions {
  title?: string;
}

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;

export async function selectUnits(
  options: SelectOption[],
  opts: SelectOptions = {},
): Promise<SelectResult> {
  if (options.length === 0) {
    return { cancelled: true, selectedIds: [] };
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const selected = new Set<string>();
  let cursor = 0;

  function render(): void {
    const lines: string[] = [];
    lines.push(opts.title ?? "Select units to open (space toggle, a all, enter confirm, esc cancel):");
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      const isCursor = i === cursor;
      const isSelected = selected.has(opt.id);
      const box = isSelected ? "[x]" : "[ ]";
      const prefix = isCursor ? kleur.cyan("›") : " ";
      const label = opt.disabled ? kleur.dim(opt.label) : opt.label;
      const hint = opt.hint ? " " + kleur.dim(opt.hint) : "";
      lines.push(`${prefix} ${box} ${label}${hint}`);
    }
    stdout.write(CLEAR_SCREEN);
    stdout.write(lines.join("\n"));
  }

  function cleanup(): void {
    stdout.write(SHOW_CURSOR);
    stdout.write("\n");
    stdin.setRawMode?.(false);
    stdin.pause();
  }

  stdin.setRawMode?.(true);
  stdin.resume();
  stdout.write(HIDE_CURSOR);
  render();

  return new Promise<SelectResult>((resolve) => {
    function onData(chunk: Buffer): void {
      const key = chunk.toString();
      if (key === "\x03" || key === "\x1b") {
        // Ctrl+C or Esc
        stdin.off("data", onData);
        cleanup();
        resolve({ cancelled: true, selectedIds: [] });
        return;
      }
      if (key === "\r" || key === "\n") {
        stdin.off("data", onData);
        cleanup();
        resolve({
          cancelled: false,
          selectedIds: options.filter((o) => selected.has(o.id)).map((o) => o.id),
        });
        return;
      }
      if (key === " ") {
        const opt = options[cursor];
        if (opt && !opt.disabled) {
          if (selected.has(opt.id)) selected.delete(opt.id);
          else selected.add(opt.id);
        }
      } else if (key === "a") {
        const allSelected = options.every((o) => o.disabled || selected.has(o.id));
        if (allSelected) {
          selected.clear();
        } else {
          for (const o of options) if (!o.disabled) selected.add(o.id);
        }
      } else if (key === "\x1b[A") {
        cursor = (cursor - 1 + options.length) % options.length;
      } else if (key === "\x1b[B") {
        cursor = (cursor + 1) % options.length;
      }
      render();
    }

    stdin.on("data", onData);
  });
}
```

Create [src/tui/select-cli.ts](src/tui/select-cli.ts):

```ts
#!/usr/bin/env bun
import { selectUnits } from "./select.ts";

const arg = process.argv[2] ?? "[]";
const options = JSON.parse(arg);
const result = await selectUnits(options);
process.stdout.write(JSON.stringify(result));
```

Create [src/tui/index.ts](src/tui/index.ts):

```ts
export { selectUnits } from "./select.ts";
export type { SelectOption, SelectResult, SelectOptions } from "./select.ts";
```

**Step 4: Run tests to verify they pass**

```bash
bun run test:docker tests/tui/select.test.ts
```

Expected: PASS.

If a test flakes due to timing (the renderer writes async; key inputs can arrive before render), bump the `waitForText` timeout in the test's first assertion to 10000ms and re-run. If still flaky: add a tiny `await new Promise((r) => setTimeout(r, 50))` after each `driver.press(...)` call in the test, NOT in the implementation.

**Step 5: Commit**

```bash
git add src/tui/ tests/tui/
git commit -m "feat(tui): multi-select widget for sp sync --open"
```

---

## Task 5: `syncCommand` — bare-sync flow

**Files:**

- Create: `src/commands/sync.ts`
- Create: `tests/commands/sync.test.ts`

**Step 1: Write the failing tests** (bare sync only — no `--open` yet)

Create [tests/commands/sync.test.ts](tests/commands/sync.test.ts):

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { syncCommand } from "../../src/commands/sync.ts";
import {
  createRealGitRunner,
  createRepo,
} from "../lib/index.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  SpryContext,
  TestRepo,
} from "../lib/index.ts";

const repos: TestRepo[] = [];

afterEach(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

async function makeRepoWithConfig(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
  return repo;
}

interface StubGhCall {
  args: string[];
  stdin?: string;
}

function stubGh(handler: (call: StubGhCall) => CommandResult): { gh: GhClient; calls: StubGhCall[] } {
  const calls: StubGhCall[] = [];
  const gh: GhClient = {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const call = { args: [...args], stdin: options?.stdin };
      calls.push(call);
      return handler(call);
    },
  };
  return { gh, calls };
}

function makeCtx(repo: TestRepo, gh: GhClient): SpryContext {
  const realGit = createRealGitRunner();
  return {
    git: {
      run: (args, opts) => realGit.run(args, { ...opts, cwd: opts?.cwd ?? repo.path }),
    },
    gh,
  };
}

function captureLogs(): { restore: () => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  return {
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
    out,
    err,
  };
}

function ghPRMap(branchToPR: Record<string, { number: number; baseRefName: string; state?: string }>) {
  return (call: StubGhCall): CommandResult => {
    if (call.args[0] !== "api" || call.args[1] !== "graphql") {
      return { stdout: "", stderr: `unexpected call: ${call.args.join(" ")}`, exitCode: 1 };
    }
    const branchArg = call.args.find((a) => a.startsWith("branch="));
    const branch = branchArg?.slice("branch=".length) ?? "";
    const pr = branchToPR[branch];
    if (!pr) {
      return {
        stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
        stderr: "",
        exitCode: 0,
      };
    }
    const state = pr.state ?? "OPEN";
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: pr.number,
                  url: `https://github.com/owner/repo/pull/${pr.number}`,
                  state,
                  title: "T",
                  baseRefName: pr.baseRefName,
                  reviewDecision: null,
                  reviewThreads: { totalCount: 0, nodes: [] },
                  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                },
              ],
            },
          },
        },
      }),
      stderr: "",
      exitCode: 0,
    };
  };
}

describe("syncCommand bare", () => {
  test("empty stack: no commits in stack", async () => {
    const repo = await makeRepoWithConfig();
    const { gh, calls } = stubGh(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(logs.out.join("\n")).toContain("No commits in stack");
    expect(calls).toHaveLength(0);
  });

  test("injects missing Spry-Commit-Id trailers", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Untrailed commit"], { cwd: repo.path });

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(logs.out.join("\n")).toMatch(/Injected 1 commit ID/i);
    const log = await git.run(["log", "-1", "--format=%B"], { cwd: repo.path });
    expect(log.stdout).toContain("Spry-Commit-Id:");
  });

  test("no-op push when no remote branches match", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(
      ["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"],
      { cwd: repo.path },
    );

    const { gh, calls } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    // No remote branch yet → no push, no gh call
    expect(calls).toHaveLength(0);
    expect(logs.out.join("\n")).toContain("Sync complete");
  });

  test("pushes branch when remote ref already exists; retarget skipped if base correct", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    const sha = await git.run(
      ["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"],
      { cwd: repo.path },
    );

    // Pre-create the remote branch
    const head = (
      await git.run(["rev-parse", "HEAD"], { cwd: repo.path })
    ).stdout.trim();
    await git.run(
      ["push", "origin", `${head}:refs/heads/spry/test/aaa11111`],
      { cwd: repo.path },
    );

    const { gh, calls } = stubGh(
      ghPRMap({ "spry/test/aaa11111": { number: 10, baseRefName: "main" } }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(logs.out.join("\n")).toContain("pushed spry/test/aaa11111");
    // base is correct → no retarget call (only the graphql lookup)
    const editCalls = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(editCalls).toHaveLength(0);
  });

  test("retargets when PR's baseRefName differs from expected", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(
      ["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"],
      { cwd: repo.path },
    );
    await git.run(
      ["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"],
      { cwd: repo.path },
    );

    // Both branches exist remotely
    const aSha = (
      await git.run(["rev-parse", "HEAD~1"], { cwd: repo.path })
    ).stdout.trim();
    const bSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(
      ["push", "origin", `${aSha}:refs/heads/spry/test/aaa11111`],
      { cwd: repo.path },
    );
    await git.run(
      ["push", "origin", `${bSha}:refs/heads/spry/test/bbb22222`],
      { cwd: repo.path },
    );

    // PR for B has wrong base (points at main; should be at A's branch)
    const { gh, calls } = stubGh(
      ghPRMap({
        "spry/test/aaa11111": { number: 10, baseRefName: "main" },
        "spry/test/bbb22222": { number: 11, baseRefName: "main" },
      }),
    );
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    const edits = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.args).toEqual(["pr", "edit", "11", "--base", "spry/test/aaa11111"]);
    expect(logs.out.join("\n")).toMatch(/retargeted PR #11/);
  });

  test("falls back gracefully when gh is unavailable; branches still pushed", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(
      ["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"],
      { cwd: repo.path },
    );
    const head = (
      await git.run(["rev-parse", "HEAD"], { cwd: repo.path })
    ).stdout.trim();
    await git.run(
      ["push", "origin", `${head}:refs/heads/spry/test/aaa11111`],
      { cwd: repo.path },
    );

    const { gh } = stubGh(() => ({
      stdout: "",
      stderr: "/bin/sh: gh: command not found",
      exitCode: 127,
    }));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path });
    } finally {
      logs.restore();
    }
    expect(logs.out.join("\n")).toContain("pushed spry/test/aaa11111");
    expect(logs.out.join("\n")).toMatch(/PR retargeting unavailable/);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker tests/commands/sync.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement bare-sync flow**

Create [src/commands/sync.ts](src/commands/sync.ts):

```ts
import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import {
  loadConfig,
  trunkRef,
  getStackCommits,
  injectMissingIds,
  branchForUnit,
} from "../git/index.ts";
import { requireCleanWorkingTree } from "../git/status.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import type { CommitWithTrailers, PRUnit } from "../parse/index.ts";
import { formatValidationError } from "../ui/format.ts";
import {
  listRemoteBranches,
  pushBranch,
  findPRsForBranches,
  retargetPR,
  GhAuthError,
  GhNotInstalledError,
} from "../gh/index.ts";
import type { SpryConfig } from "../git/config.ts";

export interface SyncOptions {
  /** undefined = bare; null = boolean --open (TUI); string = comma-separated IDs */
  open?: string | null;
  cwd?: string;
}

export async function syncCommand(ctx: SpryContext, opts: SyncOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });
  await requireCleanWorkingTree(ctx.git, { cwd });

  const ref = trunkRef(config);

  // 1. Inject Spry-Commit-Id trailers; rewrites SHAs (branch names unchanged)
  const inject = await injectMissingIds(ctx.git, ref, { cwd });
  if (!inject.ok) {
    console.error("✗ Cannot sync from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }
  if (inject.modifiedCount > 0) {
    console.log(`✓ Injected ${inject.modifiedCount} commit ID(s)`);
  }

  // 2. Re-read commits + parse stack
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });
  const result = parseStack(withTrailers);
  if (!result.ok) {
    console.error(formatValidationError(result));
    process.exit(1);
  }
  const units = result.units;
  if (units.length === 0) {
    console.log("✓ No commits in stack");
    return;
  }

  // 3. Cheap signal: which branches already exist on the remote?
  const existing = await listRemoteBranches(ctx.git, config.remote, config.branchPrefix, { cwd });

  // 4. Push phase — only branches that already exist remotely
  const pushedBranches = await pushExistingBranches(ctx, config, units, withTrailers, existing, cwd);

  // 5. (--open handling — added in Tasks 6 and 7)
  if (opts.open !== undefined) {
    throw new Error("--open: not yet implemented (Task 6/7)");
  }

  // 6. Retarget phase — gh required, falls back gracefully
  await retargetMismatched(ctx, config, units, pushedBranches, cwd);

  console.log("✓ Sync complete");
}

async function pushExistingBranches(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  commits: CommitWithTrailers[],
  existing: Set<string>,
  cwd: string | undefined,
): Promise<string[]> {
  const pushed: string[] = [];
  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    if (!existing.has(branch)) continue;
    const headHash = unit.commits.at(-1);
    if (!headHash) continue;
    // Re-resolve SHA in case trailer injection changed it
    const headCommit = commits.find((c) => c.hash === headHash);
    const sha = headCommit?.hash ?? headHash;
    const result = await pushBranch(ctx.git, {
      cwd,
      remote: config.remote,
      sha,
      branch,
      forceWithLease: true,
    });
    if (result.ok) {
      console.log(`↑ pushed ${branch}`);
      pushed.push(branch);
    } else if (result.reason === "stale-ref") {
      console.error(
        `✗ Refusing to overwrite ${branch}: remote diverged. Run \`git fetch\` and try again.`,
      );
    } else {
      console.error(`✗ Failed to push ${branch}: ${result.stderr.trim()}`);
    }
  }
  return pushed;
}

function expectedBaseFor(
  unit: PRUnit,
  units: PRUnit[],
  config: SpryConfig,
): string {
  const idx = units.findIndex((u) => u.id === unit.id);
  if (idx <= 0) return config.trunk;
  return branchForUnit(units[idx - 1]!, config);
}

async function retargetMismatched(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  branches: string[],
  cwd: string | undefined,
): Promise<void> {
  if (branches.length === 0) return;

  let prMap;
  try {
    prMap = await findPRsForBranches(ctx, branches, { cwd });
  } catch (err) {
    const hint = retargetingFallbackHint(err);
    console.log(kleur.dim(`${hint} (branches still updated)`));
    return;
  }

  for (const unit of units) {
    const branch = branchForUnit(unit, config);
    const pr = prMap.get(branch);
    if (!pr || pr.state !== "OPEN") continue;
    const expected = expectedBaseFor(unit, units, config);
    if (pr.baseRefName === expected) continue;
    try {
      await retargetPR(ctx, pr.number, expected, { cwd });
      console.log(`↻ retargeted PR #${pr.number} → ${expected}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠ Could not retarget PR #${pr.number}: ${message}`);
    }
  }
}

function retargetingFallbackHint(err: unknown): string {
  if (err instanceof GhNotInstalledError) {
    return "PR retargeting unavailable: install gh (https://cli.github.com)";
  }
  if (err instanceof GhAuthError) {
    return "PR retargeting unavailable: gh auth login";
  }
  if (err instanceof Error && /no github remotes|not a github/i.test(err.message)) {
    return "PR retargeting unavailable: not a GitHub repository";
  }
  return "PR retargeting unavailable: network error";
}
```

**Step 4: Run tests to verify they pass**

```bash
bun run test:docker tests/commands/sync.test.ts
```

Expected: PASS for all bare-sync tests (the `--open` tests will be added in Tasks 6 and 7).

If a test fails because `loadConfig` rejects the absence of `spry.branchPrefix` — confirm `makeRepoWithConfig` sets all three configs. If `injectMissingIds` rejects detached HEAD when run on the real test repo — make sure the test creates a branch (`feature/x`) before running sync.

**Step 5: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "feat(sync): bare sync flow — push existing branches, retarget"
```

---

## Task 6: `--open <ids>` flow

**Files:**

- Modify: `src/commands/sync.ts` (add `--open <ids>` branch)
- Modify: `tests/commands/sync.test.ts` (extend with `--open` tests)

**Step 1: Add failing tests**

Append inside `tests/commands/sync.test.ts`:

```ts
describe("syncCommand --open <ids>", () => {
  test("creates a PR for the listed unit", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(
      [
        "commit",
        "--allow-empty",
        "-m",
        "Add login\n\nDescription text\n\nSpry-Commit-Id: aaa11111",
      ],
      { cwd: repo.path },
    );

    const { gh, calls } = stubGh((call) => {
      if (call.args[0] === "api" && call.args[1] === "graphql") {
        return {
          stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (call.args[0] === "pr" && call.args[1] === "create") {
        return {
          stdout: "https://github.com/owner/repo/pull/55\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: `unexpected: ${call.args.join(" ")}`, exitCode: 1 };
    });
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa11111" });
    } finally {
      logs.restore();
    }
    const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(create).toBeDefined();
    expect(create!.args).toEqual([
      "pr",
      "create",
      "--title",
      "Add login",
      "--head",
      "spry/test/aaa11111",
      "--base",
      "main",
      "--body-file",
      "-",
    ]);
    expect(create!.stdin).toBe("Description text");
    expect(logs.out.join("\n")).toContain("Created PR #55");
    expect(logs.out.join("\n")).toContain("https://github.com/owner/repo/pull/55");
  });

  test("two-unit --open: second PR's base is first's branch", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(
      ["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"],
      { cwd: repo.path },
    );
    await git.run(
      ["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"],
      { cwd: repo.path },
    );

    let prCounter = 100;
    const { gh, calls } = stubGh((call) => {
      if (call.args[0] === "api" && call.args[1] === "graphql") {
        return {
          stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (call.args[0] === "pr" && call.args[1] === "create") {
        const n = prCounter++;
        return {
          stdout: `https://github.com/owner/repo/pull/${n}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: `unexpected: ${call.args.join(" ")}`, exitCode: 1 };
    });
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa11111,bbb22222" });
    } finally {
      logs.restore();
    }
    const creates = calls.filter((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(creates).toHaveLength(2);
    expect(creates[0]!.args).toContain("--base");
    expect(creates[0]!.args[creates[0]!.args.indexOf("--base") + 1]).toBe("main");
    expect(creates[1]!.args[creates[1]!.args.indexOf("--base") + 1]).toBe("spry/test/aaa11111");
  });

  test("--open of unit that already has a remote branch errors", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(
      ["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"],
      { cwd: repo.path },
    );
    const head = (
      await git.run(["rev-parse", "HEAD"], { cwd: repo.path })
    ).stdout.trim();
    await git.run(
      ["push", "origin", `${head}:refs/heads/spry/test/aaa11111`],
      { cwd: repo.path },
    );

    const { gh } = stubGh(ghPRMap({ "spry/test/aaa11111": { number: 1, baseRefName: "main" } }));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    let exited = false;
    const origExit = process.exit;
    // @ts-expect-error - stub
    process.exit = ((code: number) => {
      exited = true;
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa11111" });
    } catch (e) {
      // expected via exit
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(exited).toBe(true);
    expect(logs.err.join("\n")).toMatch(/already has a published branch/);
  });

  test("--open with prefix that matches multiple units errors", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(
      ["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"],
      { cwd: repo.path },
    );
    await git.run(
      ["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: aaa22222"],
      { cwd: repo.path },
    );

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    const origExit = process.exit;
    // @ts-expect-error
    process.exit = ((code: number) => {
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "aaa" });
    } catch {
      // expected
    } finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(logs.err.join("\n")).toMatch(/matches multiple/i);
  });

  test("--open of a group errors with deferral message", async () => {
    const repo = await makeRepoWithConfig();
    const git = createRealGitRunner();
    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(
      [
        "commit",
        "--allow-empty",
        "-m",
        "First\n\nSpry-Commit-Id: aaa11111\nSpry-Group: grp00001",
      ],
      { cwd: repo.path },
    );
    await git.run(
      [
        "commit",
        "--allow-empty",
        "-m",
        "Second\n\nSpry-Commit-Id: bbb22222\nSpry-Group: grp00001",
      ],
      { cwd: repo.path },
    );

    const { gh } = stubGh(ghPRMap({}));
    const ctx = makeCtx(repo, gh);
    const logs = captureLogs();
    const origExit = process.exit;
    // @ts-expect-error
    process.exit = ((code: number) => {
      throw new Error(`__exit:${code}`);
    }) as unknown as typeof process.exit;
    try {
      await syncCommand(ctx, { cwd: repo.path, open: "grp00001" });
    } catch {}
    finally {
      process.exit = origExit;
      logs.restore();
    }
    expect(logs.err.join("\n")).toMatch(/Groups not supported/i);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun run test:docker tests/commands/sync.test.ts
```

Expected: the new tests FAIL (not implemented), existing bare-sync tests still PASS.

**Step 3: Implement `--open <ids>` flow**

Edit [src/commands/sync.ts](src/commands/sync.ts). Replace the placeholder `if (opts.open !== undefined)` block with:

```ts
  // 5. --open: open new PRs (with their own pushes)
  let openedBranches: string[] = [];
  if (opts.open !== undefined) {
    if (opts.open === null) {
      throw new Error("TUI selector not yet wired (Task 7)"); // Task 7 fills this in
    }
    const targets = resolveOpenTargets(opts.open, units, withTrailers, existing, config);
    if (!targets.ok) {
      console.error(targets.error);
      process.exit(1);
    }
    openedBranches = await openPRs(ctx, config, units, targets.unitIds, withTrailers, cwd);
  }
```

Add helpers below `pushExistingBranches`:

```ts
import {
  resolveIdentifiers,
  formatResolutionError,
} from "../parse/index.ts";
import { createPR, formatPRTitle, formatPRBody } from "../gh/index.ts";

type ResolveTargetsResult =
  | { ok: true; unitIds: string[] }
  | { ok: false; error: string };

function resolveOpenTargets(
  raw: string,
  units: PRUnit[],
  commits: CommitWithTrailers[],
  existing: Set<string>,
  config: SpryConfig,
): ResolveTargetsResult {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    return { ok: false, error: "✗ --open: no IDs provided" };
  }

  const { unitIds, errors } = resolveIdentifiers(ids, units, commits);
  if (errors.length > 0) {
    return { ok: false, error: errors.map((e) => formatResolutionError(e)).join("\n") };
  }

  for (const id of unitIds) {
    const unit = units.find((u) => u.id === id);
    if (!unit) continue;
    if (unit.type === "group") {
      return {
        ok: false,
        error:
          `✗ Groups not supported in --open yet (unit ${unit.id}).\n` +
          `  Group title storage lands with \`sp group\` (Step 7). For now, --open works on singles.`,
      };
    }
    const branch = branchForUnit(unit, config);
    if (existing.has(branch)) {
      return {
        ok: false,
        error:
          `✗ Unit ${unit.id} already has a published branch (${branch}).\n` +
          `  --open is for first-time publish only.\n` +
          `  Run \`sp sync\` to update the branch (PR title/body updates land in a future step).`,
      };
    }
  }

  return { ok: true, unitIds };
}

async function openPRs(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  targetIds: string[],
  commits: CommitWithTrailers[],
  cwd: string | undefined,
): Promise<string[]> {
  const targetSet = new Set(targetIds);
  const opened: string[] = [];

  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (!targetSet.has(unit.id)) continue;
    const branch = branchForUnit(unit, config);
    const headHash = unit.commits.at(-1);
    if (!headHash) continue;

    // Push first
    const pushResult = await pushBranch(ctx.git, {
      cwd,
      remote: config.remote,
      sha: headHash,
      branch,
      forceWithLease: true,
    });
    if (!pushResult.ok) {
      console.error(`✗ Failed to push ${branch}: ${pushResult.stderr.trim()}`);
      process.exit(1);
    }
    console.log(`↑ pushed ${branch}`);

    // Compute base from local stack order
    const base = i === 0 ? config.trunk : branchForUnit(units[i - 1]!, config);

    const commitsForBody = commits.map((c) => ({
      hash: c.hash,
      subject: c.subject,
      body: c.body,
      trailers: c.trailers,
    }));

    const title = formatPRTitle(unit, commitsForBody);
    const body = formatPRBody(unit, commitsForBody);
    const pr = await createPR(ctx, { title, head: branch, base, body }, { cwd });
    console.log(`✓ Created PR #${pr.number}: ${title}`);
    console.log(`  ${pr.url}`);
    opened.push(branch);
  }

  return opened;
}
```

Also extend the retarget call to include opened branches:

```ts
  // 6. Retarget phase
  await retargetMismatched(
    ctx,
    config,
    units,
    [...pushedBranches, ...openedBranches],
    cwd,
  );
```

**Step 4: Run tests to verify they pass**

```bash
bun run test:docker tests/commands/sync.test.ts
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "feat(sync): --open <ids> flow with PR creation"
```

---

## Task 7: `--open` boolean (TUI) flow

**Files:**

- Modify: `src/commands/sync.ts` (replace TUI placeholder)
- Modify: `tests/commands/sync.test.ts` (add a small unit test for the candidate-list builder)

The full TUI is exercised by `tests/tui/select.test.ts` (Task 4). Here we test the glue (candidate list filtering) and trust the TUI itself for the actual interaction.

**Step 1: Extract a pure helper that lists open candidates**

Inside `src/commands/sync.ts`, add an exported helper:

```ts
export function buildOpenCandidates(
  units: PRUnit[],
  existing: Set<string>,
  config: SpryConfig,
): { id: string; label: string; hint?: string; disabled?: boolean }[] {
  return units.map((unit) => {
    const branch = branchForUnit(unit, config);
    const isPublished = existing.has(branch);
    const isGroup = unit.type === "group";
    const disabled = isPublished || isGroup;
    let hint: string | undefined;
    if (isPublished) hint = "(already published)";
    else if (isGroup) hint = "(group — Step 7)";
    const label = `${unit.id}  ${unit.title ?? unit.subjects[0] ?? "Untitled"}`;
    const opt: { id: string; label: string; hint?: string; disabled?: boolean } = {
      id: unit.id,
      label,
    };
    if (hint !== undefined) opt.hint = hint;
    if (disabled) opt.disabled = true;
    return opt;
  });
}
```

**Step 2: Add failing test for `buildOpenCandidates`**

Append to `tests/commands/sync.test.ts`:

```ts
import { buildOpenCandidates } from "../../src/commands/sync.ts";

describe("buildOpenCandidates", () => {
  const config = { trunk: "main", remote: "origin", branchPrefix: "spry/test" };

  function single(id: string, title: string): PRUnit {
    return {
      type: "single",
      id,
      title,
      commitIds: [id],
      commits: [id.repeat(5)],
      subjects: [title],
    };
  }

  function group(id: string, title: string): PRUnit {
    return {
      type: "group",
      id,
      title,
      commitIds: [id],
      commits: [id.repeat(5)],
      subjects: [title],
    };
  }

  test("disables units that already have a remote branch", () => {
    const units = [single("aaa11111", "A"), single("bbb22222", "B")];
    const existing = new Set(["spry/test/aaa11111"]);
    const out = buildOpenCandidates(units, existing, config);
    expect(out[0]!.disabled).toBe(true);
    expect(out[0]!.hint).toBe("(already published)");
    expect(out[1]!.disabled).toBeUndefined();
  });

  test("disables groups with a Step 7 hint", () => {
    const units = [single("aaa11111", "A"), group("grp00001", "G")];
    const out = buildOpenCandidates(units, new Set(), config);
    expect(out[1]!.disabled).toBe(true);
    expect(out[1]!.hint).toMatch(/Step 7/);
  });
});
```

(Add `import type { PRUnit } from "../../src/parse/types.ts";` at the top if not already there.)

**Step 3: Run tests to verify they fail**

```bash
bun run test:docker tests/commands/sync.test.ts
```

Expected: the new tests FAIL.

**Step 4: Wire the TUI into syncCommand**

Replace the `opts.open === null` placeholder with:

```ts
    if (opts.open === null) {
      const candidates = buildOpenCandidates(units, existing, config);
      const result = await selectUnits(candidates);
      if (result.cancelled) {
        console.log("Cancelled.");
        return;
      }
      if (result.selectedIds.length === 0) {
        console.log("(no units selected)");
        return;
      }
      openedBranches = await openPRs(ctx, config, units, result.selectedIds, withTrailers, cwd);
    } else {
      const targets = resolveOpenTargets(opts.open, units, withTrailers, existing, config);
      if (!targets.ok) {
        console.error(targets.error);
        process.exit(1);
      }
      openedBranches = await openPRs(ctx, config, units, targets.unitIds, withTrailers, cwd);
    }
```

Add the import: `import { selectUnits } from "../tui/index.ts";`

**Step 5: Run tests to verify they pass**

```bash
bun run test:docker tests/commands/sync.test.ts tests/tui/
```

Expected: all PASS.

**Step 6: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "feat(sync): --open boolean wires multi-select TUI"
```

---

## Task 8: CLI wiring for `sp sync`

**Files:**

- Modify: `src/cli/index.ts`

**Step 1: Edit `src/cli/index.ts`**

Add to [src/cli/index.ts](src/cli/index.ts) after the existing `view` command:

```ts
import { syncCommand } from "../commands/sync.ts";

program
  .command("sync")
  .description("Sync the current stack to GitHub")
  .option("--open [ids]", "Open PRs for selected units (no value = TUI selector)")
  .action((opts: { open?: string | true }) => {
    const open = opts.open === undefined ? undefined : opts.open === true ? null : opts.open;
    return syncCommand(ctx, { open });
  });
```

**Step 2: Smoke-test the CLI**

```bash
bun run src/cli/index.ts sync --help
```

Expected output includes:

```
--open [ids]  Open PRs for selected units (no value = TUI selector)
```

**Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): wire sp sync command"
```

---

## Task 9: Doc-producing tests

**Files:**

- Create: `tests/commands/sync.doc.test.ts`
- Generated: `docs/generated/commands/sync.md`

**Step 1: Write the doc tests**

Create [tests/commands/sync.doc.test.ts](tests/commands/sync.doc.test.ts):

```ts
import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import { docTest, createRunner, createRepo, createRealGitRunner } from "../lib/index.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const runSp = createRunner(cliPath);

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

describe("sp sync docs", () => {
  docTest(
    "Pushing existing branches",
    { section: "commands/sync", order: 10 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
      await git.run(
        ["commit", "--allow-empty", "-m", "Add login\n\nSpry-Commit-Id: aaa11111"],
        { cwd: repo.path },
      );

      // Pre-publish the branch
      const head = (
        await git.run(["rev-parse", "HEAD"], { cwd: repo.path })
      ).stdout.trim();
      await git.run(
        ["push", "origin", `${head}:refs/heads/spry/dondenton/aaa11111`],
        { cwd: repo.path },
      );

      doc.prose(
        "Run `sp sync` to push your stack's commits to their already-published remote branches. Spry derives each branch as `<spry.branchPrefix>/<unit-id>` and only pushes branches that already exist on the remote — it never creates new ones. Use `sp sync --open` to publish for the first time.",
      );

      // Canonicalize the gh-unavailable hint so fragments stay deterministic
      doc.scrub(
        /PR retargeting unavailable: [^\n]+/,
        "PR retargeting unavailable: <hint>",
      );

      const { command, result } = await runSp(repo.path, "sync");
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pushed spry/dondenton/aaa11111");
    },
  );

  docTest(
    "Empty stack",
    { section: "commands/sync", order: 20 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      doc.prose("On a branch with no commits ahead of trunk, `sp sync` no-ops:");

      const { command, result } = await runSp(repo.path, "sync");
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No commits in stack");
    },
  );
});
```

(`--open` examples need a stub gh capable of receiving `pr create` and parroting back a URL. The real CLI run in `runSp` cannot easily inject a stub. Skip `--open` doc fragments in this iteration — they can be added once the cassette story for write ops is settled.)

**Step 2: Run the doc tests**

```bash
bun run test:local:docker tests/commands/sync.doc.test.ts
```

Expected: PASS.

**Step 3: Build docs**

```bash
bun run docs:build
```

Expected: `docs/generated/commands/sync.md` is produced with two sections.

**Step 4: Verify determinism**

```bash
bun run test:local:docker tests/commands/sync.doc.test.ts && bun run docs:build && git diff docs/generated/commands/sync.md
```

Expected: empty diff. If non-empty, find the dynamic value and add a `doc.scrub(...)` for it.

**Step 5: Commit**

```bash
git add tests/commands/sync.doc.test.ts docs/generated/commands/sync.md
git commit -m "test(sync): doc-producing tests for sp sync"
```

---

## Task 10: CHANGELOG

**Files:**

- Modify: `CHANGELOG.md`

**Step 1: Add entries under `## [Unreleased] / ### Added`**

```markdown
- `sp sync` command — first writer in the rebuild.
  - Bare `sp sync` injects missing `Spry-Commit-Id` trailers, then pushes any
    units whose `<branchPrefix>/<unit-id>` ref already exists on the remote.
    Never creates new remote branches. Force-with-lease semantics.
  - After pushing, looks up PRs and retargets any whose base ref doesn't match
    the current local stack order. If gh is unavailable (no-gh / auth /
    no-remote / network), prints a hint and exits cleanly — branches were
    still pushed.
  - `sp sync --open <ids>` (comma-separated, full or prefix-matched unit IDs)
    pushes branches and creates PRs for the selected single-commit units.
    PR title = commit subject; PR body = commit prose with all trailers
    stripped. Each PR is opened with the appropriate base from the local
    stack order. Errors if any target is a group, has no match, has multiple
    matches, or already has a published branch.
  - `sp sync --open` (no value) drops into a TUI multi-select listing the
    units that don't yet have remote branches; cancellable with Esc/Ctrl+C.
- `src/gh/pr-body.ts` — pure `formatPRTitle`, `formatPRBody`, `stripTrailers`.
- `src/gh/push.ts` — `pushBranch` (force-with-lease) and `listRemoteBranches`.
- `src/gh/pr.ts` — `createPR` and `retargetPR` write operations with retry.
- `src/tui/select.ts` — multi-select widget over `TerminalDriver`. First
  feature-side use of the PTY infrastructure.
```

**Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for sp sync"
```

---

## Task 11: Final verification

**Step 1: Full test suite**

```bash
bun run test:docker
```

Expected: all green.

**Step 2: Typecheck and lint**

```bash
bun run check
```

Expected: clean.

**Step 3: CLI smoke test**

```bash
bun run src/cli/index.ts sync --help
bun run src/cli/index.ts sync --no-such-flag 2>&1 | head
```

Expected: `--help` shows the `--open [ids]` option; unknown flag errors cleanly.

**Step 4: Cleanup commit if lint touched anything**

If `bun run check` made any changes:

```bash
git add -A
git commit -m "chore: lint/format pass after sp sync"
```

Otherwise, no commit.

---

## Summary

By completion:

- `sp sync` (bare) injects trailers, pushes existing branches via force-with-lease, retargets mismatched PRs, falls back gracefully when gh is unavailable.
- `sp sync --open <ids>` creates PRs for selected single-commit units with title-from-subject, body-from-prose-minus-trailers semantics. Write-once.
- `sp sync --open` (boolean) drops into a multi-select TUI.
- `src/gh/` gains its first writer surface: `createPR`, `retargetPR`, `pushBranch`, `pr-body` formatters.
- `src/tui/` introduced; `selectUnits` widget snapshot-tested via `TerminalDriver`.
- Doc fragments cover bare-sync push and the empty-stack case.
- Full suite green; typecheck/lint clean.
