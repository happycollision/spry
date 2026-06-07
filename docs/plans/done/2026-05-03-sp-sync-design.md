---
name: sp sync
description: Phase 2 Step 6 of the test-first rebuild — sp sync as the first writer (push, create PR, retarget)
---

# sp sync Design

Date: 2026-05-03

## Scope

Phase 2 Step 6 of the test-first rebuild. First module to mutate remote state. Establishes the pattern that later writers (`sp land`, `sp clean`, `sp sync --all`) build on.

**In scope (thin slice):**

- Inject missing `Spry-Commit-Id` trailers via the existing `injectMissingIds` helper.
- Bare `sp sync`: push branches whose remote ref already exists; never creates new remote branches; retargets existing PRs whose base ref no longer matches the local stack order.
- `sp sync --open <ids>`: comma-separated unit IDs (full or prefix). For each ID, push the unit's branch (creating the remote ref) and create a new PR with body derived from the commit message.
- `sp sync --open` (boolean, no value): dropped into a TUI multi-select listing single-commit units that don't yet have a remote branch. First feature consumer of `TerminalDriver`.
- New `src/gh/` write operations: `createPR`, `retargetPR`, `pushBranch` (pure git, but lives here logically).
- New `src/gh/pr-body.ts` (deferred from Step 4): pure body-formatting from a `PRUnit` and its `CommitInfo[]`.
- Graceful gh-unavailable fallback for retargeting (push still works without gh).

**Out of scope (deferred to later steps):**

- Group support in `--open` — groups need stored titles. Group-title storage ships with `sp group` (Step 7) where the editor lives. Bare sync handles group branches the same as singles.
- PR body and title updates after creation — `--open` is write-once. Re-running `--open` on a unit that already has a PR errors. Smarter "update title/body when commits change" lands later with marker-based user-content preservation.
- Auto-fetch + auto-rebase-onto-trunk + conflict prediction. Local stack must already be on the right base; sync trusts that.
- Fast-forward of local trunk branch.
- Stack-link PR bodies, PR templates, content-hash skipping.
- Merged-PR cleanup, orphan branch deletion, predecessor-base recovery — all `sp clean` (Step 9) territory.
- `--apply` / `--up-to` / `--allow-untitled-pr` legacy flags. `--open <ids>` covers selective opening.
- Concurrent sync of multiple branches (`sp sync --all`) — Step 10.
- Detached HEAD / dirty working tree handling beyond the existing `requireCleanWorkingTree`.

## Design Decisions

1. **Two flag shapes, one command.** `sp sync` (zero args) and `sp sync --open` (boolean or value). Selectors like `--apply` and `--up-to` are not added back; their job is covered by passing IDs to `--open`. Keeps the command's surface tiny and intention-revealing: bare sync = update what's published; `--open` = publish more.

