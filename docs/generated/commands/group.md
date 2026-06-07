# group

Run `sp group` to open the interactive group editor. Use ↑↓ to move between commits and ←→ to assign or remove group membership. Commits in the same group ship as a single PR.

```
Stack: feature/auth (3 commits)

   1  af62d1e  Add login form                           [A: Auth Flow]
▶  2  ade6a45  Add session handling                     [A: Auth Flow]
   3  2fd526c  Fix typo in README

↑↓ cursor  ←→ group  Space grab  r rename  Enter save  q quit

```

Press Space to grab a commit and ↑↓ to reorder it. Spry predicts rebase conflicts as you move — rows with ⚠ may conflict. Press Space or Enter to drop the commit at its new position.

```
Stack: feature/auth (2 commits)

●  1  68c3485  Add session handling
   2  98eb567  Add login form

MOVE MODE — ↑↓ reorder  Space/Enter drop  Esc cancel

```
