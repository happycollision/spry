# Git Operations Module Design

Date: 2026-02-26

## Scope

Core git operations that all higher-level commands depend on. This is Phase 2 Step 2 of the test-first rebuild.

**In scope:** Config (trunk/remote/version), read-only queries, plumbing writes, rebase, conflict prediction, working tree status.

**Out of scope (later steps):** Group titles storage, group rebase, behind-main checks, fast-forward, remote sync status, PR detection.

## Design Decisions

1. **Explicit config, no auto-detection.** Users must set `spry.trunk` and `spry.remote` in git config. No guessing. Error messages suggest candidates if `origin/main` or `origin/master` exists, but nothing is auto-set. This eliminates an entire class of "wrong remote" / "wrong branch" bugs.

2. **`trunk` replaces `defaultBranch`.** The configured target branch is called "trunk" throughout — `spry.trunk` config key, `trunkRef` parameter name, `rebaseOntoTrunk` function name. Clearer than "default branch" and shorter.

3. **Explicit GitRunner param.** Every function takes `git: GitRunner` as its first parameter. Same pattern as `trailers.ts` in the parse module. No hidden state, no module-level singletons, trivially testable.

4. **Trunk ref passed explicitly.** Functions that need the trunk ref (e.g., `getMergeBase`, `getStackCommits`) take `trunkRef: string` as a parameter rather than reading config internally. Callers read config once and pass the ref down. This eliminates repeated config reads and makes dependencies explicit.

5. **Git version checked at config load.** `loadConfig()` checks git >= 2.40 alongside reading trunk/remote. Fail fast with a clear error rather than scattered checks in plumbing operations.

6. **No file cache in conflict prediction.** The old code cached commit file lists in a module-level `Map` for TUI session reuse. That state doesn't belong in the git module — the TUI can cache externally if needed.

7. **Integration tests against real git.** All tests use `createRepo()` and `createRealGitRunner()` from the test library. No mocking git — these test actual git behavior in temp repos.

## Module: `src/git/`

### `config.ts` — Explicit config + version check

```ts
interface SpryConfig {
  trunk: string;   // e.g. "main" — from git config spry.trunk
  remote: string;  // e.g. "origin" — from git config spry.remote
}

// Computed from config — "origin/main"
function trunkRef(config: SpryConfig): string

// Read spry.trunk and spry.remote from git config.
// Throws with helpful error + suggestions if not set.
function readConfig(git: GitRunner): Promise<SpryConfig>

// Check git version >= 2.40. Throws with clear error if not.
function checkGitVersion(git: GitRunner): Promise<string>

// Combined: read config + check version. Primary entry point.
function loadConfig(git: GitRunner): Promise<SpryConfig>
```

Error UX for missing config:

```
spry.trunk is not configured.

Set it with:
  git config spry.trunk main

Branches found on origin: main, develop
```

### `queries.ts` — Read-only git operations

All functions take `git: GitRunner` as first parameter.

```ts
// Merge base between HEAD and trunk ref
function getMergeBase(git, trunkRef): Promise<string>

// Commits between merge-base and HEAD, oldest first
function getStackCommits(git, trunkRef): Promise<CommitInfo[]>

// Commits between merge-base and a specific branch, oldest first
function getStackCommitsForBranch(git, branch, trunkRef): Promise<CommitInfo[]>

// Current branch name. Returns "HEAD" if detached.
function getCurrentBranch(git): Promise<string>

// True if in detached HEAD state
function isDetachedHead(git): Promise<boolean>

// True if working tree has uncommitted changes
function hasUncommittedChanges(git): Promise<boolean>

// Full commit message for a commit
function getCommitMessage(git, commit): Promise<string>

// Full 40-char SHA
function getFullSha(git, ref): Promise<string>

// Short SHA (for display)
function getShortSha(git, ref): Promise<string>
```

`getStackCommits` uses `git log --reverse --format=%H%x00%s%x00%B%x01 <merge-base>..HEAD` with null-byte separators for reliable parsing, same as the old code.

### `plumbing.ts` — Low-level git object operations

Operations on `.git/objects` that don't touch the working directory (except `resetToCommit` and `finalizeRewrite`).

```ts
// Tree SHA from a commit
function getTree(git, commit): Promise<string>

// First parent SHA (throws for root commits)
function getParent(git, commit): Promise<string>

// All parent SHAs
function getParents(git, commit): Promise<string[]>

// Author env vars for preserving authorship
function getAuthorEnv(git, commit): Promise<Record<string, string>>

// Author + committer env vars for message-only changes
function getAuthorAndCommitterEnv(git, commit): Promise<Record<string, string>>

// Create commit object via git commit-tree
function createCommit(git, tree, parents, message, env): Promise<string>

// Three-way merge via git merge-tree --write-tree (Git 2.40+)
function mergeTree(git, base, ours, theirs): Promise<MergeTreeResult>

// Atomic ref update with optional compare-and-swap
function updateRef(git, ref, newSha, oldSha?): Promise<void>

// Reset working directory to match a commit
function resetToCommit(git, commit): Promise<void>

// Rewrite chain of commits with new messages (for trailer injection)
function rewriteCommitChain(git, commits, rewrites): Promise<ChainRewriteResult>

// Rebase commits onto new base using merge-tree (no working directory changes)
function rebasePlumbing(git, onto, commits): Promise<PlumbingRebaseResult>

// Finalize rewrite: update ref, reset working dir only if tree changed
function finalizeRewrite(git, branch, oldTip, newTip): Promise<void>
```

