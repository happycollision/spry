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
  ○ Add login page (bbbb2222)
────────────────────────────────────────────────────────────────────────
  ○ Add signup form (aaaa1111)
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
  ◐ Add login page (aaaa1111)
    https://github.com/<owner>/<repo>/pull/42 - checks:✓ approval:— comments:0/2
────────────────────────────────────────────────────────────────────────

```

`sp view` marks how each unit has drifted since your last sync, entirely offline. Right after a sync, nothing is marked:

```
sp view
```

```
Stack: feature (2 commits)
○ no PR  ◐ open  ✓ merged  ✗ closed
checks: ✓ pass  ✗ fail  ⏳ pending  — none
approval: ✓ approved  ✗ changes  ? required  — none

  → origin/main
────────────────────────────────────────────────────────────────────────
  ◐ Add login page (bbbb2222)
    https://github.com/<owner>/<repo>/pull/1 - checks:✓ approval:— comments:0/0
────────────────────────────────────────────────────────────────────────
  ◐ Add signup form (aaaa1111)
    https://github.com/<owner>/<repo>/pull/2 - checks:✓ approval:— comments:0/0
────────────────────────────────────────────────────────────────────────

```

Amend the second commit. Its local tip no longer matches what you pushed, so it is flagged with ✎ — a signal to run `sp sync`:

```
sp view
```

```
Stack: feature (2 commits)
○ no PR  ◐ open  ✓ merged  ✗ closed
checks: ✓ pass  ✗ fail  ⏳ pending  — none
approval: ✓ approved  ✗ changes  ? required  — none
✎ local edits, run sp sync   ↓ remote moved since your push (as of last fetch)

  → origin/main
────────────────────────────────────────────────────────────────────────
  ◐ Add login page (bbbb2222)
    https://github.com/<owner>/<repo>/pull/1 - checks:✓ approval:— comments:0/0
────────────────────────────────────────────────────────────────────────
  ◐ ✎↓ Add signup form (revised) (aaaa1111)
    https://github.com/<owner>/<repo>/pull/2 - checks:✓ approval:— comments:0/0
────────────────────────────────────────────────────────────────────────

```

The ↓ marker means the remote moved since your push (as of your last fetch), and ✎↓ together means both. Units with no recorded sync show no marker at all.

When a stack contains a materialized merge group, `sp view` shows the merge on its own row and indents its member commits beneath it with a ⑃ marker — the merge axis reads as depth:

```
sp view
```

```
Stack: feature (3 commits)
○ no PR  ◐ open  ✓ merged  ✗ closed

  → origin/main
────────────────────────────────────────────────────────────────────────
  ○ feat: base change (p1p1p1p1)
────────────────────────────────────────────────────────────────────────
  ○   ⑃ feat: add model (m1m1m1m1)
────────────────────────────────────────────────────────────────────────
  ○   ⑃ feat: add handler (m2m2m2m2)
────────────────────────────────────────────────────────────────────────

```
