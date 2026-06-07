---
name: sp view (enriched)
description: Phase 2 Step 5 of the test-first rebuild — sp view with PR state, checks, review, and resolved-comment enrichment
---

# sp view (enriched) Design

Date: 2026-05-02

## Scope

Phase 2 Step 5 of the test-first rebuild. First consumer of `src/gh/` (Step 4). Combines git stack data with GitHub PR data into the final user-facing form of `sp view`.

**In scope:**

- Branch-naming convention: `<prefix>/<unit-id>` via new `spry.branchPrefix` config.
- `enrichUnits` orchestrator that wraps `findPRsForBranches` with typed-error classification.
- Default-on enrichment with graceful local-view fallback when gh is unavailable.
- `sp view --no-fetch` flag for offline/CI users.
- New two-line per-unit display showing PR URL, checks status, review decision, and resolved-comment count.
- Extension of the gh module's GraphQL query and `PRInfo` type to include review thread counts.

**Out of scope:**

- PR creation/update (Step 6 — `sp sync`).
- `Spry-Branch` trailer override for non-conventional branch names — deferred until a real use case demands it.
- `git notes`-based metadata storage (PR number caching, last-pushed-SHA) — deferred to whichever later step demonstrates the need.
- Comment counts beyond review threads (issue comments, PR-level comments).
- Username segment in branch names (legacy `<prefix>/<user>/<id>` form). Achievable today by setting `branchPrefix = "spry/<user>"`.

## Design Decisions

1. **Convention is the floor.** `<prefix>/<unit-id>` derived from the unit's `id` (Spry-Commit-Id for singles, Spry-Group id for groups). Stateless, distributed-by-default, zero round-trips. Two years of legacy field-testing established this works. Trailer-based overrides and notes-based metadata can be added later without changing the convention's role as the default.

2. **Default-on enrichment with auto-fallback.** `sp view` enriches by default. If `gh` is missing, unauthenticated, the repo isn't a GitHub repo, or the network fails, the command silently falls back to local-only output and prints a single dim hint above the legend. Matches legacy UX. `--no-fetch` opts out explicitly.

3. **Enrichment lives in a dedicated orchestrator.** `src/gh/enrich.ts` exposes `enrichUnits(ctx, units, config)` returning `EnrichedUnit[]`. The view command calls it; the formatter consumes the result. Sync (Step 6) and land (Step 8) will reuse the same helper.

4. **Errors are classified, not propagated.** `enrichUnits` catches `GhAuthError`, `GhNotInstalledError`, and post-retry `Error` from `findPRsForBranches`, mapping each to a tagged union (`error: "auth" | "no-gh" | "network" | "no-remote"`). The formatter renders the appropriate hint. View never crashes from a network blip.

5. **All-or-nothing failure.** Because `findPRsForBranches` throws on the first infra failure, partial-success states don't exist. `enrichUnits` returns either every unit with PR data populated, or every unit tagged with the same error. No mixed-state UX to design.

6. **Two-line layout with labeled fields.** Each enriched unit renders state icon + title on line 1, and `<url> - checks:<icon> approval:<icon> comments:<resolved>/<total>` on line 2. Labels prevent positional confusion when a PR has no checks or no review activity.

7. **PRInfo grows the review-thread count, not arbitrary metadata.** Step 5 needs comment-resolution status; the GraphQL query gains `reviewThreads { totalCount, nodes { isResolved } }` and `PRInfo` gains `reviewThreads: { resolved, total }`. Existing cassettes are re-recorded once. Future enrichment fields are added the same way — extend the query, extend the type, re-record.

## Architecture

```
+------------------+     +-----------------+     +------------------+
| viewCommand      | --> | enrichUnits     | --> | findPRsForBranches|
| (commands/view)  |     | (gh/enrich)     |     | (gh/pr)          |
+------------------+     +-----------------+     +------------------+
        |                        |
        |                        v
        |                +----------------+
        |                | branchForUnit  |
        |                | (git/branch)   |
        |                +----------------+
        v
+-------------------+
| formatStackView   |
| (ui/format)       |
+-------------------+
```

Three new pieces (`branchForUnit`, `enrichUnits`, formatter rewrite), one config addition, one gh module extension.

## Module: `src/git/config.ts` (extend)

```ts
export interface SpryConfig {
  trunk: string;
  remote: string;
  branchPrefix: string;  // NEW
}
```

