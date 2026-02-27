# sp view (local) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the `sp view` command — the first user-facing command in the rebuild. Displays the local commit stack without GitHub enrichment.

**Architecture:** Command + Formatter. Command handler orchestrates git queries via DI (`SpryContext`), formatter is a pure function (PRUnits → string). CLI entry point uses commander.

**Tech Stack:** Bun, TypeScript, commander (CLI), kleur (colors), bun:test.

**Design doc:** `docs/plans/2026-02-27-sp-view-local-design.md`

---

## Task 0: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install commander and kleur**

Run: `bun add commander kleur`

**Step 2: Verify installation**

Run: `bun run -e "import { Command } from 'commander'; import kleur from 'kleur'; console.log('ok')"`
Expected: `ok`

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add commander and kleur dependencies"
```

---

## Task 1: Move GitRunner/SpryContext to src/

Move the `GitRunner` interface, `CommandResult`, `CommandOptions`, and `SpryContext` types from `tests/lib/context.ts` to `src/lib/context.ts`. Move `createRealGitRunner()` from `tests/lib/git-runner.ts` to `src/lib/context.ts`. Update all imports across `src/` and `tests/`.

**Files:**
- Create: `src/lib/context.ts`
- Modify: `tests/lib/context.ts` — re-export from `src/lib/context.ts`
- Modify: `tests/lib/git-runner.ts` — re-export from `src/lib/context.ts`
- Modify: `tests/lib/index.ts` — update exports
- Modify: `src/git/config.ts` — update import
- Modify: `src/git/queries.ts` — update import
- Modify: `src/git/plumbing.ts` — update import
- Modify: `src/git/status.ts` — update import
- Modify: `src/git/conflict.ts` — update import
- Modify: `src/git/rebase.ts` — update import
- Modify: `src/parse/trailers.ts` — update import

**Step 1: Create `src/lib/context.ts`**

```ts
// src/lib/context.ts
import { $ } from "bun";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface GitRunner {
  run(args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface GhClient {
  run(args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface SpryContext {
  git: GitRunner;
  // gh: GhClient — added in Step 4
}

export function createRealGitRunner(): GitRunner {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const input = options?.stdin ? Buffer.from(options.stdin) : undefined;
      let proc = input
        ? $`git ${args} < ${input}`.nothrow().quiet()
        : $`git ${args}`.nothrow().quiet();
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

**Step 2: Update `tests/lib/context.ts` to re-export**

```ts
// tests/lib/context.ts
export type {
  CommandResult,
  CommandOptions,
  GitRunner,
  GhClient,
  SpryContext,
} from "../../src/lib/context.ts";
```

**Step 3: Update `tests/lib/git-runner.ts` to re-export**

```ts
// tests/lib/git-runner.ts
export { createRealGitRunner } from "../../src/lib/context.ts";
```

**Step 4: Update all `src/` imports**

In every file under `src/` that imports from `../../tests/lib/context.ts`, change to import from the new location. The files are:

- `src/git/config.ts`: `import type { GitRunner } from "../lib/context.ts";`
- `src/git/queries.ts`: `import type { GitRunner } from "../lib/context.ts";`
- `src/git/plumbing.ts`: `import type { GitRunner } from "../lib/context.ts";`
- `src/git/status.ts`: `import type { GitRunner } from "../lib/context.ts";`
- `src/git/conflict.ts`: `import type { GitRunner } from "../lib/context.ts";`
- `src/git/rebase.ts`: `import type { GitRunner } from "../lib/context.ts";`
- `src/parse/trailers.ts`: `import type { GitRunner } from "../lib/context.ts";`

**Step 5: Run all tests**

Run: `bun test`
Expected: All 211 tests pass. No import errors.

**Step 6: Commit**

```bash
git add src/lib/context.ts tests/lib/context.ts tests/lib/git-runner.ts src/git/ src/parse/trailers.ts
git commit -m "refactor: move GitRunner and SpryContext to src/lib/context"
```

---

## Task 2: Add `parseCommitTrailers` batch helper

Add a batch helper to `src/parse/trailers.ts` that bridges `getStackCommits()` (returns `CommitInfo[]`) with `parseStack()` (expects `CommitWithTrailers[]`).

**Files:**
- Modify: `src/parse/trailers.ts`
- Modify: `src/parse/index.ts` — add export
- Create: `tests/parse/trailers-batch.test.ts`

**Step 1: Write the failing test**

Create `tests/parse/trailers-batch.test.ts`:

```ts
import { describe, test, expect, afterAll } from "bun:test";
import { parseCommitTrailers } from "../../src/parse/trailers.ts";
import { createRepo, createRealGitRunner } from "../lib/index.ts";
import { repoManager } from "../lib/index.ts";
import type { CommitInfo } from "../../src/parse/types.ts";

afterAll(() => repoManager.cleanupAll());

describe("parseCommitTrailers", () => {
  test("parses trailers from multiple commits", async () => {
    const repo = await createRepo();
    repoManager.track(repo);
    const git = createRealGitRunner();

    const commits: CommitInfo[] = [
      {
        hash: "abc123",
        subject: "First commit",
        body: "First commit\n\nSpry-Commit-Id: aaa11111\n",
        trailers: {},
      },
      {
        hash: "def456",
        subject: "Second commit",
        body: "Second commit\n\nSpry-Commit-Id: bbb22222\nSpry-Group: grp1\n",
        trailers: {},
      },
      {
        hash: "ghi789",
        subject: "Third commit",
        body: "Third commit\n",
        trailers: {},
      },
    ];

    const result = await parseCommitTrailers(commits, git, { cwd: repo.path });
    expect(result).toHaveLength(3);
    expect(result[0]!.trailers["Spry-Commit-Id"]).toBe("aaa11111");
    expect(result[1]!.trailers["Spry-Commit-Id"]).toBe("bbb22222");
    expect(result[1]!.trailers["Spry-Group"]).toBe("grp1");
    expect(result[2]!.trailers["Spry-Commit-Id"]).toBeUndefined();
  });

  test("returns empty trailers for commits with empty bodies", async () => {
    const repo = await createRepo();
    repoManager.track(repo);
    const git = createRealGitRunner();

    const commits: CommitInfo[] = [
      { hash: "abc123", subject: "Commit", body: "", trailers: {} },
    ];

    const result = await parseCommitTrailers(commits, git, { cwd: repo.path });
    expect(result).toHaveLength(1);
    expect(result[0]!.trailers).toEqual({});
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/parse/trailers-batch.test.ts`
Expected: FAIL — `parseCommitTrailers` is not exported.

**Step 3: Implement `parseCommitTrailers`**

Add to `src/parse/trailers.ts`:

```ts
import type { CommitInfo } from "./types.ts";
import type { CommitWithTrailers } from "./stack.ts";

export interface TrailerOptions {
  cwd?: string;
}

export async function parseCommitTrailers(
  commits: CommitInfo[],
  git: GitRunner,
  options?: TrailerOptions,
): Promise<CommitWithTrailers[]> {
  return Promise.all(
    commits.map(async (commit) => ({
      hash: commit.hash,
      subject: commit.subject,
      body: commit.body,
      trailers: await parseTrailers(commit.body, git, options),
    })),
  );
}
```

Note: `parseTrailers` needs to accept an options parameter for `cwd`. Check if it already does — if not, add optional `options?: { cwd?: string }` parameter and pass `{ cwd: options?.cwd }` to `git.run()`.

**Step 4: Export from barrel**

Add to `src/parse/index.ts`:

```ts
export { parseTrailers, addTrailers, parseCommitTrailers } from "./trailers.ts";
export type { TrailerOptions } from "./trailers.ts";
```

**Step 5: Run test to verify it passes**

Run: `bun test tests/parse/trailers-batch.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `bun test`
Expected: All tests pass (211 + new ones).

**Step 7: Commit**

```bash
git add src/parse/trailers.ts src/parse/index.ts tests/parse/trailers-batch.test.ts
git commit -m "feat(parse): add parseCommitTrailers batch helper"
```

---

## Task 3: Formatter — `formatStackView` (pure unit tests)

Build the pure formatting function with comprehensive unit tests. No git, no repos — just hand-crafted PRUnit arrays in, strings out.

**Files:**
- Create: `src/ui/format.ts`
- Create: `tests/ui/format.test.ts`

**Step 1: Write the failing tests**

Create `tests/ui/format.test.ts`. Use a `stripAnsi` helper to remove ANSI codes for assertions:

```ts
import { describe, test, expect } from "bun:test";
import { formatStackView, formatValidationError } from "../../src/ui/format.ts";
import type { PRUnit, StackParseResult } from "../../src/parse/types.ts";

// Strip ANSI escape codes for clean assertions
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatStackView", () => {
  test("returns empty-stack message when no units", () => {
    const output = formatStackView([], "main", 0, "origin/main");
    expect(stripAnsi(output)).toBe("No commits ahead of origin/main");
  });

  test("shows header with branch name and commit count", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "abc12345",
        title: "Add feature",
        commitIds: ["abc12345"],
        commits: ["abc12345678901234567890123456789012345678"],
        subjects: ["Add feature"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feature-branch", 1, "origin/main"));
    expect(output).toContain("Stack: feature-branch (1 commit)");
  });

  test("pluralizes commits correctly", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "a1",
        title: "First",
        commitIds: ["a1"],
        commits: ["aaa"],
        subjects: ["First"],
      },
      {
        type: "single",
        id: "b2",
        title: "Second",
        commitIds: ["b2"],
        commits: ["bbb"],
        subjects: ["Second"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 2, "origin/main"));
    expect(output).toContain("(2 commits)");
  });

  test("shows trunk ref indicator", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "a1",
        title: "Commit",
        commitIds: ["a1"],
        commits: ["aaa"],
        subjects: ["Commit"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 1, "origin/main"));
    expect(output).toContain("→ origin/main");
  });

  test("shows single commit with ID", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "abc12345",
        title: "Add feature",
        commitIds: ["abc12345"],
        commits: ["abc12345678901234567890123456789012345678"],
        subjects: ["Add feature"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 1, "origin/main"));
    expect(output).toContain("○ Add feature (abc12345)");
  });

  test("shows single commit without ID as '(no ID)'", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "abc12345",
        title: "Add feature",
        commitIds: [],
        commits: ["abc12345678901234567890123456789012345678"],
        subjects: ["Add feature"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 1, "origin/main"));
    expect(output).toContain("○ Add feature (no ID)");
  });

  test("shows group with stored title", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: "Auth system",
        commitIds: ["a1", "b2"],
        commits: ["aaa", "bbb"],
        subjects: ["Add middleware", "Add session"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 2, "origin/main"));
    expect(output).toContain("○ Auth system");
    expect(output).toContain("├─ Add middleware (a1)");
    expect(output).toContain("└─ Add session (b2)");
  });

  test("shows group without title as auto-generated letter + commit count", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: undefined,
        commitIds: ["a1", "b2"],
        commits: ["aaa", "bbb"],
        subjects: ["Add middleware", "Add session"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 2, "origin/main"));
    expect(output).toContain("○ A (2 commits)");
  });

  test("auto-generated letters increment across multiple untitled groups", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: undefined,
        commitIds: [],
        commits: ["aaa", "bbb"],
        subjects: ["First", "Second"],
      },
      {
        type: "single",
        id: "c3",
        title: "Middle commit",
        commitIds: ["c3"],
        commits: ["ccc"],
        subjects: ["Middle commit"],
      },
      {
        type: "group",
        id: "grp2",
        title: undefined,
        commitIds: [],
        commits: ["ddd", "eee"],
        subjects: ["Third", "Fourth"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 4, "origin/main"));
    expect(output).toContain("○ A (2 commits)");
    expect(output).toContain("○ B (2 commits)");
  });

  test("titled groups do not consume a letter", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: "Named group",
        commitIds: [],
        commits: ["aaa", "bbb"],
        subjects: ["First", "Second"],
      },
      {
        type: "group",
        id: "grp2",
        title: undefined,
        commitIds: [],
        commits: ["ccc", "ddd"],
        subjects: ["Third", "Fourth"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 4, "origin/main"));
    expect(output).toContain("○ Named group");
    expect(output).toContain("○ A (2 commits)");
  });

  test("shows legend line", () => {
    const units: PRUnit[] = [
      {
        type: "single",
        id: "a1",
        title: "Commit",
        commitIds: ["a1"],
        commits: ["aaa"],
        subjects: ["Commit"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 1, "origin/main"));
    expect(output).toContain("○ no PR");
    expect(output).toContain("◐ open");
    expect(output).toContain("✓ merged");
    expect(output).toContain("✗ closed");
  });

  test("group commit without ID shows (no ID)", () => {
    const units: PRUnit[] = [
      {
        type: "group",
        id: "grp1",
        title: "Group",
        commitIds: ["a1"],
        commits: ["aaa", "bbb"],
        subjects: ["With ID", "Without ID"],
      },
    ];
    const output = stripAnsi(formatStackView(units, "feat", 2, "origin/main"));
    expect(output).toContain("├─ With ID (a1)");
    expect(output).toContain("└─ Without ID (no ID)");
  });
});

