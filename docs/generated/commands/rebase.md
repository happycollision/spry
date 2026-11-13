# rebase

When your stack is already based on the latest trunk, `sp stack rebase` fetches and exits cleanly:

```
sp stack rebase
```

```
✓ Already up to date

```

When trunk has new commits, `sp stack rebase` fetches, detects the gap, and replays your stack on top — no conflicts, no prompts:

```
sp stack rebase
```

```
✓ Rebased 1 commit onto main

```

If rebasing would produce a conflict, `sp stack rebase` reports the conflicting files and exits without touching your working tree. Nothing is rewritten:

```
sp stack rebase
```

```
✗ Rebase would conflict on commit 7c3d9e2f: Add API handler

  Conflicting files:
    - api.ts

  Resolve the upstream changes manually, then run `sp stack rebase` again.
  Or use `git rebase` for interactive conflict resolution.

```

When all tracked branches are already based on the latest trunk, `sp stack rebase --all` fetches and reports each as up to date:

```
sp stack rebase --all
```

```
feature: ✓ already up to date

```

When multiple tracked branches are behind trunk, `sp stack rebase --all` rebases each one in turn without requiring a manual checkout:

```
sp stack rebase --all
```

```
feature-one: ✓ Rebased 1 commit onto main
feature-two: ✓ Rebased 2 commits onto main

```
