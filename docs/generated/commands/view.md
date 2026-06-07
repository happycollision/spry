# view

View the current stack of commits on your feature branch:

```
sp view
```

```
Stack: feature (2 commits)
○ no PR  ◐ open  ✓ merged  ✗ closed

  → origin/main
────────────────────────────────────────────────────────────────────────
  ○ Add login page (aaa11111)
────────────────────────────────────────────────────────────────────────
  ○ Add signup form (bbb22222)
────────────────────────────────────────────────────────────────────────

```

When you're on a branch with no commits ahead of trunk:

```
sp view
```

```
No commits ahead of origin/main

```

sp view reads PR status from a local git ref written by sp sync — no network call needed:

```
sp view
```

```
Stack: feature (1 commit)
○ no PR  ◐ open  ✓ merged  ✗ closed
checks: ✓ pass  ✗ fail  ⏳ pending  — none
approval: ✓ approved  ✗ changes  ? required  — none

  → origin/main
────────────────────────────────────────────────────────────────────────
  ◐ Add login page (aaa11111)
    https://github.com/<owner>/<repo>/pull/42 - checks:✓ approval:— comments:0/2
────────────────────────────────────────────────────────────────────────

```
