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

On a branch with no commits ahead of trunk, `sp sync` no-ops:

```
sp sync
```

```
✓ No commits in stack

```
