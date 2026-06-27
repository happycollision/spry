# clean

Once a stack has landed on trunk, `sp clean` fetches the remote and deletes the spry branches whose tip commits are now ancestors of trunk:

```
sp clean
```

```
✓ Deleted spry/dondenton/login
Cleaned 1 landed branch.

```

Pass `--dry-run` to see which branches would be removed without deleting anything:

```
sp clean --dry-run
```

```
Would delete 1 landed branch:
  spry/dondenton/login
Run `sp clean` to delete them.

```

When no tracked branch has landed yet, `sp clean` leaves every branch in place:

```
sp clean
```

```
✓ No landed branches to clean

```