2. **Cheap path for "what to push" — no gh call required for bare sync's push phase.** A single `git ls-remote --heads <remote> '<prefix>/*'` produces the set of pushable branches. Pushing is a pure git operation. gh enrichment is needed only for retargeting; if it fails, push still wins. This matches the rebuild's "infra failures degrade gracefully" pattern from Step 5.

3. **Push is force-with-lease.** Trailer injection rewrites SHAs; legitimate sync flows always need force semantics. `--force-with-lease` rejects pushes that would clobber a remote tip the local repo hasn't seen, which is the correct safety net.

4. **`--open` is write-once.** A unit with an existing remote branch (and therefore, in our model, a PR) cannot be reopened with `--open`. Erroring directs the user back to bare sync. No "update title/body" path yet — that's a known limitation, documented in the help text.

5. **Retargeting from local stack order is authoritative.** Expected base for unit `i`: `trunk` if `i === 0`, else `branchForUnit(stack[i-1])`. If the live PR's `baseRefName` differs, retarget. If gh refuses (closed PR, deleted branch, etc.), warn and continue — `sp clean` is the proper fix.

6. **Push all, then retarget all.** Two passes through the unit list. The first pass pushes; the second runs gh enrichment + retargets. Keeps the failure model simple: a gh outage strands you with up-to-date branches and stale PR pointers, which is recoverable next sync. Cleverer concurrent or interleaved schemes can come later.

7. **Body and title regeneration is an explicit feature, not a side effect.** Re-running `--open` on an existing unit must not silently rewrite a PR. Until preservation lands, deliberate clobber requires a future flag (e.g. `sp sync --rewrite <id>`); not part of this step.

8. **Bodies strip ALL trailers.** `Spry-*`, `Co-Authored-By`, `Signed-off-by`, etc. — all gone from PR descriptions. PR title is the commit subject; PR body is the prose between subject and trailers. No footer. Pure write-once content.

9. **TUI ships now.** Step 6 introduces the first feature using `TerminalDriver`. The multi-select widget here is small and focused (checkbox list, enter to confirm, escape to cancel) — a useful warm-up that proves the TUI infrastructure works in production before the more complex grouping editor in Step 7. Selector code lives under `src/tui/`.

## Architecture

```
                 sp sync [--open [ids]]
                          │
                          ▼
                   syncCommand(ctx, opts)
                  ┌───────┴────────┐
                  ▼                ▼
          injectMissingIds     parseStack
                  │                │
                  ▼                ▼
          parseStack again ◄──── units
                  │
        ┌─────────┼──────────────────────────┐
        ▼         ▼                          ▼
   bare sync  --open <ids>              --open (TUI)
        │         │                          │
        │         │                          ▼
        │         │                  selectUnits (TerminalDriver)
        │         │                          │
        │         └──────────────┬───────────┘
        │                        │
        ▼                        ▼
   pushExisting            openSelected
   (cheap path)            (creates branch + PR)
        │                        │
        ▼                        │
   retargetAll  ◄─────────────────┘
   (gh required, fallback OK)
```

Modules touched or added:

```
src/
  cli/index.ts             # extend: --open option
  commands/sync.ts         # NEW: command orchestration
  gh/
    pr.ts                  # extend: createPR, retargetPR
    pr-body.ts             # NEW: formatPRBody, formatPRTitle (pure)
    push.ts                # NEW: pushBranch (git op, lives in gh/ for cohesion)
    index.ts               # extend: re-exports
  tui/
    select.ts              # NEW: multi-select widget over TerminalDriver
    index.ts               # NEW: barrel
tests/
  commands/
    sync.test.ts           # NEW: command-level tests with stub gh
    sync.doc.test.ts       # NEW: doc fragments for sp sync
  gh/
    pr-body.test.ts        # NEW: pure body/title formatting
    push.test.ts           # NEW: pushBranch via real git in tmp repo
    pr-write.test.ts       # NEW: createPR/retargetPR with stub gh client
  tui/
    select.test.ts         # NEW: TerminalDriver-driven snapshot tests
fixtures/tests/gh/         # cassettes for any new recorded scenarios (likely none — write tests use stubs)
```

## Module: `src/gh/pr-body.ts` (new, pure)

```ts
import type { PRUnit, CommitInfo } from "../parse/types.ts";

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*\s*:\s.+$/;

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

export function stripTrailers(body: string): string {
  // Trailers are a contiguous block at the end of the message, separated from
  // the body by a blank line. Strip them by walking backwards.
  const lines = body.split("\n");
  let end = lines.length;
  // Trim trailing blank lines
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  // Identify a trailer block at the tail
  let trailerStart = end;
  while (trailerStart > 0 && TRAILER_LINE.test(lines[trailerStart - 1]!)) {
    trailerStart--;
  }
  if (trailerStart === end) return body.replace(/\s+$/, "");
  // Require the trailer block to be preceded by a blank line (or BOF)
  if (trailerStart > 0 && lines[trailerStart - 1]!.trim() !== "") return body.replace(/\s+$/, "");
  // Drop the trailers and the separating blank line
  let prose = trailerStart;
  while (prose > 0 && lines[prose - 1]!.trim() === "") prose--;
  return lines.slice(0, prose).join("\n");
}
```

Pure functions — covered by unit tests with synthetic input. No gh, no git.

## Module: `src/gh/push.ts` (new)

```ts
import type { GitRunner } from "../lib/context.ts";

export interface PushOptions {
  cwd?: string;
  remote: string;       // e.g. "origin"
  sha: string;          // commit to push
  branch: string;       // remote branch name (e.g. "spry/dondenton/aaa11111")
  forceWithLease: boolean;
}

export type PushResult =
  | { ok: true }
  | { ok: false; reason: "rejected" | "stale-ref"; stderr: string };

export async function pushBranch(git: GitRunner, opts: PushOptions): Promise<PushResult>;

export async function listRemoteBranches(
  git: GitRunner,
  remote: string,
  prefix: string,
  opts?: { cwd?: string },
): Promise<Set<string>>;
```

`pushBranch` invokes `git push <remote> <sha>:refs/heads/<branch> --force-with-lease`. Maps non-zero exit + known stderr patterns to typed reasons.

`listRemoteBranches` runs `git ls-remote --heads <remote> '<prefix>/*'` and returns the set of full branch names (without the `refs/heads/` prefix).

## Module: `src/gh/pr.ts` (extend)

Add two write operations:

```ts
export interface CreatePROptions {
  cwd?: string;
}
export interface CreatePRParams {
  title: string;
  head: string;            // branch name
  base: string;            // branch name (trunk or another spry branch)
  body: string;
}
export interface CreatePRResult {
  number: number;
  url: string;
}

export async function createPR(
  ctx: SpryContext,
  params: CreatePRParams,
  options?: CreatePROptions,
): Promise<CreatePRResult>;

export async function retargetPR(
  ctx: SpryContext,
  prNumber: number,
  newBase: string,
  options?: { cwd?: string },
): Promise<void>;
```

Implementations call `gh pr create --title ... --head ... --base ... --body-file -` (with body on stdin to avoid arg-length and quoting issues) and `gh pr edit <number> --base <newBase>`. Both use `withRetry` + `classifyError` so transient failures retry and auth/install failures throw the typed errors.

## Module: `src/tui/select.ts` (new)

```ts
export interface SelectOption {
  id: string;
  label: string;          // shown in the list
  hint?: string;          // dimmed suffix (e.g. "(group, no title)")
  disabled?: boolean;     // shown but not selectable
}

export interface SelectResult {
  cancelled: boolean;
  selectedIds: string[];
}

export interface SelectOptions {
  title?: string;
  cols?: number;
  rows?: number;
}

export async function selectUnits(
  options: SelectOption[],
  opts?: SelectOptions,
): Promise<SelectResult>;
```

Renders directly to `process.stdout` using ANSI codes:

- Up/Down move the cursor
- Space toggles selection
- `a` toggles all
- Enter confirms
- Esc / `q` / Ctrl+C cancels

Behavior is testable via `TerminalDriver` — spawn the command in a PTY, send key sequences, capture screen snapshots.

## Module: `src/commands/sync.ts` (new)

Top-level shape:

```ts
export interface SyncOptions {
  /** undefined = bare sync; null = boolean --open (TUI); string = comma-separated IDs */
  open?: string | null;
  cwd?: string;
}

