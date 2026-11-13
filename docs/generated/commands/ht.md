# ht

```
sp ht help
```

```
Happy Trees — Easier worktree gardening
Usage: sp ht <command> [command-options]

Commands:
  help                  Show help
  list, ls              List linked worktrees and flag ambiguous identities
  checkout, co [branch [base]] [-s|--skip-setup] [-e|--exec <command>] [-E|--no-exec]
                        Create a worktree or run exec in an existing worktree
  remove [branch] [--force]
                        Remove a worktree; delete its local branch only on a remote SHA match
  destroy [branch] [--force]
                        Remove a worktree and its local and origin branches
  setup [--init [path]]  Run setup in a linked worktree or create a setup template

Omitting a branch requires -i: sp -i ht co (or remove/destroy) opens an fzf
selector in a terminal. SPRY_NON_INTERACTIVE=1 disables interactive input even
with -i. Checkout lists worktrees first, then local and origin branches by
commit recency. Destroy excludes the default branch.
Destroy refuses dirty or path-mismatched worktrees unless --force is given.

Git configuration (local or --global):
  happy-trees.worktreesDir  Default: <repo_root>/../<repo_name>.worktrees
  happy-trees.defaultBranch  Default: origin/HEAD, origin/main, origin/master, main, master
  happy-trees.exec           Shell command run inside the worktree after checkout
  happy-trees.setupLocation  Executable script receiving repo root and worktree root
  happy-trees.failDestroyOnPathMismatch  Default: true; false disables the path gate

Path tokens: <repo_root>, <repo_name>, and (for setup) <worktree_root>.
Existing worktrees are found by branch regardless of worktreesDir.
Setup runs automatically on creation; -s skips it. -e overrides configured exec;
-E skips exec. Setup and exec failures leave newly created worktrees in place.
Setup and exec receive closed stdin unless -i is set with a usable terminal.
Scripts and Git hooks are external code and can still open /dev/tty themselves;
to skip setup and exec, use: sp ht co <branch> -s -E.
Remove compares local and origin SHAs without fetching. --force permits dirty
removal. Destroy always protects the default branch, even with --force.
Removing your current worktree leaves your shell in a stale directory.
For separate Git admin directories without core.worktree, run checkout from the
primary worktree once before using externally created linked worktrees.


```

Create a branch and worktree from the default branch. Existing Happy Trees Git configuration also applies to Spry. Explicit branch arguments need no interactive permission. Use sp ht co <branch> -s -E to skip setup and exec scripts; otherwise they still run, with closed stdin by default. Scripts and Git hooks can independently open /dev/tty, so closed stdin is not a sandbox for external code.

```
sp ht co feature/login -s -E
```

```
Created worktree at: /tmp/repo/trees/feature/login

Next steps:
  cd /tmp/repo/trees/feature/login && sp ht setup

```

```
sp ht ls
```

```
feature/login	/tmp/repo/trees/feature/login

```

```
sp ht setup --init
```

```
Setup script created: /tmp/repo/setup-worktree.sh
Git config set: happy-trees.setupLocation = <repo_root>/setup-worktree.sh

Next steps:
Edit /tmp/repo/setup-worktree.sh, then run 'sp ht setup' from inside a worktree.

```

```
sp ht setup
```

```
Running setup for worktree: /tmp/repo/trees/feature/login
Using setup script: /tmp/repo/setup-worktree.sh
Setup complete for worktree: /tmp/repo/trees/feature/login
Setup completed successfully

```

```
sp ht remove feature/login
```

```
Removed worktree: /tmp/repo/trees/feature/login
Kept local branch 'feature/login' (no remote branch exists)

To delete the local branch:
  git branch -D feature/login

```

```
sp ht co feature/login -s
```

```
Created worktree at: /tmp/repo/trees/feature/login

Next steps:
  cd /tmp/repo/trees/feature/login && sp ht setup

```

```
sp ht destroy feature/login
```

```
Removed worktree: /tmp/repo/trees/feature/login
Deleted local branch: feature/login

```

Branch selectors are opt-in, even in a terminal: use sp -i ht co, sp -i ht remove, or sp -i ht destroy. Both stdin and stdout must be terminals with a usable TERM. SPRY_NON_INTERACTIVE=1 always disables interactive input, including with -i. Without a branch, Spry refuses before reading repository or Git configuration.

```
sp ht co
```

```
✗ Interactive input is disabled by default; use -i, --interactive to opt in.
Provide a branch explicitly: sp ht co <branch> -s -E

```

```
sp ht remove
```

```
✗ Interactive input is disabled by default; use -i, --interactive to opt in.
Provide a branch explicitly: sp ht remove <branch>

```

```
sp ht destroy
```

```
✗ Interactive input is disabled by default; use -i, --interactive to opt in.
Provide a branch explicitly: sp ht destroy <branch>

```

```
sp ht co --bogus
```

```
✗ Unknown option: --bogus

```

```
sp ht co one two three
```

```
✗ Too many arguments

```

```
sp ht co -e
```

```
✗ -e requires a command

```

```
sp ht remove missing
```

```
✗ No worktree found for branch 'missing'

```

```
sp ht destroy main --force
```

```
✗ Cannot destroy the default branch 'main'

```

```
sp ht setup
```

```
✗ Setup location not configured. Run 'sp ht setup --init'

```

Separate Git admin directories without core.worktree need one checkout invocation from the primary worktree to register its location. Worktrees created by sp ht already have that context.

```
sp ht ls
```

```
✗ Cannot determine primary working directory. Run sp ht checkout from the primary worktree first.

```

```
sp ht co topic -E
```

```
Worktree already exists: /tmp/repo/trees/topic

Next steps:
  cd /tmp/repo/trees/topic

```

```
sp ht ls
```

```
topic	/tmp/repo/trees/topic

```
