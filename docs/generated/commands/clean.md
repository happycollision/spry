# clean

Once a stack has landed on trunk, `sp stack clean` fetches the remote and deletes the spry branches whose tip commits are now ancestors of trunk:

```
sp stack clean
```

```
✓ Deleted spry/dondenton/login
Cleaned 1 landed branch.

```

Pass `--dry-run` to see which branches would be removed without deleting anything:

```
sp stack clean --dry-run
```

```
Would delete 1 landed branch:
  spry/dondenton/login
Run `sp stack clean` to delete them.

```

When no tracked branch has landed yet, `sp stack clean` leaves every branch in place:

```
sp stack clean
```

```
✓ No landed branches to clean

```
