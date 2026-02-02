# Phase 6: CLI Integration

**Goal:** Wire up the `--all` flag to the CLI and validate option compatibility.

**Status:** Not Started

**Depends on:** Phase 5

---

## What This Phase Does

1. Add `--all` flag to the `sync` command
2. Validate flag compatibility (--all cannot be used with --apply or --up-to)
3. Route to `syncAllCommand()` when `--all` is specified
4. End-to-end integration tests via CLI

---

## CLI Changes

**File:** `src/cli/index.ts`

```typescript
program
  .command("sync")
  .description("Sync stack with GitHub: add IDs, push branches, and optionally create PRs")
  .option("--open", "Create PRs for branches that don't have them")
  .option("--all", "Sync all Spry-tracked branches in the repository")  // NEW
  .option(
    "--apply <json>",
    "Only open PRs for specified commits/groups (JSON array of identifiers)",
  )
  .option("--up-to <id>", "Only open PRs for commits/groups up to and including this identifier")
  .option("-i, --interactive", "Interactively select which commits/groups to open PRs for")
  .option(
    "--allow-untitled-pr",
    "Allow creating PRs for groups without stored titles (uses first commit subject)",
  )
  .action((options) => syncCommand(options));
```

---

## Command Handler Changes

**File:** `src/cli/commands/sync.ts`

Update `SyncOptions`:

```typescript
export interface SyncOptions {
  open?: boolean;
  apply?: string;
  upTo?: string;
  interactive?: boolean;
  allowUntitledPr?: boolean;
  all?: boolean;  // NEW
}
```

Update `syncCommand()`:

```typescript
export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  // Validate --all compatibility
  if (options.all) {
    if (options.apply) {
      console.error("✗ Error: --all cannot be used with --apply");
      process.exit(1);
    }
    if (options.upTo) {
      console.error("✗ Error: --all cannot be used with --up-to");
      process.exit(1);
    }
    if (options.interactive) {
      console.error("✗ Error: --all cannot be used with --interactive");
      process.exit(1);
    }
    if (options.open) {
      console.error("✗ Error: --all cannot be used with --open (yet)");
      console.error("  Tip: Run 'sp sync --all' first, then 'sp sync --open' on each branch");
      process.exit(1);
    }

    // Route to sync-all
    await syncAllCommand(options);
    return;
  }

  // ... existing sync logic ...
}
```

---

## Test Cases

### Test 1: --all flag works via CLI

**Setup:**

- Use `multiSpryBranches` scenario

**Execute:**

- `sp sync --all`

**Assert:**

- Exit code 0
- Output shows rebased and skipped branches

### Test 2: --all is incompatible with --apply

**Execute:**

- `sp sync --all --apply '["abc123"]'`

**Assert:**

- Exit code 1
- Error message mentions incompatibility

### Test 3: --all is incompatible with --up-to

**Execute:**

- `sp sync --all --up-to abc123`

**Assert:**

- Exit code 1
- Error message mentions incompatibility

### Test 4: --all is incompatible with --interactive

**Execute:**

- `sp sync --all --interactive`

**Assert:**

- Exit code 1
- Error message mentions incompatibility

### Test 5: --all is incompatible with --open (for now)

**Execute:**

- `sp sync --all --open`

**Assert:**

- Exit code 1
- Error message suggests running separately

### Test 6: Help shows --all option

**Execute:**

- `sp sync --help`

**Assert:**

- Output includes `--all` with description

---

## Test File Addition

**File:** `tests/integration/sync-all.test.ts`

```typescript
import { runSpry, runSync } from "./helpers.ts";

describe("sync --all: Phase 6 - CLI integration", () => {
  const repos = repoManager();

  test("--all flag works via CLI", async () => {
    const repo = await repos.create();
    await scenarios.multiSpryBranches.setup(repo);

    const result = await runSpry(repo.path, "sync", ["--all"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Syncing");
    // Should show at least one result
    expect(result.stdout).toMatch(/[✓⊘]/);
  });

  test("--all is incompatible with --apply", async () => {
    const repo = await repos.create();

    const result = await runSpry(repo.path, "sync", ["--all", "--apply", '["abc"]']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--all cannot be used with --apply");
  });

  test("--all is incompatible with --up-to", async () => {
    const repo = await repos.create();

    const result = await runSpry(repo.path, "sync", ["--all", "--up-to", "abc"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--all cannot be used with --up-to");
  });

  test("--all is incompatible with --interactive", async () => {
    const repo = await repos.create();

    const result = await runSpry(repo.path, "sync", ["--all", "--interactive"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--all cannot be used with --interactive");
  });

  test("--all is incompatible with --open (for now)", async () => {
    const repo = await repos.create();

    const result = await runSpry(repo.path, "sync", ["--all", "--open"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--all cannot be used with --open");
  });

  test("help shows --all option", async () => {
    const repo = await repos.create();

    const result = await runSpry(repo.path, "sync", ["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--all");
    expect(result.stdout).toContain("Spry-tracked branches");
  });
});
```

---

## Helper Update

**File:** `tests/integration/helpers.ts`

Add `all` option to `runSync`:

```typescript
export async function runSync(
  cwd: string,
  options: { open?: boolean; allowUntitledPr?: boolean; all?: boolean } = {},
): Promise<CommandResult> {
  const args: string[] = [];
  if (options.open) args.push("--open");
  if (options.allowUntitledPr) args.push("--allow-untitled-pr");
  if (options.all) args.push("--all");
  return runSpry(cwd, "sync", args);
}
```

---

## Definition of Done

- [ ] `--all` flag added to CLI in `src/cli/index.ts`
- [ ] Incompatibility checks added to `syncCommand()`
- [ ] `syncAllCommand()` called when `--all` is specified
- [ ] `runSync()` helper updated
- [ ] All Phase 6 tests pass
- [ ] Help output shows the new flag

---

## Future Work (Not in This Phase)

- `--all --open` - Sync all and create/update PRs
- `--all --dry-run` - Preview what would happen
- Progress indicators for long-running operations

---

## Completion

After Phase 6, the `sp sync --all` feature is complete:

- Users can run `sp sync --all` to rebase all Spry branches
- Clear reporting shows what happened to each branch
- Safe handling of worktrees (skips dirty ones)
- Conflict detection without getting stuck in rebase state

### Full Test Run

```bash
bun run test:docker tests/integration/sync-all.test.ts
```

All phases should pass!
