# land

`sp land --through <id>` lands the stack from the bottom **through** the unit identified by `<id>` (a group ID, unit-ID prefix, or commit-hash prefix). Spry fast-forwards trunk to that unit's tip — it never uses the GitHub merge API and never retargets PR bases. GitHub marks each PR `MERGED` because its commits become reachable from the default branch; leaving each PR on its stacked base keeps that PR's diff scoped to just its own unit. `sp land` never deletes branches (that is `sp clean`'s job):

```
sp land --through aaaa1111
```

```
↻ retargeted PR #1021 → spry/dondenton/bbbb2222
✓ Updated PR cache (2 PRs)
✓ Sync complete
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