export async function syncCommand(ctx: SpryContext, opts: SyncOptions = {}): Promise<void> {
  const config = await loadConfig(ctx.git);
  await requireCleanWorkingTree(ctx.git, { cwd: opts.cwd });

  // 1. Inject Spry-Commit-Id trailers; rebase rewrites the stack
  const ref = trunkRef(config);
  const inject = await injectMissingIds(ctx.git, ref, { cwd: opts.cwd });
  if (!inject.ok) { /* detached-head error */ }
  if (inject.modifiedCount > 0) console.log(`✓ Injected ${inject.modifiedCount} commit ID(s)`);

  // 2. Re-read commits + parse stack
  const commits = await getStackCommits(ctx.git, ref, { cwd: opts.cwd });
  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd: opts.cwd });
  const result = parseStack(withTrailers);
  if (!result.ok) { /* validation error */ }
  const units = result.units;

  if (units.length === 0) {
    console.log("✓ No commits in stack");
    return;
  }

  // 3. Cheap signal: which branches already exist?
  const existing = await listRemoteBranches(ctx.git, config.remote, config.branchPrefix, { cwd: opts.cwd });

  // 4. Push phase
  const pushed = await pushExistingBranches(ctx, config, units, existing, { cwd: opts.cwd });

  // 5. --open: open new PRs (with their own pushes)
  let opened: PRInfo[] = [];
  if (opts.open !== undefined) {
    const targetIds = opts.open === null
      ? await selectOpenIds(units, existing) // TUI
      : parseAndResolveIds(opts.open, units, withTrailers);
    if (targetIds.length === 0) {
      console.log("(no units selected)");
    } else {
      opened = await openPRs(ctx, config, units, targetIds, withTrailers, { cwd: opts.cwd });
    }
  }

  // 6. Retarget phase
  await retargetMismatched(ctx, config, units, [...pushed, ...opened.map((p) => p.headBranch)], {
    cwd: opts.cwd,
  });
}
```

Helper sketches (full bodies in the implementation plan):

- `pushExistingBranches`: for each unit whose `branchForUnit(unit, config)` is in `existing`, call `pushBranch` with the unit's head SHA. Returns the list of branches it actually pushed.
- `parseAndResolveIds`: split `opts.open` on commas, run `resolveIdentifiers` from `src/parse/identifier.ts` (already exists, supports prefix matching and ambiguity errors), reject any group unit, reject any unit already in `existing` (write-once).
- `selectOpenIds`: build `SelectOption[]` from `units.filter(u => u.type === "single" && !existing.has(branchForUnit(u, config)))`. Calls `selectUnits`. Returns the unit IDs.
- `openPRs`: for each target unit (in stack order), push its branch, compute base (trunk for unit 0, previous unit's branch otherwise), call `createPR` with `formatPRTitle` / `formatPRBody`. Return list of created PRs (with their head branch names).
- `retargetMismatched`: call `findPRsForBranches` for the set of branches we touched. Compute expected base per unit. For each PR with mismatched base in OPEN state, call `retargetPR` and log. Catch per-PR errors and warn (non-fatal). Catch the function-level enrichment failure and print the same kind of fallback hint `sp view` uses, then return cleanly.

## Module: `src/cli/index.ts` (extend)

```ts
program
  .command("sync")
  .description("Sync the current stack to GitHub")
  .option("--open [ids]", "Open PRs for selected units (no value = TUI selector)")
  .action((opts: { open?: string | true }) => {
    const open = opts.open === undefined ? undefined : opts.open === true ? null : opts.open;
    return syncCommand(ctx, { open });
  });
