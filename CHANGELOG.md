# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- PR status query against GitHub was broken: it referenced `$REPOSITORY_OWNER`/`$REPOSITORY_NAME`, which `gh api graphql` does not auto-populate, so every real PR lookup failed with `variableNotDefined`. This was masked because all tests stubbed `gh`. The query now declares `$owner`/`$repo` and `sp sync`/`sp view`/`sp land`/`sp group` pass them from a resolved repo slug (a new optional `spry.repo` git-config override, falling back to parsing the remote URL). This restores `sp sync`'s PR-cache refresh and retargeting against real GitHub.
- `sp group` reorder: `rewriteCommitChain` now accepts an optional `base` commit so reordered stacks are rooted at the merge base rather than being appended on top of the original chain. Previously, reordering two commits would produce a three-commit history instead of two.
- `sp group` rename: spaces typed during rename mode were silently dropped because the `space` keypress event was not handled in `applyRename`. Spaces are now treated as literal characters when renaming a group title.

### Added

- `sp land` — lands the stack into trunk by retargeting the in-scope PRs to trunk and fast-forwarding `origin/<trunk>` to the target unit's tip. `sp land --through <id>` lands from the bottom through a group/unit/commit id (whole stack = through the top unit, bottom-only = through the first); bare `sp land` opens a single-select picker. It runs a full `sp sync` first, gates on live PR readiness (failing/pending checks and changes-requested/review-required abort; unresolved review threads prompt), retargets every scope PR to trunk before pushing, and surfaces "behind trunk" as a fast-forward rejection pointing at `sp rebase`. Never uses the GitHub merge API and never deletes branches (use `sp clean`).
- `sp sync --all` — pushes every tracked stack in one command. Push-only: it never rebases and never opens new PRs (use `sp rebase --all` to restack and `sp sync --open` to publish), and it cannot be combined with `--open`. Each stack's already-published branches are pushed, PRs are retargeted, and the `refs/spry/prs` cache is updated once across all stacks. Branches that no longer exist locally are pruned from the tracking list. Operates entirely via git plumbing, so the working tree and `HEAD` are never moved.
- `sp rebase --all` — rebases all tracked branches onto trunk in one command. Branches are tracked automatically whenever `sp sync`, `sp group`, or `sp rebase` is run. Branches that no longer exist are removed from the tracking list. Tracking metadata is stored locally in `refs/spry/local/tracked-branches` and is never pushed to the remote.
- `sp rebase` — fetches the remote, checks if the stack is behind trunk, predicts conflicts via dry-run, and rebases if clean. Prints conflicting files and exits 1 if a conflict is detected. Separate from `sp sync` — sync is push-only.
- `src/git/behind.ts` — `fetchRemote` and `isStackBehindTrunk` primitives used by `sp rebase`
- PR status cache stored in `refs/spry/prs` — `sp view` now reads PR status instantly from a local git ref written by `sp sync`, with no `gh` API calls needed. Teammates can get PR status via `git fetch` without gh auth.
- `sp sync` writes and pushes `refs/spry/prs` after each run; `sp view` reads from it.
- `src/gh/pr-cache.ts` — `loadPRCache`, `savePRCache`, `fetchPRCache`, `pushPRCache`
- `enrichFromCache` in `src/gh/enrich.ts` — synchronous cache-backed unit enrichment

- `sp group` command — interactive TUI for grouping, renaming, and reordering commits
  - ↑↓ to move cursor, ←→ to assign/remove group membership
  - Space to grab a commit and reorder via ↑↓; live conflict prediction as you drag
  - `r` to rename the group at the cursor (inline edit mode)
  - Groups saved as JSON records in `refs/spry/groups` — no commit rewrites needed for grouping
  - Reordering rewrites the commit chain via plumbing
  - PR adoption: if commits being grouped already have open PRs, group inherits the PR ID automatically (single PR) or prompts for selection (multiple PRs)
  - Pushes `refs/spry/groups` to the remote after saving (best-effort)
- `saveAllGroupRecords` in `src/git/group-titles.ts` — atomic write of all group records
- Integration tests for `sp group` TUI: assign, rename, cancel, and reorder scenarios (`tests/commands/group.test.ts`)
- Doc tests for `sp group` producing generated docs for the Grouping and Reordering sections (`tests/commands/group.doc.test.ts`)
- Generated docs for `sp group` (`docs/generated/commands/group.md`, `docs/generated/commands/group.html`)

