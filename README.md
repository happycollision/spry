# Spry

A CLI tool for managing **stacked pull requests** on GitHub. Organize related commits as interdependent PRs, where each PR builds on the previous one—enabling incremental code review for large features.

## Why Stacked PRs?

Traditional PR workflows force you to either:

- Submit one massive PR that's hard to review
- Manually manage dependent branches and rebase chains

Spry automates the stacked PR workflow:

- Each commit (or group of commits) becomes its own PR
- PRs are automatically chained with proper base branches
- Rebasing and syncing is handled for you
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

# Build the CLI
bun run build
```

This creates `./dist/sp` as a compiled executable. Move it where you like and add it to your PATH or create an alias.

On Linux or macOS, it would be something like this:

```bash
# Add to your ~/.bashrc, ~/.zshrc, or similar
alias sp='/path/to/spry/dir'
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
sp view

# 3. Sync with GitHub and create PRs
sp sync --open

# 4. When the first PR is approved, land it
sp land
```

## Commands

### `sp view`

Display the current stack of commits and their PR status.

```bash
sp view          # View stack for current branch
sp view --all    # View all your open PRs across branches
```

Output shows:

- Commit messages and their Spry IDs
- PR numbers and status (open, merged, closed)
- PR health: CI checks, review status, comments
- Grouped commits displayed together

### `sp sync`

Synchronize your local stack with GitHub.

```bash
# Push branches only
sp sync

# Push branches and create/update PRs
sp sync --open
```

This command:

1. Validates your working tree is clean
2. Adds `Spry-Commit-Id` trailers to commits (via interactive rebase)
3. Pushes each branch to the remote
4. Creates or updates PRs (with `--open` flag)
5. Automatically retargets open PRs when earlier branches are merged
6. Cleans up merged PRs and orphaned branches

### `sp land`

Merge ready PRs from your stack into main.

```bash
# Merge the bottom-most ready PR
sp land

# Merge all consecutive ready PRs from the bottom
sp land --all
```

Before merging, `sp land` validates:

- CI checks are passing
- Required reviews are approved
- No merge conflicts

After merging:

- Dependent PRs are automatically retargeted to the new base
- Remote branches are cleaned up

### `sp group`

Interactive TUI for grouping multiple commits into a single PR.

```bash
sp group
```

**Keyboard controls:**

| Key         | Action                                 |
| ----------- | -------------------------------------- |
| `↑/↓`       | Navigate between commits               |
| `←/→`       | Assign/remove commit from a group      |
| `Space`     | Enter move mode to reorder commits     |
| `Shift+↑/↓` | Quick swap (reorder without move mode) |
| `Enter`     | Confirm and apply changes              |
| `Esc`       | Cancel                                 |

**Non-interactive mode:**

```bash
# Apply grouping via JSON specification
sp group --apply '{"order": ["abc123", "def456"], "groups": [{"commits": ["abc123", "def456"], "name": "Feature X"}]}'
```

**Repair invalid groups:**

```bash
# Interactive repair
sp group --fix

# Non-interactive: dissolve problematic groups
sp group --fix dissolve
```

### `sp group dissolve`

Remove grouping from commits, turning them back into individual PRs.

```bash
# Interactive: select groups to dissolve
sp group dissolve

# Dissolve a specific group
sp group dissolve <group-id>

# Specify which commit inherits the existing PR
sp group dissolve <group-id> --inherit <commit>

# Don't inherit the PR to any commit
sp group dissolve <group-id> --no-inherit
```

### `sp clean`

Find and remove orphaned branches that have been merged.

```bash
# Preview what would be cleaned
sp clean --dry-run

# Delete orphaned branches
sp clean

# Force delete branches detected by commit-id (may lose original content)
sp clean --force
```

## Core Concepts

### Commit Trailers

Spry uses git trailers (metadata in commit messages) for tracking:

```
feat: Add user authentication

Implements JWT-based auth with refresh tokens.

Spry-Commit-Id: a1b2c3d4
```

Trailers are added automatically by `sp sync`.

### Grouping Commits

You can group multiple commits into a single PR using `sp group` (recommended) or manually via trailers:

All grouped commits become one PR when you `sp sync --open`.

## Configuration

Configure via git config:

```bash
# Custom branch prefix (default: "spry")
git config spry.branchPrefix my-prefix

# Custom default branch (auto-detected if not set)
git config spry.defaultBranch main

# Temporary commit prefixes (default: "WIP,fixup!,amend!,squash!")
git config spry.tempCommitPrefixes "WIP,DRAFT,TODO"

# Disable temp commit detection (create PRs for all commits)
git config spry.tempCommitPrefixes ""
```

### Temporary Commits

Commits with certain prefixes are considered "temporary" and won't automatically get PRs created during `sp sync --open`. This is useful for:

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
git commit -m "WIP: experimenting with new caching approach"
sp sync --open
# Output: ⚠ Skipped PR for 1 temporary commit(s)

# Later, when ready, amend the commit message
git commit --amend -m "Add new caching approach"
sp sync --open
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
sp sync --open
# Output: ⚠ Skipped PR for 1 temporary commit(s):
#   fixup! Add user model

# When ready to squash, run interactive rebase with autosquash
git rebase -i --autosquash origin/main
# The fixup commit automatically moves next to "Add user model" and squashes

# Sync again to update PR #1 with the fix
sp sync
```

**Alternative: Adding fixup! commits to an existing PR:**

Some teams prefer reviewers to see fixup! commits that address feedback, rather than squashing immediately. You can group the fixup! commit with the original to add it to the same PR:

```bash
# PR #1 exists for "Add user model"
# Reviewer requests changes

# Create a fixup commit
git commit --fixup "Add user model"

# Group the fixup! commit with the original using sp group
sp group
# Select both "Add user model" and "fixup! Add user model" in the TUI

# Sync - now the fixup! commit is part of PR #1
sp sync
# Reviewer can see exactly what changed in response to feedback

# Later, when approved, squash before merging
git rebase -i --autosquash origin/main
sp sync
```

## Workflow Examples

### Basic Stacked PR Workflow

```bash
# Start a new feature
git checkout -b my-feature origin/main

# Make commits
git commit -m "Add database migrations"
git commit -m "Add user model"
git commit -m "Add user API"
git commit -m "Add user tests"

# View the stack
sp view
# Shows 4 commits, each will become a PR

# Create the PRs
sp sync --open
# Creates 4 stacked PRs:
# PR #1: Add database migrations (base: main)
# PR #2: Add user model (base: PR #1's branch)
# PR #3: Add user API (base: PR #2's branch)
# PR #4: Add user tests (base: PR #3's branch)

# After review feedback, amend a commit
git rebase -i HEAD~4
# ... make changes ...

# Sync again to update PRs
sp sync

# When PR #1 is approved, land it
sp land
# PR #1 merges to main, PR #2 is retargeted to main

# Land all remaining ready PRs
sp land --all
```

### Grouping Related Commits

```bash
# You have several commits that should be reviewed together
git commit -m "Add auth types"
git commit -m "Add auth middleware"
git commit -m "Add auth routes"

# Group them into one PR
sp group
# Use ←/→ to assign all three commits to group "A"
# Press Enter to confirm

# Sync creates a single PR for the group
sp sync --open
```

### Managing many branches/stacks

```bash
# View all your open PRs across branches
sp view --all

# Clean up merged branches
sp clean --dry-run  # Preview first
sp clean            # Delete orphaned branches
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
├── tui/           # Terminal UI components
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
