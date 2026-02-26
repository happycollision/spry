# Core Parsing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `src/parse/` — the foundational parsing and validation layer with types, trailer parsing, stack detection, commit ID generation, title resolution, identifier resolution, and input validation.

**Architecture:** Seven files in `src/parse/` with a barrel export. Pure logic except `trailers.ts` which uses `GitRunner` DI to call `git interpret-trailers`. Types defined in `types.ts` are shared across the codebase. Tests in `tests/parse/` — pure unit tests for everything except trailers which uses real git via the test lib's `createRepo()` and `createRealGitRunner()`.

**Tech Stack:** Bun (runtime + test runner), TypeScript, `bun:test`, `tests/lib/` infrastructure (GitRunner, createRepo).

**Design doc:** `docs/plans/2026-02-26-core-parsing-design.md`

---

## Task 1: Types

Define all shared types for the parsing layer. No tests needed — types are validated by the compiler and by the tests of modules that use them.

**Files:**
- Create: `src/parse/types.ts`
- Create: `src/parse/index.ts`

**Step 1: Write types.ts**

```ts
// src/parse/types.ts

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
  trailers: Record<string, string>;
}

export interface CommitTrailers {
  "Spry-Commit-Id"?: string;
  "Spry-Group"?: string;
  [key: string]: string | undefined;
}

export interface PRUnit {
  type: "single" | "group";
  id: string;
  title: string | undefined;
  commitIds: string[];
  commits: string[];
  subjects: string[];
}

export interface GroupInfo {
  id: string;
  title: string;
  commits: string[];
}

/** Type alias — storage/retrieval deferred to Git operations phase */
export type GroupTitles = Record<string, string>;

export type StackParseResult =
  | { ok: true; units: PRUnit[] }
  | {
      ok: false;
      error: "split-group";
      group: GroupInfo;
      interruptingCommits: string[];
    };

export type ValidationResult = { ok: true } | { ok: false; error: string };

export type IdentifierResolution =
  | { ok: true; unit: PRUnit }
  | { ok: false; error: "not-found"; identifier: string }
  | { ok: false; error: "ambiguous"; identifier: string; matches: string[] };

export type UpToResolution =
  | { ok: true; unitIds: Set<string> }
  | { ok: false; error: IdentifierResolution };
```

**Step 2: Write the barrel export**

```ts
// src/parse/index.ts
export type {
  CommitInfo,
  CommitTrailers,
  PRUnit,
  GroupInfo,
  GroupTitles,
  StackParseResult,
  ValidationResult,
  IdentifierResolution,
  UpToResolution,
} from "./types.ts";
```

We'll add function re-exports to the barrel as each module is built.

**Step 3: Verify compilation**

Run: `bunx tsc --noEmit`
Expected: PASS (no type errors)

**Step 4: Commit**

```bash
git add src/parse/types.ts src/parse/index.ts
git commit -m "feat(parse): add shared types for parsing layer"
```

---

## Task 2: Commit ID Generation

**Files:**
- Create: `tests/parse/id.test.ts`
- Create: `src/parse/id.ts`
- Modify: `src/parse/index.ts`

**Step 1: Write the failing test**

```ts
// tests/parse/id.test.ts
import { test, expect, describe } from "bun:test";
import { generateCommitId } from "../../src/parse/id.ts";

describe("parse/id", () => {
  test("generates 8-character hex string", () => {
    const id = generateCommitId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("generates unique IDs", () => {
    const id1 = generateCommitId();
    const id2 = generateCommitId();
    expect(id1).not.toBe(id2);
  });

  test("generates unique IDs across 100 calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCommitId()));
    expect(ids.size).toBe(100);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/parse/id.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/parse/id.ts
import { randomBytes } from "crypto";

export function generateCommitId(): string {
  return randomBytes(4).toString("hex");
}
```

**Step 4: Add to barrel export**

Add to `src/parse/index.ts`:

```ts
export { generateCommitId } from "./id.ts";
```

**Step 5: Run test to verify it passes**

Run: `bun test tests/parse/id.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/parse/id.ts tests/parse/id.test.ts src/parse/index.ts
git commit -m "feat(parse): add commit ID generator"
```

---

## Task 3: Validation

Table-driven pure unit tests. No external dependencies.

**Files:**
- Create: `tests/parse/validation.test.ts`
- Create: `src/parse/validation.ts`
- Modify: `src/parse/index.ts`

**Step 1: Write the failing tests**

