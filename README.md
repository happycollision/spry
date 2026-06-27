# Spry

A CLI tool for managing **stacked pull requests** on GitHub. Organize related commits as interdependent PRs, where each PR builds on the previous one—enabling incremental code review for large features.

## Why Stacked PRs?

Traditional PR workflows force you to either:

- Submit one massive PR that's hard to review
- Manually manage dependent branches and rebase chains

Spry automates the stacked PR workflow:

- Each commit (or group of commits) becomes its own PR
- PRs are automatically chained with proper base branches
- Rebasing onto trunk is a single command (`sp rebase`)
- Land PRs when ready and automatically retarget dependents

## Installation

### Quick Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/happycollision/spry/main/install.sh | bash
```

This downloads the latest stable release and installs it to `~/.spry/bin`.

```bash
# Install a specific version
curl -fsSL https://raw.githubusercontent.com/happycollision/spry/main/install.sh | bash -s -- v0.1.0

# Install the latest prerelease
curl -fsSL https://raw.githubusercontent.com/happycollision/spry/main/install.sh | bash -s -- --prerelease

# Custom install directory
SPRY_INSTALL_DIR=/opt/spry curl -fsSL https://raw.githubusercontent.com/happycollision/spry/main/install.sh | bash
```

### Build from Source

```bash
# Clone the repository
git clone https://github.com/happycollision/spry.git
cd spry

# Install dependencies
bun install

# Compile the CLI to a standalone binary
bun build src/cli/index.ts --compile --outfile dist/sp
```

This creates `./dist/sp` as a compiled executable. Move it where you like and add it to your PATH or create an alias.

On Linux or macOS, it would be something like this:

```bash
# Add to your ~/.bashrc, ~/.zshrc, or similar
alias sp='/path/to/spry/dist/sp'
```

(For development you can skip compiling and run from source via the `scripts/sp`
wrapper, which execs `bun src/cli/index.ts`.)

If you are developing, perhaps you want to point to this dist folder in your current terminal session. Copy/pasting the line below should do it.

```bash
# from the root of the repo
export PATH="$PATH:$(pwd)/dist"
```

### Requirements

- [Bun](https://bun.sh) runtime
- [GitHub CLI](https://cli.github.com/) (`gh`) - authenticated via `gh auth login`
- Git 2.40+

## Configuration

Spry reads its settings from git config. Three keys are **required** — `sp`
will refuse to run until they are set:

```bash
# The trunk branch your stack is based on (e.g. main, master)
git config spry.trunk main

# The remote to push branches and PRs to
git config spry.remote origin

# Prefix for the per-commit branches spry creates (one branch per unit)
git config spry.branchPrefix spry/<your-username>
```

Optional:

```bash
# Override the GitHub repo slug used for PR queries (format: owner/repo).
# Falls back to parsing the remote URL when unset; set this for non-GitHub
# remotes or unusual URL formats.
git config spry.repo owner/repo

# When true, `sp land` deletes the remote branches of the units it just
# landed. Default false. Leave it off (and use `sp clean`) if your repo has
# GitHub's "automatically delete head branches" setting enabled.
git config spry.autoDeleteOnLand true
```

## Quick Start

```bash
# 1. Create some commits on your feature branch
git commit -m "Add user model"
git commit -m "Add user API endpoints"
git commit -m "Add user tests"

# 2. View your stack
sp view

# 3. Sync with GitHub and create PRs
sp sync --open

# 4. When a PR is approved, land it
sp land
```

## Commands

Each command's full behavior, flags, and example output live in the generated
docs (produced from the doc tests, so they never drift from the code):

- [`sp view`](docs/generated/commands/view.md) — display the current stack and PR status
- [`sp sync`](docs/generated/commands/sync.md) — push branches, open PRs (`--open`), push every tracked stack (`--all`)
- [`sp rebase`](docs/generated/commands/rebase.md) — fetch, check if behind trunk, and rebase the stack (`--all` for every tracked branch)
- [`sp land`](docs/generated/commands/land.md) — retarget in-scope PRs to trunk and fast-forward trunk to the target tip (`--through <id>`); scrubs the landed units' cached state, and deletes their remote branches when `spry.autoDeleteOnLand` is set
- [`sp clean`](docs/generated/commands/clean.md) — delete remote spry branches that have landed on trunk (`--dry-run` to preview)
- [`sp group`](docs/generated/commands/group.md) — interactive TUI for grouping and reordering commits

Browse them all in [`docs/generated/commands/`](docs/generated/commands/).

## Core Concepts

### Commit Trailers

Spry uses git trailers (metadata in commit messages) for tracking:

```
feat: Add user authentication

