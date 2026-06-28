# group

Run `sp group` to open the interactive group editor. Use ↑↓ to move between commits and ←→ to assign or remove group membership. Commits in the same group ship as a single PR.

```
Stack: feature/auth (3 commits)

   1  c5d2a9f  Add login form                           [A: Auth Flow]
▶  2  8e3b6f1  Add session handling                     [A]
   3  7c3d9e2  Fix typo in README

↑↓ cursor  ←→ group  Space grab  r rename  Enter save  q quit

```

Press `r` to rename the group at the cursor. Type a title and press Enter to confirm, or Esc to cancel.

```
Stack: feature/auth (2 commits)

   1  f1a9e4c  Add login form                           [A: Auth▌]
▶  2  7c3d9e2  Add session handling                     [A]

RENAME MODE — Type title  Enter confirm  Esc cancel

```

Press Space to grab a commit and ↑↓ to reorder it. Spry predicts rebase conflicts as you move — rows with ⚠ may conflict. Press Space or Enter to drop the commit at its new position.

```
Stack: feature/auth (2 commits)

●  1  2d7f4a1  Add session handling
   2  8e3b6f1  Add login form

MOVE MODE — ↑↓ reorder  Space/Enter drop  Esc cancel

```

If the working tree is dirty, `sp group` still allows metadata-only grouping and renaming, but disables commit reordering until local changes are cleaned up.

```
Stack: feature/auth (2 commits)

▶  1  2d7f4a1  Add login form
   2  b47e1d0  Add session handling

Reordering disabled: working tree is dirty.
↑↓ cursor  ←→ group  Space disabled  r rename  Enter save  q quit

```

When you group commits and one of them already has an open PR, `sp group` adopts that PR for the new group instead of stranding it. Spry looks up each commit's branch on GitHub before the editor opens, then re-keys the new group's record to the PR's commit on save:

```
↻ adopted PR for group (unit bbbb2222)
✓ Groups updated (1 group)

```

While reordering, Spry predicts rebase conflicts in the background. Rows marked with ⚠ are likely to conflict if dropped in their current position.

```
Stack: feature/config (2 commits)

●  1  b47e1d0  Set version to 2                         ⚠
   2  2d7f4a1  Set version to 1                         ⚠

MOVE MODE — ↑↓ reorder  Space/Enter drop  Esc cancel
⚠ Moving this commit may cause a conflict

```