```ts
// tests/parse/validation.test.ts
import { describe, test, expect } from "bun:test";
import {
  validateBranchName,
  validatePRTitle,
  validateIdentifierFormat,
  validateIdentifiers,
} from "../../src/parse/validation.ts";

describe("validateBranchName", () => {
  test("accepts valid branch names", () => {
    expect(validateBranchName("feature/my-branch")).toEqual({ ok: true });
    expect(validateBranchName("spry/username/a1b2c3d4")).toEqual({ ok: true });
    expect(validateBranchName("bugfix/issue-123")).toEqual({ ok: true });
    expect(validateBranchName("main")).toEqual({ ok: true });
    expect(validateBranchName("v1.0.0")).toEqual({ ok: true });
  });

  test("rejects empty branch name", () => {
    const result = validateBranchName("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot be empty");
  });

  test("rejects branch names with spaces", () => {
    const result = validateBranchName("my branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot contain spaces");
  });

  test("rejects branch names with control characters", () => {
    const result = validateBranchName("branch\x00name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("control characters");
  });

  test("rejects branch names with forbidden characters", () => {
    for (const char of ["~", "^", ":", "?", "*", "[", "\\", "..", "@{"]) {
      const result = validateBranchName(`branch${char}name`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`cannot contain '${char}'`);
    }
  });

  test("rejects branch names starting with slash", () => {
    const result = validateBranchName("/feature/branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot start with '/'");
  });

  test("rejects branch names ending with slash", () => {
    const result = validateBranchName("feature/branch/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot end with '/'");
  });

  test("rejects branch names ending with .lock", () => {
    const result = validateBranchName("branch.lock");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot end with '.lock'");
  });

  test("rejects branch names with consecutive slashes", () => {
    const result = validateBranchName("feature//branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("consecutive slashes");
  });

  test("rejects branch names exceeding 255 characters", () => {
    const result = validateBranchName("a".repeat(256));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("too long");
      expect(result.error).toContain("256");
    }
  });
});

describe("validatePRTitle", () => {
  test("accepts valid PR titles", () => {
    expect(validatePRTitle("Add new feature")).toEqual({ ok: true });
    expect(validatePRTitle("Fix bug in authentication")).toEqual({ ok: true });
    expect(validatePRTitle("Title with: special (chars) #123")).toEqual({ ok: true });
    expect(validatePRTitle("Title with\nnewlines\nis okay")).toEqual({ ok: true });
  });

  test("rejects empty PR titles", () => {
    const result = validatePRTitle("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cannot be empty");
      expect(result.error).toContain("sp group");
    }
  });

  test("rejects whitespace-only PR titles", () => {
    const result = validatePRTitle("   \t  ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot be empty");
  });

  test("rejects PR titles with control characters", () => {
    const result = validatePRTitle("Title with \x00 null");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("control characters");
  });

  test("rejects PR titles exceeding 500 characters", () => {
    const result = validatePRTitle("a".repeat(501));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("too long");
      expect(result.error).toContain("501");
    }
  });
});

describe("validateIdentifierFormat", () => {
  test("accepts valid hex identifiers", () => {
    expect(validateIdentifierFormat("a1b2c3d4")).toEqual({ ok: true });
    expect(validateIdentifierFormat("abc123")).toEqual({ ok: true });
    expect(validateIdentifierFormat("deadbeef")).toEqual({ ok: true });
  });

  test("accepts valid group IDs", () => {
    expect(validateIdentifierFormat("group-a1b2c3d4")).toEqual({ ok: true });
    expect(validateIdentifierFormat("my-group-abc123")).toEqual({ ok: true });
  });

  test("rejects empty identifiers", () => {
    const result = validateIdentifierFormat("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot be empty");
  });

  test("rejects identifiers that are too short", () => {
    const result = validateIdentifierFormat("abc");
    expect(result.ok).toBe(false);
  });

  test("rejects identifiers exceeding 100 characters", () => {
    const result = validateIdentifierFormat("a".repeat(101));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("too long");
  });

  test("rejects uppercase hex", () => {
    const result = validateIdentifierFormat("DEADBEEF");
    expect(result.ok).toBe(false);
  });

  test("rejects group IDs without hex suffix", () => {
    const result = validateIdentifierFormat("group-name");
    expect(result.ok).toBe(false);
  });
});

describe("validateIdentifiers", () => {
  test("returns empty array for all valid identifiers", () => {
    expect(validateIdentifiers(["abc123", "deadbeef"])).toEqual([]);
  });

  test("returns errors for invalid identifiers", () => {
    const errors = validateIdentifiers(["abc123", "NOT@VALID", "xyz"]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("handles empty array", () => {
    expect(validateIdentifiers([])).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/parse/validation.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/parse/validation.ts
import type { ValidationResult } from "./types.ts";

export function validateBranchName(name: string): ValidationResult {
  if (!name || name.length === 0) {
    return { ok: false, error: "Branch name cannot be empty" };
  }

  if (name.length > 255) {
    return { ok: false, error: `Branch name too long (${name.length} chars). Maximum is 255 characters.` };
  }

  if (name.includes(" ")) {
    return { ok: false, error: "Branch name cannot contain spaces" };
  }

  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 32 || code === 127) {
      return { ok: false, error: `Branch name cannot contain control characters (found at position ${i})` };
    }
  }

  const forbidden = ["~", "^", ":", "?", "*", "[", "\\", "..", "@{"];
  for (const char of forbidden) {
    if (name.includes(char)) {
      return { ok: false, error: `Branch name cannot contain '${char}'` };
    }
  }

  if (name.startsWith("/")) return { ok: false, error: "Branch name cannot start with '/'" };
  if (name.endsWith("/")) return { ok: false, error: "Branch name cannot end with '/'" };
  if (name.endsWith(".lock")) return { ok: false, error: "Branch name cannot end with '.lock'" };
  if (name.includes("//")) return { ok: false, error: "Branch name cannot contain consecutive slashes '//'" };

  return { ok: true };
}

export function validatePRTitle(title: string): ValidationResult {
  if (!title || title.trim().length === 0) {
    return {
      ok: false,
      error: "PR title cannot be empty. Use 'sp group' to set a title, or pass --allow-untitled-pr to use the first commit subject.",
    };
  }

  const trimmed = title.trim();

  if (trimmed.length > 500) {
    return { ok: false, error: `PR title too long (${trimmed.length} chars). Maximum is 500 characters.` };
  }

  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if ((code < 32 && code !== 10 && code !== 13) || code === 127) {
      return { ok: false, error: `PR title cannot contain control characters (found at position ${i})` };
    }
  }

  return { ok: true };
}

export function validateIdentifierFormat(identifier: string): ValidationResult {
  if (!identifier || identifier.length === 0) {
    return { ok: false, error: "Identifier cannot be empty" };
  }

  if (identifier.length > 100) {
    return { ok: false, error: `Identifier too long (${identifier.length} chars). Maximum is 100 characters.` };
  }

  // Hex strings (commit hashes, spry IDs): 4-40 chars
  if (/^[0-9a-f]{4,40}$/.test(identifier)) return { ok: true };

  // Group IDs: word chars + dashes, ending in hex suffix
  if (/^[\w-]+-[0-9a-f]{4,}$/.test(identifier)) return { ok: true };

  return {
    ok: false,
    error: `Invalid identifier format: '${identifier}'. Expected hex string (4-40 chars) or group ID (name-hexsuffix).`,
  };
}

export function validateIdentifiers(identifiers: string[]): ValidationResult[] {
  const errors: ValidationResult[] = [];
  for (const id of identifiers) {
    const result = validateIdentifierFormat(id);
    if (!result.ok) errors.push(result);
  }
  return errors;
}
```

