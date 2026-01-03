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

# Temporary commit prefixes (default: "WIP,fixup!,amend!,squash!")
git config taspr.tempCommitPrefixes "WIP,DRAFT,TODO"

# Disable temp commit detection (create PRs for all commits)
git config taspr.tempCommitPrefixes ""
```

### Temporary Commits

Commits with certain prefixes are considered "temporary" and won't automatically get PRs created during `taspr sync --open`. This is useful for:

- **WIP commits**: Work you're not ready to review yet
- **fixup!/amend!/squash! commits**: Commits meant to be squashed during interactive rebase

**Default prefixes** (case-insensitive matching):

- `WIP` - Work in progress
- `fixup!` - Git's autosquash fixup commits
- `amend!` - Git's autosquash amend commits
- `squash!` - Git's autosquash squash commits

**Behavior when detected:**

1. Branches are still pushed (for stacking dependent commits)
2. PR creation is skipped
3. Output shows which commits were skipped

**Escape hatch:** If you group a temporary commit with other commits, a PR will be created for the group. This lets you explicitly opt-in when ready.

```bash
# Example: WIP commit won't get a PR
git commit -m "WIP: experimenting with new approach"
taspr sync --open
# Output: ⚠ Skipped PR for 1 temporary commit(s)

# Later, when ready, amend the commit message
git commit --amend -m "Add new caching approach"
taspr sync --open
# Now creates a PR
```

**Using fixup! with stacked PRs:**

When you need to fix an earlier commit in your stack, use git's `--fixup` flag. The fixup commit won't get its own PR, keeping your stack clean:

```bash
# Your stack has 3 commits, each with its own PR
# PR #1: Add user model
# PR #2: Add user API
# PR #3: Add user tests

# You notice a bug in the user model (PR #1)
# Create a fixup commit targeting that commit
git commit --fixup "Add user model"

# Sync - the fixup commit pushes but doesn't get a PR
taspr sync --open
# Output: ⚠ Skipped PR for 1 temporary commit(s):
#   fixup! Add user model

# When ready to squash, run interactive rebase with autosquash
git rebase -i --autosquash origin/main
# The fixup commit automatically moves next to "Add user model" and squashes

# Sync again to update PR #1 with the fix
taspr sync
```

**Alternative: Adding fixup! commits to an existing PR:**

<!-- FIXUP_GROUP_DOCS: Update after taspr-b3e is resolved - squashing grouped fixups has edge cases -->

Some teams prefer reviewers to see fixup! commits that address feedback, rather than squashing immediately. You can group the fixup! commit with the original to add it to the same PR:

```bash
# PR #1 exists for "Add user model"
# Reviewer requests changes

# Create a fixup commit
git commit --fixup "Add user model"

# Group the fixup! commit with the original using taspr group
taspr group
# Select both "Add user model" and "fixup! Add user model" in the TUI

# Sync - now the fixup! commit is part of PR #1
taspr sync
# Reviewer can see exactly what changed in response to feedback

# Later, when approved, squash before merging
git rebase -i --autosquash origin/main
taspr sync
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
