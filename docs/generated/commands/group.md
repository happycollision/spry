# group

Run `sp group` to open the interactive group editor. Use ↑↓ to move between commits and ←→ to assign or remove group membership. Commits in the same group ship as a single PR.

```
Stack: feature/auth (3 commits)

   1  aaa1111  Add login form                           [A: Auth Flow]
▶  2  bbb2222  Add session handling                     [A]
   3  ccc3333  Fix typo in README

↑↓ cursor  ←→ group  Space grab  r rename  Enter save  q quit

```

Press `r` to rename the group at the cursor. Type a title and press Enter to confirm, or Esc to cancel.

```
Stack: feature/auth (2 commits)

   1  aaa1111  Add login form                           [A: Auth▌]
▶  2  bbb2222  Add session handling                     [A]

RENAME MODE — Type title  Enter confirm  Esc cancel

```

Press Space to grab a commit and ↑↓ to reorder it. Spry predicts rebase conflicts as you move — rows with ⚠ may conflict. Press Space or Enter to drop the commit at its new position.

```
Stack: feature/auth (2 commits)

●  1  aaa1111  Add session handling
   2  bbb2222  Add login form

MOVE MODE — ↑↓ reorder  Space/Enter drop  Esc cancel

```

While reordering, Spry predicts rebase conflicts in the background. Rows marked with ⚠ are likely to conflict if dropped in their current position.

```
Stack: feature/config (2 commits)

●  1  aaa1111  Set version to 2                         ⚠
   2  bbb2222  Set version to 1                         ⚠

MOVE MODE — ↑↓ reorder  Space/Enter drop  Esc cancel
⚠ Moving this commit may cause a conflict

```
