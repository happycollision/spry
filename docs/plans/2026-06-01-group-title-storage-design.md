# Group Title Storage Design

**Date:** 2026-06-01  
**Step:** sp group — Step 7 (partial: storage read path only)

## Goal

Store group titles in a way that survives clones and syncs across machines and collaborators, so `sp sync` can use them when building PRs for group branches.

## Storage Mechanism

A **metadata commit tree** at `refs/spry/groups`.

The ref points to a commit whose tree is a flat directory. Each entry is a file named by group ID containing the title string as its content:

```
refs/spry/groups → commit
  tree:
    grp00001  →  "Auth Feature"
    f7e8d9c0  →  "Login Flow"
```

### Why this over alternatives

- **git config** — local only, doesn't survive clone or share with collaborators. Ruled out.
- **git notes** — portable but not fetched by default; confusing fetch configuration. Close but worse UX.
- **annotated tags** — first-class and portable, but one tag per group clutters `git tag -l` and the tag message field is an awkward fit for structured metadata.
- **metadata commit tree** — behaves like git notes but under a clean, dedicated ref namespace. Full commit history for free. Push/pull with a single explicit refspec. Extensible to richer metadata (description, etc.) by adding files per group later.

## `sp sync` Integration (this step)

`sp sync` is the only command touching this in Step 7. It is **read-only**: fetch and load titles; never write.

### Flow

1. `git fetch origin refs/spry/groups:refs/spry/groups`  
   Silent if the remote doesn't have the ref. Network failure is a warning, not a hard error — spry continues with no titles rather than blocking the sync.

2. `git ls-tree refs/spry/groups` + `git cat-file blob refs/spry/groups:<id>` per entry  
   Builds a `GroupTitles` (`Record<string, string>`) map. If the ref is absent, returns `{}`.

3. Pass the map to `parseStack(withTrailers, groupTitles)` so group units get their stored titles.

### Other changes landing in this step

- `formatPRBody` returns `""` for group units instead of throwing — groups have no single commit body.
- Group guard removed from `resolveOpenTargets` — `--open <group-id>` now works.
- Group disable removed from `buildOpenCandidates` — groups appear as selectable in the TUI.

## Deferred to `sp group`

- **Writing titles**: `git hash-object` → `git mktree` → `git commit-tree` → update ref → push
- **Fetch/push wiring in remote config** — may auto-configure the refspec so collaborators get titles on normal `git fetch`
- **Concurrent write handling** — fetch-before-write, fail if diverged (same model as `--force-with-lease`)

## Data Format

Plain UTF-8 text, no framing. The entire blob content is the title. Simple to read, simple to write, no parsing ambiguity.

## Testing

- Unit tests for `loadGroupTitles` using a real temp repo with the ref set up via git plumbing
- `syncCommand` integration test: group with stored title → `--open <group-id>` → PR created with correct title
- `formatPRBody` unit test: group unit → returns `""`
- `buildOpenCandidates` unit test: group unit → not disabled