### Changed

- Group membership now stored in `refs/spry/groups` alongside titles instead of `Spry-Group` commit trailers. Each group record is a JSON blob `{"title":"...","members":["commitId1",...]}`. `parseStack` now accepts an explicit `CommitGroupMap` (Spry-Commit-Id → groupId) instead of reading `Spry-Group` from commit messages, so grouping never requires a commit rewrite.
- `loadGroupTitles`/`saveGroupTitle`/`fetchGroupTitles` replaced by `loadGroupRecords`/`saveGroupRecord`/`fetchGroupRecords` plus `buildCommitGroupMap` and `extractGroupTitles` helpers.
- `sp view` now fetches and loads group records so groups appear correctly (previously group titles were not loaded in view).

### Added

- Group-title storage (`loadGroupTitles` / `saveGroupTitle` / `fetchGroupTitles` in `src/git/group-titles.ts`) persists group titles as a metadata commit tree at `refs/spry/groups`; portable across clones and collaborators
- `sp sync` fetches `refs/spry/groups` from the remote before parsing so group PRs receive their stored titles
- `sp sync --open <group-id>` now works for group units
- `formatPRBody` returns empty string for group units instead of throwing
- Doc-fragment `doc.scrub(repo | pattern, replacement?)` helper so generated docs stay deterministic across test runs (eliminates per-run churn from random repo unique IDs and temp paths)
- GitHub integration module (`src/gh/`) — read-only PR lookup
  - `findPRsForBranches(ctx, branches)` returns `Map<branch, PRInfo | null>` with state, baseRef, checks status, and review decision
  - Per-branch GraphQL queries via `gh api graphql`; auth/install failures surface as typed `GhAuthError` / `GhNotInstalledError` throws
  - `withRetry` helper with exponential backoff (±20% jitter, max 3 attempts) for transient network/5xx failures
- `createRealGhClient` factory promoted from `tests/lib/` to `src/lib/context.ts`; CLI now wires a real gh client into `SpryContext`
- CLI entry point (`src/cli/index.ts`) and `sp view` command (`src/commands/view.ts`)
  - `sp view` orchestrates: load config, get branch, get commits, parse trailers, parse stack, format, output
  - CLI built on Commander with extensible command structure
- `formatStackView` and `formatValidationError` UI formatters (`src/ui/format.ts`) for terminal-friendly stack display
  - Auto-generated sequential letter titles (A, B, C...) for untitled groups
  - Status icon legend (no PR, open, merged, closed)
  - Split-group validation error formatting with remediation steps
- Git operations module (`src/git/`) with explicit config, queries, plumbing, rebase, conflict prediction, and status
  - Explicit `spry.trunk` and `spry.remote` config required (no auto-detection)
  - Git version check (requires 2.40+) at config load
  - Plumbing-based rebase and commit chain rewriting via GitRunner DI
  - Conflict prediction for TUI commit reordering
- `parseCommitTrailers` batch helper to bridge `CommitInfo[]` to `CommitWithTrailers[]` for stack parsing
- Core parsing module (`src/parse/`) with types, trailer parsing, stack detection, commit ID generation, title resolution, identifier resolution, input validation
- `stdin` support for `GitRunner`/`CommandOptions` in test lib
- Doc-producing tests for `sp view` (`tests/commands/view.doc.test.ts`) — first tests that double as the source of user-facing docs
- Doc-fragment disk bridge: `docTest` writes passing fragments to `.test-tmp/doc-fragments/`; `scripts/build-docs.ts` reads them and produces `docs/generated/<section>.md`
- `docs:build` and `docs:clean` npm scripts
- `fragmentPath` helper exported from `tests/lib` for deterministic fragment file paths
- `sp view` now enriches each unit with PR state (◐ open, ✓ merged, ✗ closed),
  PR URL, checks status, review decision, and resolved-comment count on a
  two-line layout. Defaults to enrichment; falls back to local-only with a
  hint when gh is missing, unauthenticated, the repo isn't a GitHub repo, or
  the network is unreachable.
- `sp view --no-fetch` flag for offline/CI use (skips GitHub enrichment).
- `spry.branchPrefix` config (required) — derives PR branch names as
  `<prefix>/<unit-id>`. For legacy parity, set to `spry/<your-username>`.
