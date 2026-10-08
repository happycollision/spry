The `git-ht-test.sh` fixture is an unchanged copy of
`/Users/don.denton/dotfiles/test/git-ht-test.sh` from Happy Trees.
SHA-256: `c9d472637782eb909ff67d647c60d9fbdbd4ed9478ea860d50dcf750ce13e17b`.

`tests/commands/ht.test.ts` creates a temporary dotfiles-shaped directory and
runs this suite with a compatibility executable that invokes `sp ht`. The adapter
forwards arguments and exit status, and maps the help usage spelling to `git ht`.
It combines stdout/stderr and normalizes trailing newlines for the shell suite’s
substring checks. The `GIT_HT_DUMP` selector hooks remain available. The original dotfiles
source and suite remain untouched. The suite uses temporary local Git remotes
and covers normal/bare repositories with/without an origin.

Behavior inventory:

| Surface                                | Coverage                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| help, `-h`, `--help`, unknown commands | Shell assertions; generated help doc                                                                              |
| list/ls                                | Linked, external, mismatched, nested branch, detached worktrees                                                   |
| checkout/co                            | Existing/new branches, explicit base validation, configured directories, existing worktree reuse                  |
| `-s`, `--skip-setup`                   | Skip automatic setup and suggest manual setup                                                                     |
| `-e`, `--exec`, `-E`, `--no-exec`      | Overrides, configured shell command, cwd, multiple words, nonfatal failures                                       |
| remove, `--force`                      | Registered paths, dirty checks, exact local/live-origin SHA match, local branch retention                         |
| destroy, `--force`                     | Local/origin deletion, default-branch protection, combined path/dirty gates, config-disabled path gate            |
| setup, `--init [path]`                 | Template, chmod, nested/absolute/relative paths, overwrite/config guards, automatic/manual execution and failures |
| configuration                          | Existing `happy-trees.*` namespace; default branch fallback; all three path tokens                                |
| fzf entry generation                   | Worktrees first, recency, local/remote dedup, main-repo exclusion, multiline input                                |

The shell suite validates selector entries through the preserved `GIT_HT_DUMP`
hook. Spry's additional tests exercise selection and cancellation using a stub
fzf executable; terminal rendering by fzf itself is outside this suite.

Intentional safety improvement: remove compares the local SHA with the live
origin SHA, rather than preferring a possibly stale tracking ref. A mismatch or
failed origin query retains the local branch. The unchanged shell suite remains
green; Spry adds a stale-tracking-ref regression test for this uncovered case.