`readConfig` reads `git config spry.branchPrefix`. Required (no auto-detection, no default — matches the existing `trunk`/`remote` strictness). Error message suggests `spry/<your-username>` for legacy parity:

```
spry.branchPrefix is not configured.
Set it with: git config spry.branchPrefix spry/<your-username>
(Used to derive branch names for synced PRs: <prefix>/<unit-id>)
```

The `validateBranchName` rules apply — slashes are allowed, so `spry/dondenton` is valid as a prefix.

## Module: `src/git/branch.ts` (new)

```ts
import type { SpryConfig } from "./config.ts";
import type { PRUnit } from "../parse/types.ts";
import { validateBranchName } from "../parse/validation.ts";

export function branchForUnit(unit: PRUnit, config: SpryConfig): string {
  const name = `${config.branchPrefix}/${unit.id}`;
  const validation = validateBranchName(name);
  if (!validation.ok) {
    throw new Error(`Invalid derived branch name '${name}': ${validation.error}`);
  }
  return name;
}
```

Pure function. Throws on invalid result — defensive; should be unreachable given the validation guarantees on `branchPrefix` and `unit.id`.

## Module: `src/gh/pr.ts` (extend)

GraphQL query gains:

```graphql
reviewThreads(first: 100) {
  totalCount
  nodes { isResolved }
}
```

`PRInfo` gains:

```ts
export interface PRInfo {
  // ... existing fields
  reviewThreads: { resolved: number; total: number };
}
```

`parsePRResponse` extracts:

```ts
const threads = node.reviewThreads;
const total = threads?.totalCount ?? 0;
const resolved = (threads?.nodes ?? []).filter(t => t.isResolved).length;
```

The 100-thread `first:` cap is acceptable. Oversized PRs (>100 threads) undercount `resolved` but report `total` correctly via `totalCount`.

## Module: `src/gh/enrich.ts` (new)

```ts
import type { SpryContext } from "../lib/context.ts";
import type { SpryConfig } from "../git/config.ts";
import type { PRUnit } from "../parse/types.ts";
import { branchForUnit } from "../git/branch.ts";
import { findPRsForBranches } from "./pr.ts";
import type { PRInfo } from "./pr.ts";
import { GhAuthError, GhNotInstalledError } from "./errors.ts";

export type EnrichmentError = "no-gh" | "auth" | "network" | "no-remote";

export type EnrichedUnit =
  | { unit: PRUnit; pr: PRInfo | null; error?: never }
  | { unit: PRUnit; pr: null; error: EnrichmentError };

export async function enrichUnits(
  ctx: SpryContext,
  units: PRUnit[],
  config: SpryConfig,
): Promise<EnrichedUnit[]> {
  if (units.length === 0) return [];

  const branches = units.map((u) => branchForUnit(u, config));

  try {
    const map = await findPRsForBranches(ctx, branches);
    return units.map((unit, i) => ({
      unit,
      pr: map.get(branches[i]!) ?? null,
    }));
  } catch (err) {
    const error = classifyEnrichmentError(err);
    return units.map((unit) => ({ unit, pr: null, error }));
  }
}

function classifyEnrichmentError(err: unknown): EnrichmentError {
  if (err instanceof GhNotInstalledError) return "no-gh";
  if (err instanceof GhAuthError) return "auth";
  if (err instanceof Error && /not a github|no remote|no .* repository/i.test(err.message)) {
    return "no-remote";
  }
  return "network";
}
```

`no-remote` classification is heuristic — `gh` errors with phrases like "no GitHub remotes found" when run outside a GitHub repo. The retry layer in `pr.ts` won't retry these (they're non-transient), so they bubble up as plain `Error` from `findPRsForBranches`.

## Module: `src/commands/view.ts` (extend)

```ts
import type { SpryContext } from "../lib/context.ts";
import { loadConfig, trunkRef, getCurrentBranch, getStackCommits } from "../git/index.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { enrichUnits } from "../gh/enrich.ts";
import { formatStackView, formatValidationError } from "../ui/format.ts";

export interface ViewOptions {
  noFetch?: boolean;
}

export async function viewCommand(ctx: SpryContext, opts: ViewOptions = {}): Promise<void> {
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

  const enriched = opts.noFetch
    ? result.units.map((unit) => ({ unit, pr: null }) as const)
    : await enrichUnits(ctx, result.units, config);

  console.log(formatStackView(enriched, branch, commits.length, ref));
}
```

