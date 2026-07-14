# sync

Run `sp sync` to push your stack's commits to their already-published remote branches. Spry derives each branch as `<spry.branchPrefix>/<unit-id>` and only pushes branches that already exist on the remote — it never creates new ones. Use `sp sync --open` to publish for the first time.

```
sp sync
```

```
PR retargeting unavailable: <hint>
↑ pushed spry/dondenton/aaaa1111
✓ Sync complete

```

Spry skips any branch whose remote tip already matches its local commit, so running `sp sync` again with nothing new does no redundant push — the branch simply isn't listed:

```
sp sync
```

```
PR retargeting unavailable: <hint>
✓ Sync complete

```

Use `sp sync --open <id>` to publish a commit for the first time — Spry pushes the branch and opens a PR on GitHub targeting trunk (or the previous unit's branch for a stacked PR):

```
sp sync --open aaaa1111
```

```
✓ Updated PR cache (1 PR)
↑ pushed spry/dondenton/aaaa1111
✓ Created PR #42: Add login
  https://github.com/owner/repo/pull/42
✓ Updated PR cache (1 PR)
✓ Sync complete

```

When you group commits with `sp group`, `sp sync --open <group-id>` publishes the whole group as a single PR. The PR title is the group's title and its body is left empty by design — the individual commit messages carry the detail:

```
sp sync --open grp00001
```

```
✓ Updated PR cache (1 PR)
↑ pushed spry/dondenton/grp00001
✓ Created PR #42: Auth flow
  https://github.com/owner/repo/pull/42
✓ Updated PR cache (1 PR)
✓ Sync complete

```

Run `sp sync --open` (no arguments) to choose which unpublished branches to open as PRs. Spry shows an interactive menu — use Space to toggle, Enter to confirm:

```
sp sync --open
```

```
Select units to open (space toggle, a all, enter confirm, esc cancel):
> [ ] aaaa1111  Add login

```

```
↑ pushed spry/dondenton/aaaa1111
✓ Created PR #42: Add login
  https://github.com/owner/repo/pull/42
✓ Updated PR cache (1 PR)
✓ Sync complete

```

On a branch with no commits ahead of trunk, `sp sync` no-ops:

```
sp sync
```

```
✓ No commits in stack

```

If a commit lacks a `Spry-Commit-Id` trailer, `sp sync` rewrites it with one before doing anything else. This happens automatically on first use:

```
sp sync
```

```
✓ Injected 1 commit ID(s)
PR retargeting unavailable: network error (branches still updated)
✓ Sync complete

```

When you keep several independent stacks in flight, `sp sync --all` pushes every tracked stack's already-published branches in one run — no need to check each one out. It is push-only: it never rebases and never opens new PRs (use `sp rebase --all` to restack, and `sp sync --open` to publish).

```
sp sync --all
```

```
feature/login:
feature/search:
↑ pushed spry/dondenton/bbbb2222
↑ pushed spry/dondenton/aaaa1111
✓ Updated PR cache (2 PRs)
✓ Sync complete

```

Reordering commits in a stack and re-syncing must never mark an open PR as merged. `sp sync` parks every affected PR onto trunk before force-pushing the reordered branches, then re-stacks them — so a reorder is safe:

```
sp sync
```

```
✓ Updated PR cache (2 PRs)
↻ parked PR #42 → main
↑ pushed spry/dondenton/bbbb2222
↑ pushed spry/dondenton/aaaa1111
↻ retargeted PR #42 → main
↻ retargeted PR #42 → spry/dondenton/bbbb2222
✓ Updated PR cache (2 PRs)
✓ Sync complete

```
