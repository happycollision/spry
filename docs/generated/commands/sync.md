# sync

Run `sp sync` to push your stack's commits to their already-published remote branches. Spry derives each branch as `<spry.branchPrefix>/<unit-id>` and only pushes branches that already exist on the remote — it never creates new ones. Use `sp sync --open` to publish for the first time.

```
sp sync
```

```
↑ pushed spry/dondenton/aaa11111
PR retargeting unavailable: <hint>
✓ Sync complete

```

Use `sp sync --open <id>` to publish a commit for the first time — Spry pushes the branch and opens a PR on GitHub targeting trunk (or the previous unit's branch for a stacked PR):

```
sp sync --open aaa11111
```

```
↑ pushed spry/dondenton/aaa11111
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
✓ Sync complete

```

After pushing, `sp sync` checks each open PR's base and retargets any that are wrong. This keeps your stacked PRs pointing at each other rather than trunk as the stack evolves:

```
sp sync
```

```
↑ pushed spry/dondenton/aaa11111
↑ pushed spry/dondenton/bbb22222
↻ retargeted PR #11 → spry/dondenton/aaa11111
✓ Sync complete

```
