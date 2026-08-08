# rebase

When your stack is already based on the latest trunk, `sp rebase` fetches and exits cleanly:

```
sp rebase
```

```
✓ Already up to date

```

When trunk has new commits, `sp rebase` fetches, detects the gap, and replays your stack on top — no conflicts, no prompts:

```
sp rebase
```

```
✓ Rebased 1 commit onto main

```

If rebasing would produce a conflict, `sp rebase` reports the conflicting files and exits without touching your working tree. Nothing is rewritten:

```
sp rebase
```

```
✗ Rebase would conflict on commit 7c3d9e2f: Add API handler

  Conflicting files:
    - api.ts

  Resolve the upstream changes manually, then run `sp rebase` again.
  Or use `git rebase` for interactive conflict resolution.

```

When all tracked branches are already based on the latest trunk, `sp rebase --all` fetches and reports each as up to date:

```
sp rebase --all
```

```
main: ✓ already up to date
feature: ✓ already up to date

```

`sp rebase --all` treats the local default branch as an implicit member: when it is behind trunk with no commits of its own, it is fast-forwarded up to trunk:

```
sp rebase --all
```

```
main: ✓ Fast-forwarded to main

```

When multiple tracked branches are behind trunk, `sp rebase --all` rebases each one in turn without requiring a manual checkout:

```
sp rebase --all
```

```
main: ✓ already up to date
feature-one: ✓ Rebased 1 commit onto main
feature-two: ✓ Rebased 2 commits onto main

```
