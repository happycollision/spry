# sp view (local) Design

Date: 2026-02-27

## Scope

Phase 2 Step 3 of the test-first rebuild. First command, first doc-producing tests.

**In scope:** CLI entry point, `sp view` command handler, stack formatter (plain text output), auto-generated group titles, batch trailer parsing helper.

**Out of scope:** GitHub enrichment (Step 5), `--all` flag (future: show all local stacks, separate feature), `--mock` flag (dropped), group title storage (deferred to `sp group`).

**New dependencies:** `commander` (CLI framework, type-safe option parsing), `kleur` (terminal colors, respects `NO_COLOR`).

## Architecture: Command + Formatter

Two layers:

1. **Command** (`src/commands/view.ts`) — orchestrates data loading via DI, calls formatter, prints output.
2. **Formatter** (`src/ui/format.ts`) — pure functions: PRUnits in, string out. No git calls, no side effects.

The formatter is trivially testable with unit tests. The command is tested via integration tests against real repos.

## Design Decisions

1. **SpryContext for DI.** Commands receive a `SpryContext` with `git: GitRunner` (and later `gh: GhClient`). The CLI entry point creates a production context; tests create test contexts. No command creates its own runners.

2. **GitRunner moves to src/.** The `GitRunner` interface and real implementation move from `tests/lib/` to `src/lib/context.ts`. Tests re-export from there. Clean dependency direction: src/ has no test imports.

3. **Auto-generated group titles.** Groups without stored titles get sequential letters: A, B, C... Display format: `A (2 commits)`. No title storage built in this step.

4. **No PR count in header.** The old header showed "PRs: X/Y opened" — that's GitHub enrichment. Local view shows commit count only: `Stack: feature-branch (3 commits)`.

5. **commander for CLI.** Type-safe option parsing, automatic `--help` and `--version`. No `preAction` git version hook — `loadConfig()` handles version checking.

6. **kleur for colors.** Handles `NO_COLOR` / `FORCE_COLOR` automatically. Used for dim text and blue URLs.

7. **Batch trailer parsing.** New `parseCommitTrailers()` helper in `src/parse/trailers.ts` bridges `getStackCommits()` (returns `CommitInfo[]`) and `parseStack()` (expects `CommitWithTrailers[]`).

## Module: `src/lib/context.ts`

```ts
interface SpryContext {
  git: GitRunner;
  // gh: GhClient — added in Step 4
}
```

`GitRunner` interface and `createRealGitRunner()` move here from `tests/lib/`. The test lib re-exports from `src/lib/context.ts`.

## Module: `src/cli/index.ts`

CLI entry point using commander. Creates production `SpryContext` and wires commands.

```ts
#!/usr/bin/env bun
import { Command } from "commander";
import { viewCommand } from "../commands/view.ts";
import { createRealGitRunner } from "../lib/context.ts";

const program = new Command();
program.name("sp").description("Spry: Stacked PRs. Develop with alacrity.");

const ctx: SpryContext = { git: createRealGitRunner() };

program.command("view")
  .description("View the current stack of commits")
  .action(() => viewCommand(ctx));

program.parse();
```

## Module: `src/commands/view.ts`

Command handler — orchestrates data loading and output.

```ts
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

## Module: `src/ui/format.ts`

Pure formatting functions. No git calls.

### `formatStackView(units, branch, commitCount, trunkRef): string`

Output format:

```
Stack: feature-branch (3 commits)
○ no PR  ◐ open  ✓ merged  ✗ closed

  → origin/main
────────────────────────────────────────────────────────────────────────
  ○ Add login page (a1b2c3d4)
────────────────────────────────────────────────────────────────────────
  ○ A (2 commits)
    ├─ Add auth middleware (e5f6g7h8)
    └─ Add session handling (i9j0k1l2)
────────────────────────────────────────────────────────────────────────
```

Rules:
- Header: `Stack: <branch> (<N> commit[s])`
- Legend line (dimmed): status icon meanings
- Trunk ref indicator: `→ <trunkRef>`
- Separator: 72-char horizontal rule
- Single commits: `○ <subject> (<commitId>)` or `○ <subject> (no ID)`
- Groups with stored title: `○ <title>`
- Groups without stored title: `○ <letter> (<N> commits)` — sequential A, B, C...
- Group commits: tree structure with `├─` / `└─` connectors, each showing subject and commit ID
- Status icons: `○` no PR, `◐` open, `✓` merged, `✗` closed (only `○` used in local view)
- Commit IDs shown in dim text
- kleur for dim/blue styling

### `formatValidationError(result): string`

Renders split-group errors with commit details and fix suggestions. Same structure as old code.

## Addition: `src/parse/trailers.ts`

New batch helper alongside existing `parseTrailers()`:

```ts
export async function parseCommitTrailers(
  commits: CommitInfo[],
  git: GitRunner,
): Promise<CommitWithTrailers[]>
```

Maps each commit through `parseTrailers()` to produce the `CommitWithTrailers` type that `parseStack()` expects.

## Test Structure

### Formatter unit tests: `tests/ui/format.test.ts`

Pure function tests with hand-crafted PRUnit arrays. No git, no repos. Strip ANSI for assertions.

Scenarios:
- Empty stack (no commits ahead of trunk)
- Single commit with ID
- Single commit without ID (shows "no ID")
- Group with stored title
- Group without stored title (shows auto-generated letter)
- Multiple groups (letters increment: A, B, C)
- Mixed singles and groups
- Validation error formatting (split-group)

### Command integration tests: `tests/commands/view.test.ts`

Use `createRepo()` + `createRealGitRunner()` to build real repos, then call `viewCommand()` and capture output.

Scenarios:
- Empty stack (on trunk, no commits ahead)
- Stack with single commits (with and without Spry-Commit-Id trailers)
- Stack with grouped commits
- Split-group error

### Doc tests: `tests/commands/view.doc.test.ts`

Use `docTest()` + `createRunner()` to run `sp view` as a subprocess. First doc-producing tests in the rebuild.

Scenarios:
- Viewing a simple stack
- Viewing a stack with groups
- Viewing an empty stack

## File Layout

```
src/
  lib/
    context.ts              # SpryContext, GitRunner interface + real impl
  cli/
    index.ts                # CLI entry point (commander)
  commands/
    view.ts                 # viewCommand(ctx)
  ui/
    format.ts               # formatStackView, formatValidationError
  parse/
    trailers.ts             # + parseCommitTrailers batch helper (addition)
tests/
  ui/
    format.test.ts          # Pure formatter unit tests
  commands/
    view.test.ts            # Integration tests with real repos
    view.doc.test.ts        # Doc-producing tests
```
