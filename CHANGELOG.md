# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Show progress feedback ("Creating PR for... #number") when opening PRs for the first time

## [1.0.0-beta.2] - 2026-01-12

### Added

- GitHub API retry logic with exponential backoff and jitter
- Rate limit detection with automatic wait-and-retry
- Concurrency limiting (max 5 parallel GitHub API calls)
- Input validation for branch names, PR titles, and commit identifiers with clear error messages
- Detached HEAD state detection with helpful error messages and remediation steps

### Changed

- Performance improvements: reduced GitHub API calls in view and land commands through batched PR lookups

### Fixed

- GitHub API pagination for large repos (gh pr list now fetches up to 500 PRs)

## [1.0.0-beta.1] - 2026-01-10

### Added

- PR body generation with commit message content
- Stack links in PR bodies showing all PRs with GitHub native references (#123 format)
- PR template support with configurable placement (prepend, afterBody, afterStackLinks, append)
- User-editable content preservation between Spry markers on sync
- Content hash tracking to avoid unnecessary PR body updates
- Alpha warning footer in generated PR bodies
- New config options: `spry.showStackLinks`, `spry.includePrTemplate`, `spry.prTemplateLocation`
- Validation that groups have stored titles before creating PRs
- New flag `--allow-untitled-pr` to bypass title validation and use first commit subject

### Changed

- **BREAKING**: `sp clean --force` renamed to `--unsafe` for commit-id matched branches
  - Safe branches (exact SHA match) are deleted by default
  - Unsafe branches (commit-id trailer match only) require explicit `--unsafe` flag
- Split groups in non-TTY mode now require explicit fix method (`--dissolve` or `--regroup`)

### Fixed

- CLI help now shows correct binary name (`sp`) and tagline

## [0.1.0-alpha.5] - 2026-01-09

### Changed

- **BREAKING**: Renamed tool from "taspr" to "spry" (binary: `sp`)
  - Git config keys: `taspr.*` → `spry.*`
  - Git trailers: `Taspr-Commit-Id` → `Spry-Commit-Id`, `Taspr-Group` → `Spry-Group`
  - Branch prefix default: `taspr/` → `spry/`
  - Environment variables: `TASPR_*` → `SPRY_*`

## [0.1.0-alpha.4] - 2026-01-09

### Changed

- CLI version now read from package.json
- Simplified group display in view command

## [0.1.0-alpha.3] - 2026-01-09

### Added

- Behind detection for stacks needing rebase
- Automated rebase onto main with conflict detection
- Group editor TUI with reorder and conflict prediction
- Interactive group dissolve with multi-select
- Squash-resilient group markers
- Selective PR opening with `--apply`, `--up-to`, and `-i` flags
- Progress indicators during PR/branch status fetching

### Changed

- Major performance improvement: use git plumbing instead of interactive rebase (no working directory writes)
- Batched PR lookups for faster sync performance

### Fixed

- Git hooks disabled during rebases with `--no-verify`
- Temporary commits (WIP, fixup!) skipped during PR creation

## [0.1.0-alpha.2] - SKIPPED

## [0.1.0-alpha.1] - 2026-01-08

### Added

- Initial release with core stacked PR workflow
- `taspr view` - Display commit stack with PR status indicators
- `taspr sync` - Push commits as branches and open PRs
- `taspr land` - Fast-forward merge PRs with CI/review checks
- `taspr clean` - Remove orphaned branches
- Commit grouping for multi-commit PRs
- GitHub integration with PR status, checks, and review tracking
- Curl installation script for easy setup