Implements JWT-based auth with refresh tokens.

Spry-Commit-Id: a1b2c3d4
```

`Spry-Commit-Id` trailers are added automatically by `sp rebase`/`sp sync`.

### Grouping Commits

You can group multiple commits into a single PR using `sp group`. Grouping is
stored in `refs/spry/groups` (a JSON record per group), so it never requires a
commit rewrite. All grouped commits become one PR when you `sp sync --open`.
See [`sp group`](docs/generated/commands/group.md) for the interactive editor.

## Limitations

- **No concurrent operation support**: Don't run multiple `sp` commands simultaneously in the same local clone. Not sure why anyone would do this anyway.
- **Trunk and remote are explicit**: spry does not guess. Set `spry.trunk`, `spry.remote`, and `spry.branchPrefix` in git config before running (see [Configuration](#configuration)).

## Development

```bash
# Run the CLI from source (no compile step)
./scripts/sp <command>   # execs `bun src/cli/index.ts`

# Run tests
bun test

# Type checking
bun run types

# Lint
bun run lint

# Format
bun run format

# Run all checks
bun run check
```

### Documentation tests

Some tests double as the source of user-facing documentation. They're written with `docTest` (see `tests/commands/view.doc.test.ts` for an example). When a doc test passes, it writes a JSON fragment to `.test-tmp/doc-fragments/`. The `docs:build` script assembles those fragments into markdown under `docs/generated/`.

```bash
# Full pipeline: run tests, then assemble docs
bun test
bun run docs:build

# Wipe generated docs and fragment cache (e.g. after renaming a doc test)
bun run docs:clean
```

Notes:

- A doc test that fails writes no fragment. Broken tests mean broken or missing docs.
- `.test-tmp/` is gitignored (ephemeral fragment cache). `docs/generated/` IS committed — its diffs show how user-facing docs change when behavior changes, so reviewers can see the effect of a PR on the public docs.
- Always re-run `bun test && bun run docs:build` before committing changes that affect doc tests, so `docs/generated/` stays in sync.
- Re-running a single doc test overwrites only its own fragment file. Other tests' fragments stay put until `docs:clean` or another test overwrites them.

### Docker Development Environment

A Docker environment is provided for testing against the minimum supported Git version (2.40). This is **optional** for local development if your system Git is 2.40+, but useful when:

- You need to verify behavior with the exact minimum supported Git version
- Investigating discrepancies between local and CI environments
- Testing Git version error handling

**Setup (for tests requiring GitHub):**

```bash
cp docker/.env.example docker/.env
# Edit docker/.env and add your GH_TOKEN
```

**Commands:**

```bash
# Dev shells
bun run docker:shell           # Shell with git 2.40 (min supported)
bun run docker:shell:2.38      # Shell with git 2.38 (unsupported, for manual repro)

# Run the test suite in Docker
bun run test:docker                              # full suite
bun run test:docker -- tests/commands/sync.doc.test.ts   # a subset
```

The container automatically installs dependencies on first run. The suite is
offline: doc tests replay committed gh cassettes (`tests/fixtures/cassettes/`),
so no GitHub auth is needed for a normal run.

### Project Structure

```
src/
├── cli/      # CLI entry point (index.ts) — wires up commands
├── commands/ # Command implementations (sync, land, view, group, rebase)
├── parse/    # Stack parsing — commit ids, trailers, titles
├── git/      # Git operations (branch, config, rebase, conflict, behind)
├── gh/       # GitHub integration (PRs, PR cache, enrich, errors)
├── tui/      # Terminal UI components (group editor, select, confirm)
├── ui/       # Output formatting
└── lib/      # Shared runtime — context, subprocess runner, gh cassette seam
```

### Re-recording gh cassettes

GitHub behavior is tested by replaying committed recordings, so most work needs
no GitHub at all. To re-record a cassette against the live `spry-check` repo,
put a token in `docker/.env` (see the Docker setup above) and run it in the
container — auth is wired through automatically:

```bash
# Set up the test repository (one-time; needs gh auth)
bun run scripts/setup-spry-check.ts

# Re-record one fragment (mutates spry-check, then cleans up after itself)
bun run record:docker tests/commands/sync.doc.test.ts -t "Opening a new PR"
```

Recording in the container avoids the host-side HTTPS git-config wrinkle noted in
`tests/fixtures/cassettes/README.md` (the container's git has no `https→ssh`
rewrite). To record on the host instead, run `SPRY_RECORD=1 bun test …` directly.

## License

MIT
