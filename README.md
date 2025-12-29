# taspr

A CLI tool for managing **stacked pull requests** on GitHub. Organize related commits as interdependent PRs, where each PR builds on the previous one—enabling incremental code review for large features.

## Why Stacked PRs?

Traditional PR workflows force you to either:
- Submit one massive PR that's hard to review
- Manually manage dependent branches and rebase chains

Taspr automates the stacked PR workflow:
- Each commit (or group of commits) becomes its own PR
- PRs are automatically chained with proper base branches
- Rebasing and syncing is handled for you

## Installation

```bash
# Clone the repository
git clone https://github.com/happycollision/taspr.git
cd taspr

# Install dependencies
bun install

# Build the CLI
bun run build
```

This creates `./dist/taspr` as a compiled executable. Move it where you like and add it to your PATH or create an alias.

On Linux or macOS, it would be something like this:

```bash
# Add to your ~/.bashrc, ~/.zshrc, or similar
alias taspr='/path/to/taspr/dir'
```

If you are developing, perhaps you want to point to this dist folder in your current terminal session. Copy/pasting the line below should do it.

```bash
# from the root of the repo
export PATH="$PATH:$(pwd)/dist"
```


### Requirements

- [Bun](https://bun.sh) runtime
- [GitHub CLI](https://cli.github.com/) (`gh`) - authenticated via `gh auth login`
- Git 2.0+

## Quick Start

```bash
# 1. Create some commits on your feature branch
git commit -m "Add user model"
git commit -m "Add user API endpoints"
git commit -m "Add user tests"

# 2. View your stack
taspr view

# 3. Sync with GitHub and create PRs
taspr sync --open
```

## Commands

### `taspr view`

Display the current stack of commits and their PR status.

```bash
taspr view
```

Output shows:
- Commit messages and their taspr IDs
- PR numbers and status (open, merged, closed)
- Grouped commits displayed together

### `taspr sync`

Synchronize your local stack with GitHub.

```bash
# Push branches only
taspr sync

# Push branches and create/update PRs
taspr sync --open
```

This command:
1. Validates your working tree is clean
2. Adds `Taspr-Commit-Id` trailers to commits (via interactive rebase)
3. Pushes each branch to the remote
4. Creates or updates PRs (with `--open` flag)

## Core Concepts

### PR Units

Taspr organizes commits into **PR units**:

- **Single**: One commit = one PR (uses commit subject as title)
- **Group**: Multiple commits = one PR (uses group title)

### Commit Trailers

Taspr uses git trailers (metadata in commit messages) for tracking:

```
feat: Add user authentication

Implements JWT-based auth with refresh tokens.

Taspr-Commit-Id: a1b2c3d4
```

Trailers are added automatically by `taspr sync`.

### Grouping Commits

Group multiple commits into a single PR using trailers:

```bash
# First commit of group
git commit -m "Start auth feature

Taspr-Group-Start: auth
Taspr-Group-Title: User Authentication"

# Middle commits (no special trailers needed)
git commit -m "Add login endpoint"
git commit -m "Add logout endpoint"

# Last commit of group
git commit -m "Add auth tests

Taspr-Group-End: auth"
```

All commits between `Group-Start` and `Group-End` become one PR.

### Branch Naming

Taspr creates branches with the format:

```
<prefix>/<username>/<prId>
```

Example: `taspr/johndoe/a1b2c3d4`

Each PR's branch uses the previous PR's branch as its base, creating the stack.

## Configuration

Configure via git config:

```bash
# Custom branch prefix (default: "taspr")
git config taspr.branchPrefix my-prefix

# Custom default branch (auto-detected if not set)
git config taspr.defaultBranch main
```

## Workflow Example

```bash
# Start a new feature
git checkout -b my-feature origin/main

# Make commits
git commit -m "Add database migrations"
git commit -m "Add user model"
git commit -m "Add user API"
git commit -m "Add user tests"

# View the stack
taspr view
# Shows 4 commits, each will become a PR

# Create the PRs
taspr sync --open
# Creates 4 stacked PRs:
# PR #1: Add database migrations (base: main)
# PR #2: Add user model (base: PR #1's branch)
# PR #3: Add user API (base: PR #2's branch)
# PR #4: Add user tests (base: PR #3's branch)

# After review feedback, amend a commit
git rebase -i HEAD~4
# ... make changes ...

# Sync again to update PRs
taspr sync
```

## Development

```bash
# Run in dev mode
bun run dev

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

### Project Structure

```
src/
├── cli/           # Command-line interface
│   ├── index.ts   # CLI entry point
│   └── commands/  # Command implementations
├── core/          # Core logic (stack parsing, ID generation)
├── git/           # Git operations (commands, trailers, rebase)
├── github/        # GitHub integration (API, branches, PRs)
├── types.ts       # TypeScript types
└── utils/         # Utilities
```

### Running GitHub Integration Tests

```bash
# Setup test repository (one-time)
bun run test:github:setup

# Run integration tests
GITHUB_INTEGRATION_TESTS=1 bun test tests/integration/
```

## License

MIT