## Module: `src/cli/index.ts` (extend)

```ts
program
  .command("view")
  .description("View the current stack of commits with PR status")
  .option("--no-fetch", "Skip GitHub enrichment (local view only)")
  .action((opts: { fetch: boolean }) => viewCommand(ctx, { noFetch: !opts.fetch }));
```

Commander's `--no-fetch` automatically maps to `opts.fetch === false`.

## Module: `src/ui/format.ts` (rewrite)

`formatStackView` signature changes:

```ts
export function formatStackView(
  enriched: EnrichedUnit[],
  branch: string,
  commitCount: number,
  trunkRef: string,
): string;
```

### Output format — enriched

```
Stack: feature-pure-goat-vx6 (3 commits)
○ no PR  ◐ open  ✓ merged  ✗ closed
checks: ✓ pass  ✗ fail  ⏳ pending  — none
approval: ✓ approved  ✗ changes  ? required  — none

  → origin/main
────────────────────────────────────────────────────────────────────────
  ◐ Add login page (a1b2c3d4)
    https://github.com/owner/repo/pull/123 - checks:✓ approval:✓ comments:2/3
────────────────────────────────────────────────────────────────────────
  ✓ Add signup form (b2c3d4e5)
    https://github.com/owner/repo/pull/124 - checks:✓ approval:✓ comments:0/0
────────────────────────────────────────────────────────────────────────
  ○ Add password reset (c3d4e5f6)
────────────────────────────────────────────────────────────────────────
```

### Output format — fallback (gh unavailable)

```
Stack: feature-pure-goat-vx6 (3 commits)
PR status unavailable: gh auth login (showing local view)
○ no PR  ◐ open  ✓ merged  ✗ closed

  → origin/main
────────────────────────────────────────────────────────────────────────
  ○ Add login page (a1b2c3d4)
────────────────────────────────────────────────────────────────────────
  ○ Add signup form (b2c3d4e5)
────────────────────────────────────────────────────────────────────────
  ○ Add password reset (c3d4e5f6)
────────────────────────────────────────────────────────────────────────
```

The expanded checks/approval legend is omitted when falling back — there's nothing to legend.

### Glyph mapping

| Field    | Value             | Glyph               |
| -------- | ----------------- | ------------------- |
| state    | OPEN              | `◐` (kleur.blue)    |
| state    | MERGED            | `✓` (kleur.green)   |
| state    | CLOSED            | `✗` (kleur.red)     |
| state    | null              | `○` (kleur.dim)     |
| checks   | passing           | `✓` (kleur.green)   |
| checks   | failing           | `✗` (kleur.red)     |
| checks   | pending           | `⏳` (kleur.yellow) |
| checks   | none              | `—` (kleur.dim)     |
| approval | approved          | `✓` (kleur.green)   |
| approval | changes_requested | `✗` (kleur.red)     |
| approval | review_required   | `?` (kleur.yellow)  |
| approval | none              | `—` (kleur.dim)     |

### Fallback hint mapping

| `EnrichmentError` | Hint                                                         |
| ----------------- | ------------------------------------------------------------ |
| `no-gh`           | `PR status unavailable: install gh (https://cli.github.com)` |
| `auth`            | `PR status unavailable: gh auth login`                       |
| `no-remote`       | `PR status unavailable: not a GitHub repository`             |
| `network`         | `PR status unavailable: network error`                       |

All hints suffixed with `(showing local view)` and rendered with `kleur.dim`.

### Group rendering

Group titles render the state icon on the title line; the two-line URL/status block (when present) follows immediately, then the tree:

```
  ◐ A (2 commits)
    https://github.com/owner/repo/pull/125 - checks:⏳ approval:— comments:0/0
    ├─ Add auth middleware (e5f6g7h8)
    └─ Add session handling (i9j0k1l2)
```

