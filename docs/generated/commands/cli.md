# cli

Run `sp` for the command namespaces, or `sp stack` for stacked PR operations:

```
sp
```

```
Usage: sp [options] [command]

Spry: Stacked PRs. Develop with alacrity.

Options:
  -v, --version      Output the version number
  -i, --interactive  Permit pickers and confirmations (requires a usable
                     terminal)
  --non-interactive  Never prompt (default; conflicts with --interactive)
  -h, --help         display help for command

Commands:
  stack              Manage stacked pull requests
  ht [args...]       Happy Trees worktree gardening

Interaction is opt-in, even in a terminal. SPRY_NON_INTERACTIVE=1 locks it off.

```

```
sp stack
```

```
Usage: sp stack [options] [command]

Manage stacked pull requests

Options:
  -h, --help         display help for command

Global Options:
  -v, --version      Output the version number
  -i, --interactive  Permit pickers and confirmations (requires a usable
                     terminal)
  --non-interactive  Never prompt (default; conflicts with --interactive)

Commands:
  view [options]     View the current stack of commits with PR status
  sync [options]     Sync the current stack to GitHub
  group [options]    Group and reorder commits (--apply for automation; -i for
                     editor)
  rebase [options]   Fetch, check if behind trunk, and rebase the stack if clean
  land [options]     Land the stack into trunk by fast-forwarding through a
                     chosen commit
  clean [options]    Delete remote spry branches whose commits have landed on
                     trunk

```

The former root commands fail with a migration hint; they never forward to an operation:

```
sp view
```

```
Use sp stack view

```

```
sp sync
```

```
Use sp stack sync

```

```
sp group
```

```
Use sp stack group

```

```
sp rebase
```

```
Use sp stack rebase

```

```
sp land
```

```
Use sp stack land

```

```
sp clean
```

```
Use sp stack clean

```

Spry never opens its own picker or confirmation by default, even in a terminal. Supply explicit arguments for automation; humans can opt in with the global `-i, --interactive` flag and a usable terminal. Missing choices fail before repository or network work:

```
sp stack sync --open
```

```
✗ Interactive input is disabled by default; use -i, --interactive to opt in.
  Use: sp stack sync --open <id1,id2>
  Find IDs: sp stack view --json
  Picker: sp -i stack sync --open

```

```
sp stack group
```

```
✗ Interactive input is disabled by default; use -i, --interactive to opt in.
  Use: sp stack group --apply <json>
  Find IDs and input shape: sp stack view --json
  Editor: sp -i stack group
  Help: sp stack group --help

```

```
sp stack land
```

```
✗ Interactive input is disabled by default; use -i, --interactive to opt in.
  Use: sp stack land --through <id>
  Find IDs: sp stack view --json
  Picker: sp -i stack land

```

Interactive forms are `sp -i stack sync --open`, `sp -i stack group`, `sp -i stack land`, and `sp -i ht co`. `--non-interactive` explicitly asserts the default and conflicts with `-i`. Set `SPRY_NON_INTERACTIVE=1` in orchestration environments to reject either spelling of the opt-in. Explicit `stack land --through <id>` never asks a follow-up question: use `--poll` to wait for CI and `--allow-unresolved-threads` to acknowledge that specific advisory. Neither option bypasses other readiness gates.