```

Commander's `--open [ids]` syntax: present without value → `true`; present with value → string; absent → `undefined`. We collapse `true` to `null` to keep `SyncOptions.open` cleanly tri-state.

## Test Plan

### Unit tests (synthetic, no cassettes)

**`tests/gh/pr-body.test.ts`**:

- `formatPRTitle` returns commit subject for singles.
- `formatPRBody` returns prose, stripping a trailer block.
- `stripTrailers`: only strips contiguous trailer block at end; handles bodies with no trailers, only trailers, mixed prose+trailers, multi-paragraph bodies. Doesn't strip lines that look like trailers but aren't preceded by a blank line.

**`tests/gh/push.test.ts`** (real git in a temp repo via `createRepo`):

- `pushBranch` pushes a commit to a new remote ref.
- `pushBranch` with `--force-with-lease` succeeds when local has the latest remote tip.
- `pushBranch` returns `{ ok: false, reason: "stale-ref" }` when the remote diverged.
- `listRemoteBranches` returns only branches under the prefix.
- `listRemoteBranches` returns an empty set when no matching branches exist.

**`tests/gh/pr-write.test.ts`** (stub gh client):

- `createPR` returns `{ number, url }` parsed from successful gh output.
- `createPR` retries on transient stderr; throws `GhAuthError` on auth failure.
- `retargetPR` calls `gh pr edit <n> --base <new>`.
- Both pass `--body-file -` with the body on stdin (assert via captured stdin in stub).

**`tests/tui/select.test.ts`** (`TerminalDriver`):

- Empty options → returns `{ cancelled: false, selectedIds: [] }` immediately (or `cancelled: true`, design choice — I lean cancelled).
- Single option, Space then Enter → selectedIds includes it.
- Three options, ArrowDown × 2, Space, Enter → selects the third.
- `a` toggles all.
- Esc → `cancelled: true`.
- Ctrl+C → `cancelled: true`.
- Snapshot tests for the rendered screen (small snapshots; one for cursor on first item, one for two-selected state).

### Command tests (`tests/commands/sync.test.ts`)

Stub gh client. Real git in a fresh repo via `createRepo`.

- **Empty stack**: prints "No commits in stack", no gh calls.
- **All units missing IDs**: trailer injection runs; logs "Injected N commit ID(s)".
- **Bare sync, no remote branches**: `git ls-remote` returns nothing; nothing pushed; no gh calls; exit 0.
- **Bare sync, one remote branch matches one unit**: pushes that unit; calls gh once for retargeting; if base correct, no retarget call; logs `↑ pushed <branch>`.
- **Bare sync, retarget needed**: PR's base ref doesn't match expected → calls `retargetPR`; logs `↻ retargeted PR #N`.
- **Bare sync, gh unavailable**: ls-remote+push succeed; gh stub throws `GhNotInstalledError`; output includes the same fallback hint pattern as `sp view`; exit 0.
- **`--open <id>`, valid single unit, no existing branch**: pushes branch; creates PR; output shows PR URL; exit 0.
- **`--open <id>`, prefix matches multiple units**: error message via `formatResolutionError`; exit 1.
- **`--open <id>`, unit already has remote branch**: error "Unit X already published; use `sp sync` to update"; exit 1.
- **`--open <id>`, group unit**: error "Groups not supported in --open yet (use `sp group` first — Step 7)"; exit 1.
- **`--open` boolean (TUI)**: not testable via this file (TUI requires PTY). Covered in `tui/select.test.ts` and a separate command-level integration test.
- **Two-unit `--open`, second's base is first's branch**: `createPR` for unit 1 receives `base=<branch-of-unit-0>`.
- **Three-unit stack reorder**: reorder commits locally so unit 2 now comes before unit 1; bare sync → retarget unit 1's PR base from "unit 2's branch" to "unit 0's branch".

