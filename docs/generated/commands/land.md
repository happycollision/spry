# land

`sp land --through <id>` lands the stack from the bottom **through** the unit identified by `<id>` (a group ID, unit-ID prefix, or commit-hash prefix). Spry fast-forwards trunk to that unit's tip — it never uses the GitHub merge API and never retargets PR bases. GitHub marks each PR `MERGED` because its commits become reachable from the default branch; leaving each PR on its stacked base keeps that PR's diff scoped to just its own unit. `sp land` never deletes branches (that is `sp clean`'s job):

```
sp land --through aaaa1111
```

```
✓ Updated PR cache (2 PRs)
✓ Landed 2 PRs to main
  Run `sp clean` to delete the landed branches from the remote.

```

Run `sp land` with no arguments to choose the land point interactively. Spry shows a single-select menu of the stack's units (bottom→top) — use ↑/↓ to move, Enter to select. The chosen unit becomes the `--through` target:

```
sp land
```

```
Select the unit to land through (↑/↓ move, enter select, esc cancel):
> bbbb2222  Add login
  aaaa1111  Add logout

```

If CI is still running, a non-interactive `sp land` (no TTY — e.g. in a script or CI job) can't prompt to wait, so it prints a ready-to-copy re-invoke command and exits non-zero instead of blocking:

```
sp land --through aaaa1111
```

```
✓ Updated PR cache (2 PRs)
Run `sp land --through aaaa1111 --poll` to wait for CI and land automatically.

```

Pass `--poll` to wait for CI instead of nudging: `sp land` re-checks on a cadence (30s by default; `--interval <seconds>` to change it) and lands automatically the moment every in-scope PR is green:

```
sp land --through aaaa1111 --poll
```

```
⧗ CI pending on #1001, #1005; polling every 8s (Ctrl-C to stop)…
  …
✓ Landed 2 PRs to main

```