The second-line indentation is 4 spaces (matching the title's indent + 2), keeping it visually distinct from the tree's `├─`/`└─` glyphs.

## Test Plan

### Unit tests (synthetic, no cassettes)

**`tests/git/branch.test.ts`** (new):

- `branchForUnit` for single unit returns `<prefix>/<commitId>`.
- `branchForUnit` for group unit returns `<prefix>/<groupId>`.
- Throws on invalid prefix (control characters, etc.) — uses `validateBranchName` defensively.

**`tests/gh/enrich.test.ts`** (new) with stub gh client:

- Empty units array → returns `[]`, no gh call.
- Normal flow → all units have `pr` populated; `error` undefined.
- `gh` not installed → all units have `pr: null, error: "no-gh"`.
- Auth missing → all units have `error: "auth"`.
- "no GitHub remotes" stderr → all units have `error: "no-remote"`.
- Other post-retry failure → all units have `error: "network"`.

**`tests/gh/pr-parse.test.ts`** (extend):

- New cases for `reviewThreads`: 0/0 (empty array, totalCount 0), 0/3 (nodes all unresolved), 2/3 (mixed), 3/3 (all resolved), missing `reviewThreads` field → 0/0.

**`tests/ui/format.test.ts`** (extend or new):

- Single open PR → two-line output with all icons.
- Merged PR → two-line output with `✓` state icon.
- No-PR unit → single-line output with `○`.
- All-error case → fallback hint above legend, all units single-line `○`.
- Group with PR → state icon on title, URL line, then tree.

### Doc-producing tests (`tests/commands/view.doc.test.ts`)

New scenarios producing fragments for `docs/generated/commands/view.md`:

- Stack with three units in different states (open + merged + no-PR).
- Stack with `--no-fetch` flag.
- Stack where gh is unavailable (stub `GhClient` returning `command not found`).
- Stack where gh auth fails.

Existing local-only fragments stay (re-routed through `--no-fetch` or stub gh).

### Integration tests (cassettes)

**`tests/gh/pr.test.ts`** — re-record cassettes via `bun test:record` to include `reviewThreads` in responses. Add new scenarios:

- PR with all review threads resolved.
- PR with all review threads unresolved.
- PR with mixed resolved/unresolved.
- PR with no review threads (zero comments).

The fixture branches established for Step 4 (`gh-test/open`, `/merged`, `/closed`) extend with comment threads added by the recording session.

## File Layout

```
src/
  cli/index.ts                # extend: --no-fetch option
  commands/view.ts            # extend: enrichUnits + opts
  git/
    branch.ts                 # NEW: branchForUnit
    config.ts                 # extend: branchPrefix
    index.ts                  # extend: re-export branchForUnit
  gh/
    pr.ts                     # extend: query + PRInfo
    enrich.ts                 # NEW: enrichUnits
    index.ts                  # extend: re-export enrichUnits, EnrichedUnit, EnrichmentError
  ui/format.ts                # rewrite: two-line layout, fallback hint
tests/
  git/branch.test.ts          # NEW
  gh/enrich.test.ts           # NEW
  gh/pr-parse.test.ts         # extend
  gh/pr.test.ts               # cassettes refreshed + new scenarios
  ui/format.test.ts           # NEW or extend
  commands/view.doc.test.ts   # extend
fixtures/tests/gh/...         # cassettes refreshed
```

## Risks & Mitigations

- **Cassette refresh required.** Adding `reviewThreads` to the GraphQL query invalidates every existing `tests/gh/pr.test.ts` cassette. Mitigation: one-time `bun test:record` run requiring `GH_TOKEN`. Document the fixture-repo setup needed (branches with PRs in resolved/unresolved comment states) alongside Step 4's existing notes.

- **Default-on enrichment introduces latency to every `sp view`.** A 10-unit stack does 10 sequential GraphQL calls (~200-500ms each = 2-5s total). Mitigation: tolerable for typical 1-5 unit stacks; `--no-fetch` is the escape hatch. Concurrency comes in Step 10 (`sp sync --all`); we'll revisit `sp view` parallelization there.

- **Branch convention locks future flexibility.** Once `<prefix>/<unit-id>` ships, users will have branches matching it. Adding a `Spry-Branch` trailer override later is non-breaking (read trailer first, derive as fallback). Adding notes-based metadata is non-breaking (notes-first lookup with convention fallback). The convention is forward-compatible with both extensions.

- **Visual density of the two-line layout.** Stacks of 5-10 units produce 10-20 lines plus separators. Mitigation: separators stay between units (not lines) so visual grouping holds. Future `--compact` flag could collapse to one line if user demand emerges.

- **`reviewThreads(first: 100)` cap.** PRs with >100 threads undercount `resolved`. Mitigation: `total` uses `totalCount` (correct for any PR size); `resolved` is best-effort. Acceptable for typical repos.