### Doc-producing tests (`tests/commands/sync.doc.test.ts`)

Following the established doc pattern from view. Stub gh client where useful; real git for the visible bits.

- **"Syncing without `--open`"** — pushes existing branches; output shows `↑ pushed ...`. Section ordering 10.
- **"Opening a PR with `sp sync --open <id>`"** — single-unit creation flow. Section ordering 20.
- **"Retargeting after a stack reorder"** — explains the retarget output. Section ordering 30.
- **"Selecting units interactively (`--open`)"** — TUI variant. Use `TerminalDriver` capture; `doc.screen(capture)` to embed the rendered selector. Section ordering 40.

All tests must call `doc.scrub(repo)` after `repos.push(repo)` and canonicalize PR URLs (e.g. scrub the random PR number to `#42`) so fragments are deterministic.

### Integration / cassette scenarios

Skipped for thin slice — every gh interaction is testable via stubs. Cassettes for write operations would require a fixture repo with permission to create/retarget real PRs; not worth the setup cost given how easily stubs cover these. We can add cassettes later if a real-fixture test reveals an `gh api` shape we mis-stubbed.

## Output Sketches

**Bare sync, common case:**

```
✓ Injected 1 commit ID
↑ pushed spry/dondenton/aaa11111
↑ pushed spry/dondenton/bbb22222
↻ retargeted PR #124 → spry/dondenton/aaa11111
✓ Sync complete
```