- `branchForUnit(unit, config)` helper in `src/git/branch.ts`.
- `enrichUnits(ctx, units, config)` orchestrator in `src/gh/enrich.ts` that
  classifies infra failures into `EnrichmentError` (`no-gh` | `auth` |
  `network` | `no-remote`).
- `PRInfo.reviewThreads: { resolved, total }` from extended GraphQL query.
- `sp sync` command — first writer in the rebuild.
  - Bare `sp sync` injects missing `Spry-Commit-Id` trailers, then pushes any
    units whose `<branchPrefix>/<unit-id>` ref already exists on the remote.
    Never creates new remote branches. Force-with-lease semantics. After
    pushing, looks up PRs and retargets any whose base ref doesn't match the
    current local stack order. If gh is unavailable (no-gh / auth /
    no-remote / network), prints a hint and exits cleanly — branches were
    still pushed.
  - `sp sync --open <ids>` (comma-separated, full or prefix-matched unit
    IDs) pushes branches and creates PRs for the selected single-commit
    units. PR title = commit subject; PR body = commit prose with all
    trailers stripped. Each PR is opened with the appropriate base from the
    local stack order. Errors if any target is a group, has no match, has
    multiple matches, or already has a published branch. If a target's push
    fails, dependent targets are skipped to avoid `gh pr create --base
<missing-branch>`.
  - `sp sync --open` (no value) drops into a TUI multi-select listing the
    units that don't yet have remote branches; cancellable with Esc/Ctrl+C.
    Already-published and group units are shown disabled with a hint.
    Cancelling falls through to the retarget phase so push-phase work is
    still reconciled.
  - Partial failures (push or PR-creation errors) cause the command to
    print `⚠ Sync completed with warnings` and exit 1, so CI scripts catch
    them.
- `src/gh/pr-body.ts` — pure `formatPRTitle`, `formatPRBody`, and
  `stripTrailers` helpers. `stripTrailers` removes the entire trailer block
  (Spry-Commit-Id, Co-Authored-By, Signed-off-by, etc.) when preceded by a
  blank line.
- `src/gh/push.ts` — `pushBranch` (force-with-lease, classifies stale-ref
  vs other rejection) and `listRemoteBranches` (returns `Set<string>` for a
  given prefix).
- `src/gh/pr.ts` — `createPR` and `retargetPR` write operations. Both use
  the shared retry predicate; bodies are passed via stdin (`--body-file -`)
  to avoid shell-quoting and arg-length limits.
- `createRealGhClient` extended to forward `stdin` symmetrically with
  `createRealGitRunner`.
- `src/tui/select.ts` — multi-select widget over the Phase 1
  `TerminalDriver`. Handles Space/Enter/Esc/Ctrl+C/'a'/Arrow keys with
  wrap-around. First feature use of the PTY infrastructure. Restores
  terminal state on errors and signals (SIGINT/SIGTERM).
- `src/git/queries.ts` — `getStackCommits`/`getStackCommitsForBranch` now
  use `%b` (body without subject) so `CommitInfo.body` matches the contract
  the rest of the codebase already assumed. `parseCommitTrailers` and
  `injectMissingIds` reconstruct full messages before calling
  `git interpret-trailers --parse`.

### Changed

- Reset codebase for test-first rebuild. Testing infrastructure is now the foundation.
- Removed the in-memory doc-fragment collection API (`collectFragment`, `getDocFragments`, `clearDocFragments`). Disk is now the single source of truth for fragments.

## [1.0.0-beta.5] - 2026-02-24

### Added

- `sp sync --all` to sync all Spry-tracked branches in the repository at once
  - Discovers branches with Spry-Commit-Id trailers
  - Rebases each branch onto the remote default branch without manual checkout
  - Injects missing Spry-Commit-Ids before rebasing
  - Predicts conflicts and skips branches that would fail (never enters failed rebase state)
  - Validates stack structure and skips branches with split groups
  - Handles worktrees: skips dirty ones, updates clean ones after rebase
  - Clear summary showing rebased vs skipped branches with reasons
- Branch-aware core functions: `injectMissingIds()`, `predictRebaseConflicts()`, `rebaseOntoMain()` now accept optional `branch` parameter
- `validateBranchStack()` function to detect split groups on any branch
- `listSpryLocalBranches()` function to discover all Spry-tracked local branches

## [1.0.0-beta.4] - 2026-01-28

### Fixed

- Group titles now display correctly in `sp view` (were showing fallback subjects instead of stored titles)
- Adding commits to an existing group via `sp group` now preserves the group ID, maintaining PR association