**Step 4: Add to barrel export**

Add to `src/parse/index.ts`:

```ts
export { validateBranchName, validatePRTitle, validateIdentifierFormat, validateIdentifiers } from "./validation.ts";
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/parse/validation.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/parse/validation.ts tests/parse/validation.test.ts src/parse/index.ts
git commit -m "feat(parse): add input validation (branch names, PR titles, identifiers)"
```

---

## Task 4: Title Resolution

**Files:**
- Create: `tests/parse/title.test.ts`
- Create: `src/parse/title.ts`
- Modify: `src/parse/index.ts`

**Step 1: Write the failing tests**

```ts
// tests/parse/title.test.ts
import { test, expect, describe } from "bun:test";
import { resolveUnitTitle, hasStoredTitle } from "../../src/parse/title.ts";
import type { PRUnit } from "../../src/parse/types.ts";

function makeUnit(overrides: Partial<PRUnit> = {}): PRUnit {
  return {
    type: "single",
    id: "abc123",
    title: "Default title",
    commitIds: ["abc123"],
    commits: ["abc123def"],
    subjects: ["Default title"],
    ...overrides,
  };
}

describe("resolveUnitTitle", () => {
  test("returns stored title when available", () => {
    const unit = makeUnit({ type: "group", title: "My Group Title", subjects: ["First", "Second"] });
    expect(resolveUnitTitle(unit)).toBe("My Group Title");
  });

  test("falls back to first subject when title is undefined", () => {
    const unit = makeUnit({ type: "group", title: undefined, subjects: ["First commit", "Second commit"] });
    expect(resolveUnitTitle(unit)).toBe("First commit");
  });

  test("returns Untitled when no title and no subjects", () => {
    const unit = makeUnit({ type: "group", title: undefined, commitIds: [], commits: [], subjects: [] });
    expect(resolveUnitTitle(unit)).toBe("Untitled");
  });

  test("empty string title falls back to first subject", () => {
    const unit = makeUnit({ title: "", subjects: ["Fallback subject"] });
    expect(resolveUnitTitle(unit)).toBe("Fallback subject");
  });
});

describe("hasStoredTitle", () => {
  test("returns true when title is defined", () => {
    expect(hasStoredTitle(makeUnit({ title: "My Title" }))).toBe(true);
  });

  test("returns false when title is undefined", () => {
    expect(hasStoredTitle(makeUnit({ title: undefined }))).toBe(false);
  });

  test("returns true for empty string (explicitly set)", () => {
    expect(hasStoredTitle(makeUnit({ title: "" }))).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/parse/title.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/parse/title.ts
import type { PRUnit } from "./types.ts";

export function resolveUnitTitle(unit: PRUnit): string {
  if (unit.title) return unit.title;
  return unit.subjects[0] ?? "Untitled";
}

export function hasStoredTitle(unit: PRUnit): boolean {
  return unit.title !== undefined;
}
```

**Step 4: Add to barrel export**

Add to `src/parse/index.ts`:

```ts
export { resolveUnitTitle, hasStoredTitle } from "./title.ts";
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/parse/title.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/parse/title.ts tests/parse/title.test.ts src/parse/index.ts
git commit -m "feat(parse): add title resolution for PRUnits"
```

---

## Task 5: Trailer Parsing

Uses `GitRunner` DI. Tests create real git repos via the test lib.

**Files:**
- Create: `tests/parse/trailers.test.ts`
- Create: `src/parse/trailers.ts`
- Modify: `src/parse/index.ts`

**Step 1: Write the failing tests**

