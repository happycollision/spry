# Core Parsing Module Design

Date: 2026-02-26

## Scope

All pure parsing and validation logic that sits below git operations and commands. This is the foundational layer — everything above depends on it, it depends on nothing except `GitRunner` (for trailer parsing only).

Ported from old `src/core/` and `src/git/trailers.ts`. Excludes `pr-detection.ts` (GitHub dependency) and `group-titles.ts` storage (git-ref I/O deferred to Git operations phase).

## Module: `src/parse/`

### `types.ts` — Shared types

- `CommitInfo` — `{ hash, subject, body, trailers }`
- `CommitTrailers` — `Record<string, string | undefined>` with known keys `Spry-Commit-Id`, `Spry-Group`
- `PRUnit` — `{ type, id, title, commitIds, commits, subjects }`
- `GroupInfo` — `{ id, title, commits }`
- `GroupTitles` — `Record<string, string>` (type alias only, storage deferred)
- `StackParseResult` — discriminated union: ok with units, or split-group error
- `ValidationResult` — `{ ok: true }` | `{ ok: false, error: string }`
- `IdentifierResolution` — discriminated union: ok with unit, not-found, or ambiguous

### `trailers.ts` — Trailer parsing via GitRunner DI

- `parseTrailers(body, git): Promise<CommitTrailers>` — uses `git interpret-trailers --parse`
- `addTrailers(message, trailers, git): Promise<string>` — uses `git interpret-trailers --trailer`

Key change from old code: accepts `GitRunner` as parameter instead of shelling out via `Bun.$`.

### `stack.ts` — PRUnit detection and stack validation

- `CommitWithTrailers` — local type: commit with parsed trailers
- `detectPRUnits(commits, titles?): PRUnit[]` — groups contiguous commits by `Spry-Group`, singles for the rest
- `parseStack(commits, titles?): StackParseResult` — validates group contiguity, then delegates to `detectPRUnits`

### `id.ts` — Commit ID generation

- `generateCommitId(): string` — 8 hex chars from `crypto.randomBytes(4)`

### `title.ts` — Title resolution

- `resolveUnitTitle(unit): string` — stored title, or first subject, or "Untitled"
- `hasStoredTitle(unit): boolean` — true if `unit.title` is defined

### `identifier.ts` — Identifier resolution

- `resolveIdentifier(id, units, commits): IdentifierResolution` — exact match, prefix match, hash match
- `resolveIdentifiers(ids, units, commits): { unitIds, errors }` — batch resolution
- `resolveUpTo(id, units, commits): UpToResolution` — all units from bottom up to target
- `parseApplySpec(json): string[]` — parse JSON array of identifiers with validation

### `validation.ts` — Input validation

- `validateBranchName(name): ValidationResult` — git ref format rules
- `validatePRTitle(title): ValidationResult` — non-empty, no control chars, length limit
- `validateIdentifierFormat(id): ValidationResult` — hex string or group ID format

### `index.ts` — Barrel export

## Test Structure

```
tests/parse/
  trailers.test.ts      # Real git via GitRunner + createRepo()
  stack.test.ts         # Pure unit tests, hand-crafted commit data
  id.test.ts            # Format and uniqueness checks
  title.test.ts         # Pure unit tests with PRUnit fixtures
  identifier.test.ts    # Pure unit tests with PRUnit/commit fixtures
  validation.test.ts    # Table-driven pure unit tests
```

## Design Decisions

1. **Trailers take `GitRunner` as explicit parameter** — simple, testable, no context object needed at this layer.
2. **`CommitWithTrailers` defined locally in `stack.ts`** — only used there, keeps `types.ts` focused on cross-module types.
3. **`GroupTitles` is a type alias only** — `Record<string, string>`. Git-ref storage goes in Git operations phase.
4. **`pr-detection.ts` excluded** — depends on GitHub API, belongs in Phase 2 step 4.
5. **Trailer tests use real git** — `git interpret-trailers` is deterministic; create temp repo via test lib, use `createRealGitRunner()`.