describe("formatValidationError", () => {
  test("formats split-group error", () => {
    const result: Exclude<StackParseResult, { ok: true }> = {
      ok: false,
      error: "split-group",
      group: {
        id: "grp12345",
        title: "My Feature",
        commits: ["aaaa", "bbbb"],
      },
      interruptingCommits: ["cccc"],
    };
    const output = formatValidationError(result);
    expect(output).toContain("Split group detected");
    expect(output).toContain("My Feature");
    expect(output).toContain("grp12345");
    expect(output).toContain("1 commit(s) appear between group members");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/ui/format.test.ts`
Expected: FAIL — module `src/ui/format.ts` not found.

**Step 3: Implement `src/ui/format.ts`**

```ts
import kleur from "kleur";
import type { PRUnit, StackParseResult } from "../parse/types.ts";

const SEPARATOR = "─".repeat(72);

function getStatusIcon(unit: PRUnit): string {
  // Local view always shows ○ (no PR). Enriched view overrides this.
  return "○";
}

function getCommitIdDisplay(commitIds: string[], index: number): string {
  const id = commitIds[index];
  return id ? kleur.dim(`(${id})`) : kleur.dim("(no ID)");
}

export function formatStackView(
  units: PRUnit[],
  branch: string,
  commitCount: number,
  trunkRef: string,
): string {
  if (units.length === 0) {
    return `No commits ahead of ${trunkRef}`;
  }

  const lines: string[] = [];

  // Header
  const plural = commitCount === 1 ? "commit" : "commits";
  lines.push(`Stack: ${branch} (${commitCount} ${plural})`);

  // Legend
  lines.push(kleur.dim("○ no PR  ◐ open  ✓ merged  ✗ closed"));
  lines.push("");

  // Trunk ref indicator
  lines.push(`  → ${trunkRef}`);

  // Track auto-generated letter index for untitled groups
  let letterIndex = 0;

  for (const unit of units) {
    lines.push(SEPARATOR);

    const icon = getStatusIcon(unit);

    if (unit.type === "single") {
      const idDisplay = getCommitIdDisplay(unit.commitIds, 0);
      lines.push(`  ${icon} ${unit.title ?? unit.subjects[0] ?? "Untitled"} ${idDisplay}`);
    } else {
      // Group
      let groupTitle: string;
      if (unit.title) {
        groupTitle = unit.title;
      } else {
        const letter = String.fromCharCode(65 + letterIndex); // A, B, C...
        letterIndex++;
        groupTitle = `${letter} (${unit.commits.length} commits)`;
      }
      lines.push(`  ${icon} ${groupTitle}`);

      // Tree structure for group commits
      for (let i = 0; i < unit.commits.length; i++) {
        const isLast = i === unit.commits.length - 1;
        const prefix = isLast ? "└─" : "├─";
        const subject = unit.subjects[i] ?? "Unknown commit";
        const idDisplay = getCommitIdDisplay(unit.commitIds, i);
        lines.push(`    ${prefix} ${subject} ${idDisplay}`);
      }
    }
  }

  lines.push(SEPARATOR);
  return lines.join("\n");
}

export function formatValidationError(
  result: Exclude<StackParseResult, { ok: true }>,
): string {
  const lines: string[] = [];

  switch (result.error) {
    case "split-group": {
      const commitList = result.group.commits
        .map((h) => h.slice(0, 8))
        .join(", ");
      lines.push("Error: Split group detected");
      lines.push("");
      lines.push(
        `  Group "${result.group.title}" (${result.group.id.slice(0, 8)}) has non-contiguous commits.`,
      );
      lines.push(`  Commits: [${commitList}]`);
      lines.push("");
      lines.push(
        `  ${result.interruptingCommits.length} commit(s) appear between group members:`,
      );
      for (const hash of result.interruptingCommits) {
        lines.push(`    - ${hash.slice(0, 8)}`);
      }
      lines.push("");
      lines.push(
        "  This can happen when fixup! commits are squashed into a group.",
      );
      lines.push("  To fix:");
      lines.push("    sp group --fix   Guided repair (merge or dissolve)");
      lines.push("    sp group         Manual fix via the group editor");
      break;
    }
  }

  return lines.join("\n");
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/ui/format.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/ui/format.ts tests/ui/format.test.ts
git commit -m "feat(ui): add formatStackView and formatValidationError"
```

---

## Task 4: CLI Entry Point + View Command

Build the CLI entry point and the view command handler. Test via integration tests with real repos.

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/commands/view.ts`
- Create: `tests/commands/view.test.ts`

**Step 1: Write the failing integration tests**

Create `tests/commands/view.test.ts`:

```ts
import { describe, test, expect, afterAll } from "bun:test";
import { createRepo, createRealGitRunner, repoManager } from "../lib/index.ts";
import { viewCommand } from "../../src/commands/view.ts";
import type { SpryContext } from "../../src/lib/context.ts";

afterAll(() => repoManager.cleanupAll());

// Helper to capture stdout from viewCommand
async function captureView(ctx: SpryContext): Promise<{ stdout: string; exitCode: number }> {
  const chunks: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  let exitCode = 0;
  console.log = (...args: unknown[]) => chunks.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => chunks.push(args.map(String).join(" "));
  // @ts-expect-error — mock process.exit
  process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error("EXIT"); };

  try {
    await viewCommand(ctx);
  } catch (e) {
    if (!(e instanceof Error && e.message === "EXIT")) throw e;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { stdout: chunks.join("\n"), exitCode };
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("sp view command", () => {
  test("shows empty stack on trunk branch", async () => {
    const repo = await createRepo();
    repoManager.track(repo);
    const git = createRealGitRunner();

    // Configure spry
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

    const ctx: SpryContext = { git: { run: (args, opts) => git.run(args, { ...opts, cwd: repo.path }) } };
    const { stdout } = await captureView(ctx);
    expect(stripAnsi(stdout)).toContain("No commits ahead of origin/main");
  });

  test("shows stack with single commits", async () => {
    const repo = await createRepo();
    repoManager.track(repo);
    const git = createRealGitRunner();

    // Configure spry
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

    // Create feature branch with commits that have trailers
    await repo.branch("feature");

    // Commit with Spry-Commit-Id trailer
    await git.run(
      ["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"],
      { cwd: repo.path },
    );

    const ctx: SpryContext = { git: { run: (args, opts) => git.run(args, { ...opts, cwd: repo.path }) } };
    const { stdout } = await captureView(ctx);
    const plain = stripAnsi(stdout);
    expect(plain).toContain("Stack:");
    expect(plain).toContain("1 commit");
    expect(plain).toContain("Add login page");
    expect(plain).toContain("aaa11111");
  });

  test("shows stack with commit without trailer as (no ID)", async () => {
    const repo = await createRepo();
    repoManager.track(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

    await repo.branch("feature");
    await repo.commit("Plain commit");

    const ctx: SpryContext = { git: { run: (args, opts) => git.run(args, { ...opts, cwd: repo.path }) } };
    const { stdout } = await captureView(ctx);
    const plain = stripAnsi(stdout);
    expect(plain).toContain("(no ID)");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/commands/view.test.ts`
Expected: FAIL — modules not found.

**Step 3: Create `src/commands/view.ts`**

```ts
import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef, getCurrentBranch, getStackCommits } from "../git/index.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { formatStackView, formatValidationError } from "../ui/format.ts";

export async function viewCommand(ctx: SpryContext): Promise<void> {
  const config = await loadConfig(ctx.git);
  const branch = await getCurrentBranch(ctx.git);
  const ref = trunkRef(config);
  const commits = await getStackCommits(ctx.git, ref);
  const withTrailers = await parseCommitTrailers(commits, ctx.git);
  const result = parseStack(withTrailers);

  if (!result.ok) {
    console.error(formatValidationError(result));
    process.exit(1);
  }

  console.log(formatStackView(result.units, branch, commits.length, ref));
}
```

**Step 4: Create `src/cli/index.ts`**

```ts
#!/usr/bin/env bun
import { Command } from "commander";
import { viewCommand } from "../commands/view.ts";
import { createRealGitRunner } from "../lib/context.ts";
import type { SpryContext } from "../lib/context.ts";

const program = new Command();

program
  .name("sp")
  .description("Spry: Stacked PRs. Develop with alacrity.");

const ctx: SpryContext = { git: createRealGitRunner() };

program
  .command("view")
  .description("View the current stack of commits")
  .action(() => viewCommand(ctx));

program.parse();
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/commands/view.test.ts`
Expected: All tests PASS.

**Step 6: Run full test suite**

Run: `bun test`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/commands/view.ts src/cli/index.ts tests/commands/view.test.ts
git commit -m "feat: add sp view command and CLI entry point"
```

---

## Task 5: Doc-Producing Tests

First doc tests in the rebuild. These run `sp view` as a subprocess via `createRunner()` and produce documentation fragments.

**Files:**
- Create: `tests/commands/view.doc.test.ts`

**Step 1: Write the doc tests**

Create `tests/commands/view.doc.test.ts`:

```ts
import { describe, afterAll } from "bun:test";
import { docTest, createRunner, createRepo, createRealGitRunner, repoManager } from "../lib/index.ts";

const runSp = createRunner("src/cli/index.ts");

afterAll(() => repoManager.cleanupAll());

describe("sp view docs", () => {
  docTest(
    "Viewing a simple stack",
    { section: "commands/view", order: 10 },
    async (doc) => {
      const repo = await createRepo();
      repoManager.track(repo);
      const git = createRealGitRunner();

      // Configure spry
      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      // Create feature branch with two commits
      await repo.branch("feature");
      await git.run(
        ["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"],
        { cwd: repo.path },
      );
      await git.run(
        ["commit", "--allow-empty", "-m", "Add signup form\n\nSpry-Commit-Id: bbb22222"],
        { cwd: repo.path },
      );

      doc.prose("View the current stack of commits on your feature branch:");

      const { command, result } = await runSp(repo.path, "view");

      doc.command(command);
      doc.output(result.stdout);

      // Verify the output looks right
      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Stack:");
      expect(result.stdout).toContain("2 commits");
      expect(result.stdout).toContain("Add login page");
      expect(result.stdout).toContain("Add signup form");
    },
  );

  docTest(
    "Viewing an empty stack",
    { section: "commands/view", order: 20 },
    async (doc) => {
      const repo = await createRepo();
      repoManager.track(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });

      doc.prose("When you're on a branch with no commits ahead of trunk:");

      const { command, result } = await runSp(repo.path, "view");

      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No commits ahead of");
    },
  );
});
```

**Step 2: Run the doc tests**

Run: `bun test tests/commands/view.doc.test.ts`
Expected: All tests PASS. Doc fragments collected.

**Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add tests/commands/view.doc.test.ts
git commit -m "test: add doc-producing tests for sp view"
```

---

## Task 6: Manual Smoke Test + Polish

Manually run `sp view` in a real repo to verify it works end-to-end. Fix any issues.

**Step 1: Test in the spry repo itself**

Run from the spry repo root (make sure spry.trunk and spry.remote are configured):

```bash
git config spry.trunk main
git config spry.remote origin
bun src/cli/index.ts view
```

Expected: Stack display showing commits ahead of origin/main, or "No commits ahead of origin/main" if on main.

**Step 2: Test on a feature branch**

```bash
git checkout -b test-view-smoke
git commit --allow-empty -m "Test commit\n\nSpry-Commit-Id: smoke123"
bun src/cli/index.ts view
git checkout main
git branch -D test-view-smoke
```

Expected: Stack with 1 commit showing "Test commit (smoke123)".

**Step 3: Fix any issues found during smoke testing**

If the output doesn't look right or there are errors, fix them and add regression tests.

**Step 4: Run full test suite one final time**

Run: `bun test`
Expected: All tests pass.

**Step 5: Update changelog**

Add entry to CHANGELOG.md under Unreleased:

```
### Added
- `sp view` command — displays the current commit stack
- CLI entry point (`src/cli/index.ts`) with commander
- Stack formatter with auto-generated group titles (A, B, C...)
- Batch trailer parsing helper (`parseCommitTrailers`)
```

**Step 6: Final commit**

```bash
git add CHANGELOG.md
git commit -m "docs: update changelog for sp view"
```
