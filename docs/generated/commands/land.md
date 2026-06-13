# land

`sp land --through <id>` lands the stack from the bottom **through** the unit identified by `<id>` (a group ID, unit-ID prefix, or commit-hash prefix). Spry retargets every in-scope PR onto trunk and then fast-forwards trunk to that unit's tip — it never uses the GitHub merge API. Retargeting first is what makes GitHub mark each PR `MERGED` rather than `CLOSED`. `sp land` never deletes branches (that is `sp clean`'s job):

```
sp land --through aaaa1111
```

```
↑ pushed spry/dondenton/bbbb2222
↑ pushed spry/dondenton/aaaa1111
↻ retargeted PR #2 → spry/dondenton/bbbb2222
✓ Updated PR cache (2 PRs)
✓ Sync complete
✓ Landed 2 PRs to main

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