```ts
// tests/parse/trailers.test.ts
import { test, expect, describe, afterAll } from "bun:test";
import { parseTrailers, addTrailers } from "../../src/parse/trailers.ts";
import { createRealGitRunner } from "../../tests/lib/index.ts";

const git = createRealGitRunner();

describe("parseTrailers", () => {
  test("returns empty object for empty body", async () => {
    expect(await parseTrailers("", git)).toEqual({});
  });

  test("returns empty object for whitespace-only body", async () => {
    expect(await parseTrailers("   \n\n   ", git)).toEqual({});
  });

  test("returns empty object for body without trailers", async () => {
    const body = "This is a commit message\n\nWith description but no trailers.";
    expect(await parseTrailers(body, git)).toEqual({});
  });

  test("parses single trailer", async () => {
    const body = "Add feature\n\nSpry-Commit-Id: a1b2c3d4";
    const trailers = await parseTrailers(body, git);
    expect(trailers).toEqual({ "Spry-Commit-Id": "a1b2c3d4" });
  });

  test("parses multiple trailers", async () => {
    const body = "Add feature\n\nSpry-Commit-Id: a1b2c3d4\nSpry-Group: f7e8d9c0";
    const trailers = await parseTrailers(body, git);
    expect(trailers).toEqual({
      "Spry-Commit-Id": "a1b2c3d4",
      "Spry-Group": "f7e8d9c0",
    });
  });

  test("handles trailers with colons in value", async () => {
    const body = "Add config\n\nConfig-Value: key:value:with:colons";
    const trailers = await parseTrailers(body, git);
    expect(trailers["Config-Value"]).toBe("key:value:with:colons");
  });

  test("uses last value when key appears multiple times", async () => {
    const body = "Commit\n\nSpry-Commit-Id: first\nSpry-Commit-Id: second\nSpry-Commit-Id: third";
    const trailers = await parseTrailers(body, git);
    expect(trailers["Spry-Commit-Id"]).toBe("third");
  });
});

describe("addTrailers", () => {
  test("adds single trailer to message", async () => {
    const result = await addTrailers("Add feature\n\nSome description.", { "Spry-Commit-Id": "a1b2c3d4" }, git);
    expect(result).toContain("Spry-Commit-Id: a1b2c3d4");
    expect(result).toContain("Add feature");
  });

  test("adds multiple trailers", async () => {
    const result = await addTrailers("Add feature", { "Spry-Commit-Id": "a1b2c3d4", "Spry-Group": "f7e8d9c0" }, git);
    expect(result).toContain("Spry-Commit-Id: a1b2c3d4");
    expect(result).toContain("Spry-Group: f7e8d9c0");
  });

  test("returns original message when no trailers provided", async () => {
    const message = "Add feature\n\nSome description.";
    expect(await addTrailers(message, {}, git)).toBe(message);
  });

  test("roundtrip: added trailers can be parsed back", async () => {
    const withTrailers = await addTrailers("Add feature", { "Spry-Commit-Id": "a1b2c3d4", "Spry-Group": "f7e8d9c0" }, git);
    const parsed = await parseTrailers(withTrailers, git);
    expect(parsed["Spry-Commit-Id"]).toBe("a1b2c3d4");
    expect(parsed["Spry-Group"]).toBe("f7e8d9c0");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/parse/trailers.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/parse/trailers.ts
import type { GitRunner } from "../../tests/lib/context.ts";
import type { CommitTrailers } from "./types.ts";

export async function parseTrailers(commitBody: string, git: GitRunner): Promise<CommitTrailers> {
  if (!commitBody.trim()) return {};

  const result = await git.run(["interpret-trailers", "--parse", "--no-divider"], {
    stdin: commitBody,
  });

  if (!result.stdout.trim()) return {};

  const trailers: CommitTrailers = {};
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (key) trailers[key] = value;
  }

  return trailers;
}

export async function addTrailers(
  message: string,
  trailers: Record<string, string>,
  git: GitRunner,
): Promise<string> {
  if (Object.keys(trailers).length === 0) return message;

  const args = ["interpret-trailers"];
  for (const [key, value] of Object.entries(trailers)) {
    args.push("--trailer", `${key}: ${value}`);
  }

  const normalizedMessage = message.endsWith("\n") ? message : message + "\n";
  const result = await git.run(args, { stdin: normalizedMessage });
  return result.stdout.trimEnd();
}
```

**Important:** This requires adding `stdin` support to `GitRunner`. The current `CommandOptions` interface in `tests/lib/context.ts` doesn't have a `stdin` field. We need to add it:

In `tests/lib/context.ts`, add `stdin?: string` to `CommandOptions`.

In `tests/lib/git-runner.ts`, pipe stdin to the process when provided:

```ts
// Updated createRealGitRunner
export function createRealGitRunner(): GitRunner {
  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      let proc = $`git ${args}`.nothrow().quiet();
      if (options?.cwd) proc = proc.cwd(options.cwd);
      if (options?.env) proc = proc.env(options.env);
      if (options?.stdin) proc = proc.stdin(Buffer.from(options.stdin));
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

Note: `trailers.ts` imports `GitRunner` from the test lib context. This is a temporary coupling — when `src/` defines its own context/DI later (Git operations phase), the import will move. For now the test lib owns the interface definition and that's fine.

**Step 4: Add to barrel export**

Add to `src/parse/index.ts`:

```ts
export { parseTrailers, addTrailers } from "./trailers.ts";
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/parse/trailers.test.ts`
Expected: PASS

**Step 6: Run all tests to check nothing broke**

Run: `bun test`
Expected: All tests PASS (existing 47 + new trailer tests)

**Step 7: Commit**

```bash
git add src/parse/trailers.ts tests/parse/trailers.test.ts src/parse/index.ts tests/lib/context.ts tests/lib/git-runner.ts
git commit -m "feat(parse): add trailer parsing via GitRunner DI

Adds stdin support to GitRunner/CommandOptions to pipe commit
message bodies to git interpret-trailers."
```

---

## Task 6: Stack Parsing (detectPRUnits + parseStack)

Pure unit tests with hand-crafted commit data. No external dependencies.

**Files:**
- Create: `tests/parse/stack.test.ts`
- Create: `src/parse/stack.ts`
- Modify: `src/parse/index.ts`

**Step 1: Write the failing tests**

```ts
// tests/parse/stack.test.ts
import { test, expect, describe } from "bun:test";
import { detectPRUnits, parseStack, type CommitWithTrailers } from "../../src/parse/stack.ts";

