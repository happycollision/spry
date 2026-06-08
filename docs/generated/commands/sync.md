# sync

Run `sp sync` to push your stack's commits to their already-published remote branches. Spry derives each branch as `<spry.branchPrefix>/<unit-id>` and only pushes branches that already exist on the remote — it never creates new ones. Use `sp sync --open` to publish for the first time.

```
sp sync
```

```
↑ pushed spry/dondenton/ddddaaaa
PR retargeting unavailable: <hint>
✓ Sync complete

```

Use `sp sync --open <id>` to publish a commit for the first time — Spry pushes the branch and opens a PR on GitHub targeting trunk (or the previous unit's branch for a stacked PR):

```
sp sync --open ddddaaaa
```

```
↑ pushed spry/dondenton/ddddaaaa
✓ Created PR #42: Add login
  https://github.com/owner/repo/pull/42
✓ Sync complete

```

Run `sp sync --open` (no arguments) to choose which unpublished branches to open as PRs. Spry shows an interactive menu — use Space to toggle, Enter to confirm:

```
sp sync --open
```

```
Select units to open (space toggle, a all, enter confirm, esc cancel):
> [ ] ddddaaaa  Add login

```

```
↑ pushed spry/dondenton/ddddaaaa
✓ Created PR #42: Add login
  https://github.com/owner/repo/pull/42
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

After pushing, `sp sync` checks each open PR's base, retargets any that are wrong, and refreshes the local PR status cache read by `sp view`. No network call is needed at view time — sync is the mechanism that fetches fresh status from GitHub:

```
sp sync
```

```
↑ pushed spry/dondenton/ddddaaaa
↑ pushed spry/dondenton/eeeebbbb
↻ retargeted PR #11 → spry/dondenton/ddddaaaa
✓ Updated PR cache (2 PRs)
✓ Sync complete

```