Types:

```ts
type MergeTreeResult =
  | { ok: true; tree: string }
  | { ok: false; conflictInfo: string }

interface ChainRewriteResult {
  newTip: string;
  mapping: Map<string, string>;
}

type PlumbingRebaseResult =
  | { ok: true; newTip: string; mapping: Map<string, string> }
  | { ok: false; conflictCommit: string; conflictInfo: string }
```

### `rebase.ts` — High-level rebase operations

Compose queries + plumbing for rebase workflows.

```ts
// Inject Spry-Commit-Id trailers into commits missing them
function injectMissingIds(git, trunkRef, options?): Promise<InjectIdsResult>

// Rebase stack onto latest trunk
function rebaseOntoTrunk(git, config, options?): Promise<RebaseResult>

// Check if we're mid-rebase with conflicts
function getConflictInfo(git): Promise<ConflictInfo | null>

// Format conflict info into user-friendly error message
function formatConflictError(info: ConflictInfo): string
```

Types:

```ts
type InjectIdsResult =
  | { ok: true; modifiedCount: number; rebasePerformed: boolean }
  | { ok: false; reason: "detached-head" }

type RebaseResult =
  | { ok: true; commitCount: number; newTip: string }
  | { ok: false; reason: "detached-head" | "conflict"; conflictFile?: string }

interface ConflictInfo {
  files: string[];
  currentCommit: string;
  currentSubject: string;
}
```

`rebaseOntoTrunk` tries plumbing rebase first. On conflict for the current branch, falls back to traditional `git rebase` so users can resolve interactively. For non-current branches, just reports the conflict.

Options parameter supports `branch?: string` for operating on non-current branches.

### `conflict.ts` — Conflict prediction

For TUI grouping — predict whether reordering commits would cause conflicts.

```ts
// Files modified by a commit (via git diff-tree)
function getCommitFiles(git, hash): Promise<string[]>

// Files touched by both commits
function checkFileOverlap(git, commitA, commitB): Promise<string[]>

// Parse CONFLICT lines from git merge-tree output
function parseConflictOutput(output: string): { files: string[] }

// Simulate merge via git merge-tree to detect actual conflicts
function simulateMerge(git, base, commitA, commitB, overlappingFiles): Promise<ConflictResult>

// Predict if moving commitA past commitB would conflict
function predictConflict(git, commitA, commitB, mergeBase): Promise<ConflictResult>

// Check conflicts for a proposed reordering
function checkReorderConflicts(git, currentOrder, newOrder, mergeBase): Promise<Map<string, ConflictResult>>
```

Types:

```ts
interface ConflictResult {
  status: "clean" | "warning" | "conflict";
  files?: string[];
}
```

### `status.ts` — Working tree status

```ts
interface WorkingTreeStatus {
  isDirty: boolean;
  hasUnstagedChanges: boolean;
  hasStagedChanges: boolean;
  hasUntrackedFiles: boolean;
}

// Detailed working tree status from git status --porcelain
function getWorkingTreeStatus(git): Promise<WorkingTreeStatus>

// Throw if working tree has staged/unstaged changes (untracked files OK)
function requireCleanWorkingTree(git): Promise<void>
```

### `index.ts` — Barrel export

Re-exports public API from all modules. Internal plumbing functions may be excluded from the barrel if they're only used by other `src/git/` modules.

## Test Structure

```
tests/git/
  config.test.ts       # Config reading, missing config errors, version check
  queries.test.ts      # Stack commits, merge-base, branch queries
  plumbing.test.ts     # Commit creation, merge-tree, chain rewrite
  rebase.test.ts       # ID injection, rebase-onto-trunk, conflict fallback
  conflict.test.ts     # File overlap, merge simulation, reorder prediction
  status.test.ts       # Dirty/clean working tree states
```

All tests use `createRepo()` and `createRealGitRunner()`. Test scenarios:

- **config:** repo with/without spry.trunk set, git version parsing
- **queries:** empty stack, multi-commit stack, branch-specific queries, detached HEAD
- **plumbing:** single commit rewrite, chain rewrite with partial modifications, merge-tree with clean/conflicting trees
- **rebase:** clean rebase onto updated trunk, conflict detection + fallback, ID injection for missing trailers
- **conflict:** non-overlapping commits (clean), overlapping but non-conflicting (warning), actual conflicts (conflict), reorder conflict map
- **status:** clean tree, staged changes, unstaged changes, untracked files