## [1.0.0-beta.3] - 2026-01-20

### Added

- Configurable remote name via `spry.remote` config option (no longer hardcoded to 'origin')
- Smart remote auto-detection: uses single remote if only one exists (persists to config), falls back to 'origin' if present among multiple, or prompts user to configure
- `sp sync` now automatically fetches from remote and rebases the current stack onto the remote default branch if behind
- `sp sync` now fast-forwards the local default branch if it's behind the remote (without checking it out)
- `sp sync` now predicts rebase conflicts before rebasing; warns user instead of starting a rebase they'd need to abort

### Changed

- Show progress feedback ("Creating PR for... #number") when opening PRs for the first time
- PR footer now says "beta" instead of "alpha"

### Fixed

- User-facing messages now reference `sp` instead of `spry` for command suggestions
- `sync --open -i` now only pushes branches up to the last commit with a PR, avoiding unnecessary branch pushes for unselected commits

## [1.0.0-beta.2] - 2026-01-12

### Added

- GitHub API retry logic with exponential backoff and jitter
- Rate limit detection with automatic wait-and-retry
- Concurrency limiting (max 5 parallel GitHub API calls)
- Input validation for branch names, PR titles, and commit identifiers with clear error messages
- Detached HEAD state detection with helpful error messages and remediation steps

### Changed

- Performance improvements: reduced GitHub API calls in view and land commands through batched PR lookups

### Fixed

- GitHub API pagination for large repos (gh pr list now fetches up to 500 PRs)

## [1.0.0-beta.1] - 2026-01-10

### Added

- PR body generation with commit message content
- Stack links in PR bodies showing all PRs with GitHub native references (#123 format)
- PR template support with configurable placement (prepend, afterBody, afterStackLinks, append)
- User-editable content preservation between Spry markers on sync
- Content hash tracking to avoid unnecessary PR body updates
- Warning footer in generated PR bodies
- New config options: `spry.showStackLinks`, `spry.includePrTemplate`, `spry.prTemplateLocation`
- Validation that groups have stored titles before creating PRs
- New flag `--allow-untitled-pr` to bypass title validation and use first commit subject

### Changed

- **BREAKING**: `sp clean --force` renamed to `--unsafe` for commit-id matched branches
  - Safe branches (exact SHA match) are deleted by default
  - Unsafe branches (commit-id trailer match only) require explicit `--unsafe` flag
- Split groups in non-TTY mode now require explicit fix method (`--dissolve` or `--regroup`)

### Fixed

- CLI help now shows correct binary name (`sp`) and tagline

## [0.1.0-alpha.5] - 2026-01-09

### Changed

- **BREAKING**: Renamed tool from "taspr" to "spry" (binary: `sp`)
  - Git config keys: `taspr.*` → `spry.*`
  - Git trailers: `Taspr-Commit-Id` → `Spry-Commit-Id`, `Taspr-Group` → `Spry-Group`
  - Branch prefix default: `taspr/` → `spry/`
  - Environment variables: `TASPR_*` → `SPRY_*`

## [0.1.0-alpha.4] - 2026-01-09

### Changed

- CLI version now read from package.json
- Simplified group display in view command

## [0.1.0-alpha.3] - 2026-01-09

### Added

- Behind detection for stacks needing rebase
- Automated rebase onto main with conflict detection
- Group editor TUI with reorder and conflict prediction
- Interactive group dissolve with multi-select
- Squash-resilient group markers
- Selective PR opening with `--apply`, `--up-to`, and `-i` flags
- Progress indicators during PR/branch status fetching

### Changed

- Major performance improvement: use git plumbing instead of interactive rebase (no working directory writes)
- Batched PR lookups for faster sync performance

### Fixed

- Git hooks disabled during rebases with `--no-verify`
- Temporary commits (WIP, fixup!) skipped during PR creation

## [0.1.0-alpha.2] - SKIPPED

## [0.1.0-alpha.1] - 2026-01-08

### Added

- Initial release with core stacked PR workflow
- `taspr view` - Display commit stack with PR status indicators
- `taspr sync` - Push commits as branches and open PRs
- `taspr land` - Fast-forward merge PRs with CI/review checks
- `taspr clean` - Remove orphaned branches
- Commit grouping for multi-commit PRs
- GitHub integration with PR status, checks, and review tracking
- Curl installation script for easy setup