**Bare sync, gh unavailable:**

```
↑ pushed spry/dondenton/aaa11111
PR retargeting unavailable: gh auth login (branches still updated)
✓ Sync complete (with warnings)
```

**`sp sync --open aaa,bbb`:**

```
↑ pushed spry/dondenton/aaa11111
✓ Created PR #125: Add login page
  https://github.com/owner/repo/pull/125
↑ pushed spry/dondenton/bbb22222
✓ Created PR #126: Add signup form
  https://github.com/owner/repo/pull/126
✓ Sync complete
```

**`sp sync --open aaa` on already-published unit:**

```
✗ Unit aaa11111 already has a published branch (spry/dondenton/aaa11111).
  --open is for first-time publish only.
  Run `sp sync` to update the branch (PR title/body updates land in a future step).
```

## File Layout

```
src/
  cli/index.ts             # extend
  commands/sync.ts         # NEW
  gh/
    pr.ts                  # extend: createPR, retargetPR
    pr-body.ts             # NEW
    push.ts                # NEW
    index.ts               # extend
  tui/
    select.ts              # NEW
    index.ts               # NEW
tests/
  commands/
    sync.test.ts           # NEW
    sync.doc.test.ts       # NEW
  gh/
    pr-body.test.ts        # NEW
    pr-write.test.ts       # NEW
    push.test.ts           # NEW
  tui/
    select.test.ts         # NEW
docs/generated/commands/sync.md  # generated by docs:build
```

## Risks & Mitigations

- **First TUI in production code.** `TerminalDriver` infrastructure exists but no feature has used it; subtle ANSI quirks could surface. Mitigation: keep the widget tiny and snapshot-tested; if unblocking issues appear, the fallback is a printed hint requiring explicit `--open <ids>` (same UX as if Step 6 deferred TUI to Step 7).

- **Force-with-lease can refuse a push when remote was rewritten by another machine.** Spry's intended workflow is single-developer-per-stack, so this should be rare; when it happens, the error message must explain (a) what diverged and (b) `git fetch && sp sync` is the recovery. Document in the help text.

- **Retargeting cascade quirks.** When unit 0's PR is merged, GitHub auto-deletes its branch (depending on repo settings); subsequent retargets to that branch fail. Mitigation: per-PR try/catch around `retargetPR`; warn but continue. The proper fix is `sp clean` (Step 9) which detects merged PRs and triggers retarget-to-trunk.

- **Trailer-injection rebase changes commit hashes.** After injection, the locally remembered "last pushed SHA" (if any cache existed) would be stale. We don't have a cache — every sync re-derives from current state. Mitigation: confirms the architectural choice to keep state on GitHub (PR refs) and in commit messages (Spry-Commit-Id), not in local cache files.

- **`gh pr create` body length / quoting.** Long bodies have historically broken on Windows shell limits and weird shell quoting. Mitigation: write body to stdin via `--body-file -`. Both `createPR` and any future `updatePR` paths follow this pattern.

- **Step 7 TUI rework.** `sp group` will introduce a fancier interactive editor and may want to share primitives with the multi-select introduced here. Mitigation: keep `src/tui/select.ts` deliberately narrow (multi-select of labeled options, no ambitions) so Step 7 can either reuse it as-is or replace it with a more general primitive without breakage.