function makeCommit(
  hash: string,
  subject: string,
  trailers: Record<string, string> = {},
): CommitWithTrailers {
  return { hash, subject, body: subject, trailers };
}

describe("detectPRUnits", () => {
  test("returns empty array for empty commits", () => {
    expect(detectPRUnits([])).toEqual([]);
  });

  test("creates singles for commits without group trailers", () => {
    const commits = [
      makeCommit("aaa111", "Add user model", { "Spry-Commit-Id": "a1b2c3d4" }),
      makeCommit("bbb222", "Add auth", { "Spry-Commit-Id": "b2c3d4e5" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ type: "single", id: "a1b2c3d4", commits: ["aaa111"] });
    expect(units[1]).toMatchObject({ type: "single", id: "b2c3d4e5", commits: ["bbb222"] });
  });

  test("creates group for contiguous commits with same Spry-Group", () => {
    const commits = [
      makeCommit("aaa111", "Start auth", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "Add login", { "Spry-Commit-Id": "b2", "Spry-Group": "g1" }),
      makeCommit("ccc333", "Add 2FA", { "Spry-Commit-Id": "c3", "Spry-Group": "g1" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      type: "group",
      id: "g1",
      commits: ["aaa111", "bbb222", "ccc333"],
    });
  });

  test("handles mixed singles and groups", () => {
    const commits = [
      makeCommit("aaa111", "Single", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "Group start", { "Spry-Commit-Id": "b2", "Spry-Group": "g1" }),
      makeCommit("ccc333", "Group end", { "Spry-Commit-Id": "c3", "Spry-Group": "g1" }),
      makeCommit("ddd444", "Another single", { "Spry-Commit-Id": "d4" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(3);
    expect(units[0]).toMatchObject({ type: "single", id: "a1" });
    expect(units[1]).toMatchObject({ type: "group", id: "g1" });
    expect(units[2]).toMatchObject({ type: "single", id: "d4" });
  });

  test("handles multiple consecutive groups", () => {
    const commits = [
      makeCommit("aaa111", "G1 c1", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "G1 c2", { "Spry-Commit-Id": "b2", "Spry-Group": "g1" }),
      makeCommit("ccc333", "G2 c1", { "Spry-Commit-Id": "c3", "Spry-Group": "g2" }),
      makeCommit("ddd444", "G2 c2", { "Spry-Commit-Id": "d4", "Spry-Group": "g2" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ type: "group", id: "g1" });
    expect(units[1]).toMatchObject({ type: "group", id: "g2" });
  });

  test("handles commits without Spry-Commit-Id (uses hash prefix)", () => {
    const commits = [makeCommit("aaa111bb", "No ID", {})];
    const units = detectPRUnits(commits);
    expect(units[0]).toMatchObject({ id: "aaa111bb", commitIds: [] });
  });

  test("preserves oldest-first order", () => {
    const commits = [
      makeCommit("first", "First", { "Spry-Commit-Id": "id1" }),
      makeCommit("second", "Second", { "Spry-Commit-Id": "id2" }),
      makeCommit("third", "Third", { "Spry-Commit-Id": "id3" }),
    ];
    expect(detectPRUnits(commits).map((u) => u.commits[0])).toEqual(["first", "second", "third"]);
  });

  test("single-commit group", () => {
    const commits = [
      makeCommit("aaa111", "Lone grouped", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
    ];
    const units = detectPRUnits(commits);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ type: "group", id: "g1" });
  });

  test("uses title from GroupTitles when provided", () => {
    const commits = [
      makeCommit("aaa111", "First subject", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
    ];
    const units = detectPRUnits(commits, { g1: "Custom Title" });
    expect(units[0]?.title).toBe("Custom Title");
  });

  test("title is undefined when no GroupTitles entry", () => {
    const commits = [
      makeCommit("aaa111", "First subject", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
    ];
    const units = detectPRUnits(commits, {});
    expect(units[0]?.title).toBeUndefined();
  });

  test("single commits use their subject as title", () => {
    const commits = [makeCommit("aaa111", "My commit", { "Spry-Commit-Id": "a1" })];
    expect(detectPRUnits(commits)[0]?.title).toBe("My commit");
  });
});

describe("parseStack", () => {
  test("returns ok for valid stack", () => {
    const commits = [
      makeCommit("aaa111", "First", { "Spry-Commit-Id": "a1" }),
      makeCommit("bbb222", "Second", { "Spry-Commit-Id": "b2" }),
    ];
    const result = parseStack(commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.units).toHaveLength(2);
  });

  test("returns ok for valid groups", () => {
    const commits = [
      makeCommit("aaa111", "G1", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "G1", { "Spry-Commit-Id": "b2", "Spry-Group": "g1" }),
    ];
    const result = parseStack(commits);
    expect(result.ok).toBe(true);
  });

  test("returns split-group error for non-contiguous group", () => {
    const commits = [
      makeCommit("aaa111", "Group c1", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "Interrupting", { "Spry-Commit-Id": "b2" }),
      makeCommit("ccc333", "Group c2", { "Spry-Commit-Id": "c3", "Spry-Group": "g1" }),
    ];
    const result = parseStack(commits);
    expect(result).toMatchObject({ ok: false, error: "split-group", group: { id: "g1" } });
    if (!result.ok && result.error === "split-group") {
      expect(result.group.commits).toContain("aaa111");
      expect(result.group.commits).toContain("ccc333");
      expect(result.interruptingCommits).toContain("bbb222");
    }
  });

  test("split-group with multiple interrupting commits", () => {
    const commits = [
      makeCommit("aaa111", "Group c1", { "Spry-Commit-Id": "a1", "Spry-Group": "g1" }),
      makeCommit("bbb222", "Int 1", { "Spry-Commit-Id": "b2" }),
      makeCommit("ccc333", "Int 2", { "Spry-Commit-Id": "c3" }),
      makeCommit("ddd444", "Group c2", { "Spry-Commit-Id": "d4", "Spry-Group": "g1" }),
    ];
    const result = parseStack(commits);
    expect(result).toMatchObject({ ok: false, error: "split-group" });
    if (!result.ok && result.error === "split-group") {
      expect(result.interruptingCommits).toHaveLength(2);
    }
  });

  test("returns ok for empty commits", () => {
    const result = parseStack([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.units).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/parse/stack.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/parse/stack.ts
import type { CommitTrailers, PRUnit, GroupTitles, StackParseResult } from "./types.ts";

export interface CommitWithTrailers {
  hash: string;
  subject: string;
  body: string;
  trailers: CommitTrailers;
}

export function detectPRUnits(commits: CommitWithTrailers[], titles: GroupTitles = {}): PRUnit[] {
  const units: PRUnit[] = [];
  let currentGroup: PRUnit | null = null;

  for (const commit of commits) {
    const commitId = commit.trailers["Spry-Commit-Id"];
    const groupId = commit.trailers["Spry-Group"];

    if (groupId) {
      if (currentGroup && currentGroup.id === groupId) {
        if (commitId) currentGroup.commitIds.push(commitId);
        currentGroup.commits.push(commit.hash);
        currentGroup.subjects.push(commit.subject);
      } else {
        if (currentGroup) units.push(currentGroup);
        currentGroup = {
          type: "group",
          id: groupId,
          title: titles[groupId],
          commitIds: commitId ? [commitId] : [],
          commits: [commit.hash],
          subjects: [commit.subject],
        };
      }
    } else {
      if (currentGroup) {
        units.push(currentGroup);
        currentGroup = null;
      }
      units.push({
        type: "single",
        id: commitId || commit.hash.slice(0, 8),
        title: commit.subject,
        commitIds: commitId ? [commitId] : [],
        commits: [commit.hash],
        subjects: [commit.subject],
      });
    }
  }

  if (currentGroup) units.push(currentGroup);
  return units;
}

export function parseStack(
  commits: CommitWithTrailers[],
  titles: GroupTitles = {},
): StackParseResult {
  const groupPositions = new Map<string, number[]>();
  const groupCommits = new Map<string, string[]>();

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    if (!commit) continue;
    const groupId = commit.trailers["Spry-Group"];
    if (groupId) {
      const positions = groupPositions.get(groupId) || [];
      positions.push(i);
      groupPositions.set(groupId, positions);
      const hashes = groupCommits.get(groupId) || [];
      hashes.push(commit.hash);
      groupCommits.set(groupId, hashes);
    }
  }

  for (const [groupId, positions] of groupPositions) {
    if (positions.length < 2) continue;
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1]!;
      const curr = positions[i]!;
      if (curr !== prev + 1) {
        const interruptingCommits: string[] = [];
        for (let j = prev + 1; j < curr; j++) {
          const c = commits[j];
          if (c) interruptingCommits.push(c.hash);
        }
        const firstHash = groupCommits.get(groupId)?.[0];
        const firstCommit = commits.find((c) => c.hash === firstHash);
        const groupTitle: string = titles[groupId] ?? firstCommit?.subject ?? "Unknown";

        return {
          ok: false,
          error: "split-group",
          group: {
            id: groupId,
            title: groupTitle,
            commits: groupCommits.get(groupId) || [],
          },
          interruptingCommits,
        };
      }
    }
  }

  return { ok: true, units: detectPRUnits(commits, titles) };
}
```

**Step 4: Add to barrel export**

Add to `src/parse/index.ts`:

```ts
export { detectPRUnits, parseStack } from "./stack.ts";
export type { CommitWithTrailers } from "./stack.ts";
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/parse/stack.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/parse/stack.ts tests/parse/stack.test.ts src/parse/index.ts
git commit -m "feat(parse): add PRUnit detection and stack validation"
```

---

## Task 7: Identifier Resolution

**Files:**
- Create: `tests/parse/identifier.test.ts`
- Create: `src/parse/identifier.ts`
- Modify: `src/parse/index.ts`

**Step 1: Write the failing tests**

```ts
// tests/parse/identifier.test.ts
import { test, expect, describe } from "bun:test";
import {
  resolveIdentifier,
  resolveIdentifiers,
  formatResolutionError,
  parseApplySpec,
  resolveUpTo,
} from "../../src/parse/identifier.ts";
import type { PRUnit, CommitInfo } from "../../src/parse/types.ts";

function makeCommit(hash: string, subject: string, spryId?: string): CommitInfo {
  return {
    hash,
    subject,
    body: "",
    trailers: spryId ? { "Spry-Commit-Id": spryId } : {},
  };
}

function makeSingle(id: string, commits: string[]): PRUnit {
  return {
    type: "single",
    id,
    title: `Commit ${id}`,
    commitIds: [id],
    commits,
    subjects: [`Commit ${id}`],
  };
}

function makeGroup(id: string, commits: string[], commitIds: string[]): PRUnit {
  return {
    type: "group",
    id,
    title: `Group ${id}`,
    commitIds,
    commits,
    subjects: commits.map((_, i) => `Commit ${i + 1}`),
  };
}

describe("resolveIdentifier", () => {
  const commits: CommitInfo[] = [
    makeCommit("aaa111222333444555666777888999000aaabbbccc", "First", "abc12345"),
    makeCommit("bbb222333444555666777888999000aaabbbcccddd", "Second", "def67890"),
    makeCommit("ccc333444555666777888999000aaabbbcccdddeee", "Third", "ghi11111"),
  ];

  const units: PRUnit[] = [
    makeSingle("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
    makeSingle("def67890", ["bbb222333444555666777888999000aaabbbcccddd"]),
    makeSingle("ghi11111", ["ccc333444555666777888999000aaabbbcccdddeee"]),
  ];

  test("resolves exact Spry-Commit-Id", () => {
    const result = resolveIdentifier("abc12345", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("abc12345");
  });

  test("resolves Spry-Commit-Id prefix", () => {
    const result = resolveIdentifier("abc", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("abc12345");
  });

  test("resolves full git hash", () => {
    const result = resolveIdentifier("aaa111222333444555666777888999000aaabbbccc", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("abc12345");
  });

  test("resolves short git hash", () => {
    const result = resolveIdentifier("aaa1112", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("abc12345");
  });

  test("returns not-found for unknown identifier", () => {
    const result = resolveIdentifier("xyz99999", units, commits);
    expect(result).toMatchObject({ ok: false, error: "not-found", identifier: "xyz99999" });
  });

  test("returns ambiguous when multiple unit IDs match prefix", () => {
    const similarUnits = [
      makeSingle("test1234", ["aaa111222333444555666777888999000aaabbbccc"]),
      makeSingle("test5678", ["bbb222333444555666777888999000aaabbbcccddd"]),
    ];
    const result = resolveIdentifier("test", similarUnits, commits);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === "ambiguous") {
      expect(result.matches).toContain("test1234");
      expect(result.matches).toContain("test5678");
    }
  });

  test("resolves group ID", () => {
    const groupUnits = [
      makeGroup("grp00001", ["aaa111222333444555666777888999000aaabbbccc", "bbb222333444555666777888999000aaabbbcccddd"], ["abc12345", "def67890"]),
    ];
    const result = resolveIdentifier("grp00001", groupUnits, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.type).toBe("group");
  });

  test("resolves commit hash to containing group", () => {
    const groupUnits = [
      makeGroup("grp00001", ["aaa111222333444555666777888999000aaabbbccc", "bbb222333444555666777888999000aaabbbcccddd"], ["abc12345", "def67890"]),
    ];
    const result = resolveIdentifier("bbb2223", groupUnits, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unit.id).toBe("grp00001");
  });
});

describe("resolveIdentifiers", () => {
  const commits = [
    makeCommit("aaa111222333444555666777888999000aaabbbccc", "First", "abc12345"),
    makeCommit("bbb222333444555666777888999000aaabbbcccddd", "Second", "def67890"),
  ];
  const units = [
    makeSingle("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
    makeSingle("def67890", ["bbb222333444555666777888999000aaabbbcccddd"]),
  ];

  test("resolves multiple identifiers", () => {
    const result = resolveIdentifiers(["abc12345", "def67890"], units, commits);
    expect(result.errors).toHaveLength(0);
    expect(result.unitIds.has("abc12345")).toBe(true);
    expect(result.unitIds.has("def67890")).toBe(true);
  });

  test("deduplicates same unit matched via different identifiers", () => {
    const result = resolveIdentifiers(["abc12345", "aaa1112"], units, commits);
    expect(result.unitIds.size).toBe(1);
  });

  test("collects errors for unresolvable identifiers", () => {
    const result = resolveIdentifiers(["abc12345", "invalid"], units, commits);
    expect(result.errors).toHaveLength(1);
    expect(result.unitIds.size).toBe(1);
  });
});

describe("formatResolutionError", () => {
  test("formats not-found error", () => {
    const msg = formatResolutionError({ ok: false, error: "not-found", identifier: "xyz" });
    expect(msg).toContain("xyz");
    expect(msg).toContain("found in stack");
  });

  test("formats ambiguous error", () => {
    const msg = formatResolutionError({ ok: false, error: "ambiguous", identifier: "abc", matches: ["abc123", "abc456"] });
    expect(msg).toContain("matches multiple");
  });
});

describe("parseApplySpec", () => {
  test("parses valid JSON array", () => {
    expect(parseApplySpec('["abc123", "def456"]')).toEqual(["abc123", "def456"]);
  });

  test("parses empty array", () => {
    expect(parseApplySpec("[]")).toEqual([]);
  });

  test("throws on invalid JSON", () => {
    expect(() => parseApplySpec("not json")).toThrow("Invalid --apply format");
  });

  test("throws on non-array", () => {
    expect(() => parseApplySpec('{"key": "value"}')).toThrow("Invalid --apply format");
  });

  test("throws on array with non-strings", () => {
    expect(() => parseApplySpec('[123, "abc"]')).toThrow("All items must be strings");
  });
});

describe("resolveUpTo", () => {
  const commits = [
    makeCommit("aaa111222333444555666777888999000aaabbbccc", "First", "abc12345"),
    makeCommit("bbb222333444555666777888999000aaabbbcccddd", "Second", "def67890"),
    makeCommit("ccc333444555666777888999000aaabbbcccdddeee", "Third", "ghi11111"),
  ];
  const units = [
    makeSingle("abc12345", ["aaa111222333444555666777888999000aaabbbccc"]),
    makeSingle("def67890", ["bbb222333444555666777888999000aaabbbcccddd"]),
    makeSingle("ghi11111", ["ccc333444555666777888999000aaabbbcccdddeee"]),
  ];

  test("returns only first unit when specifying first", () => {
    const result = resolveUpTo("abc12345", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unitIds.size).toBe(1);
      expect(result.unitIds.has("abc12345")).toBe(true);
    }
  });

  test("returns first two units when specifying second", () => {
    const result = resolveUpTo("def67890", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unitIds.size).toBe(2);
  });

  test("returns all units when specifying last", () => {
    const result = resolveUpTo("ghi11111", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unitIds.size).toBe(3);
  });

  test("returns error for unknown identifier", () => {
    const result = resolveUpTo("unknown", units, commits);
    expect(result.ok).toBe(false);
  });

  test("works with git hash prefix", () => {
    const result = resolveUpTo("bbb2223", units, commits);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unitIds.has("def67890")).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/parse/identifier.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/parse/identifier.ts
import type { PRUnit, CommitInfo, IdentifierResolution, UpToResolution } from "./types.ts";
import { validateIdentifiers } from "./validation.ts";

export function resolveIdentifier(
  identifier: string,
  units: PRUnit[],
  commits: CommitInfo[],
): IdentifierResolution {
  // Exact match on unit ID
  const exactMatch = units.find((u) => u.id === identifier);
  if (exactMatch) return { ok: true, unit: exactMatch };

  // Prefix match on unit ID
  const prefixMatches = units.filter((u) => u.id.startsWith(identifier));
  if (prefixMatches.length === 1) return { ok: true, unit: prefixMatches[0]! };
  if (prefixMatches.length > 1) {
    return { ok: false, error: "ambiguous", identifier, matches: prefixMatches.map((u) => u.id) };
  }

  // Git commit hash match
  const hashMatches = commits.filter((c) => c.hash.startsWith(identifier));
  if (hashMatches.length === 0) return { ok: false, error: "not-found", identifier };
  if (hashMatches.length > 1) {
    return { ok: false, error: "ambiguous", identifier, matches: hashMatches.map((c) => c.hash.slice(0, 8)) };
  }

  const matchedHash = hashMatches[0]!.hash;
  const unitForCommit = units.find((u) => u.commits.includes(matchedHash));
  if (!unitForCommit) return { ok: false, error: "not-found", identifier };

  return { ok: true, unit: unitForCommit };
}

export function resolveIdentifiers(
  identifiers: string[],
  units: PRUnit[],
  commits: CommitInfo[],
): { unitIds: Set<string>; errors: IdentifierResolution[] } {
  const unitIds = new Set<string>();
  const errors: IdentifierResolution[] = [];

  for (const id of identifiers) {
    const result = resolveIdentifier(id, units, commits);
    if (result.ok) unitIds.add(result.unit.id);
    else errors.push(result);
  }

  return { unitIds, errors };
}

export function formatResolutionError(error: IdentifierResolution): string {
  if (error.ok) return "";
  switch (error.error) {
    case "not-found":
      return `Error: No commit or group matching '${error.identifier}' found in stack`;
    case "ambiguous":
      return `Error: '${error.identifier}' matches multiple commits. Please provide more characters to disambiguate.\n  Matches: ${error.matches.join(", ")}`;
  }
}

export function parseApplySpec(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid --apply format. Expected JSON array of identifiers.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid --apply format. Expected JSON array of identifiers.");
  }

  for (const item of parsed) {
    if (typeof item !== "string") {
      throw new Error("Invalid --apply format. All items must be strings.");
    }
  }

  const identifiers = parsed as string[];
  const validationErrors = validateIdentifiers(identifiers);
  if (validationErrors.length > 0) {
    const firstError = validationErrors[0];
    if (firstError && !firstError.ok) throw new Error(firstError.error);
  }

  return identifiers;
}

export function resolveUpTo(
  identifier: string,
  units: PRUnit[],
  commits: CommitInfo[],
): UpToResolution {
  const result = resolveIdentifier(identifier, units, commits);
  if (!result.ok) return { ok: false, error: result };

  const targetUnit = result.unit;
  const unitIds = new Set<string>();

  for (const unit of units) {
    unitIds.add(unit.id);
    if (unit.id === targetUnit.id) break;
  }

  return { ok: true, unitIds };
}
```

**Step 4: Add to barrel export**

Add to `src/parse/index.ts`:

```ts
export { resolveIdentifier, resolveIdentifiers, formatResolutionError, parseApplySpec, resolveUpTo } from "./identifier.ts";
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/parse/identifier.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/parse/identifier.ts tests/parse/identifier.test.ts src/parse/index.ts
git commit -m "feat(parse): add identifier resolution for targeting stack units"
```

---

## Task 8: Full Test Suite + Changelog

Run the complete test suite, update changelog, final commit.

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests PASS (47 existing + new parse tests)

**Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: PASS

**Step 3: Run lint**

Run: `bunx oxlint`
Expected: PASS (or only pre-existing warnings)

**Step 4: Update CHANGELOG.md**

Under `## [Unreleased]`, add:

```markdown
### Added
- `src/parse/` module: types, trailer parsing, stack detection, commit ID generation, title resolution, identifier resolution, input validation
```

**Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: update changelog for core parsing module"
```

**Step 6: Push**

```bash
git push
```
