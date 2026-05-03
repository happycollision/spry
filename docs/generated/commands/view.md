# view

View the current stack of commits on your feature branch (use --no-fetch for offline/CI):

```
sp view --no-fetch
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
sp view --no-fetch
```

```
No commits ahead of origin/main

```

If gh isn't installed, isn't authenticated, or can't reach GitHub, sp view falls back to local mode with a hint:

```
sp view
```

```
Stack: feature (1 commit)
PR status unavailable: <hint> (showing local view)
○ no PR  ◐ open  ✓ merged  ✗ closed

  → origin/main
────────────────────────────────────────────────────────────────────────
  ○ Add login page (aaa11111)
────────────────────────────────────────────────────────────────────────

```
