# Agent Guidance Agnostic Design

## Goal

Move live project instructions out of Claude-only memory files and into the shared `AGENTS.md` file so multiple agent environments can consume the same guidance.

## Scope

Convert every repository `CLAUDE.md` and `CLAUDE.local.md` file. This workspace currently contains one such file: `CLAUDE.md`. No `CLAUDE.local.md` files are present.

Historical and current implementation plans under `docs/plans/**` remain unchanged. They are records of prior work and are not active agent configuration files.

## Approach

Keep `AGENTS.md` as the source of truth. Replace the stale pre-existing `AGENTS.md` content with the project guidance that previously lived only in `CLAUDE.md`.

Replace `CLAUDE.md` with a Claude Code import reference:

```md
@AGENTS.md
```

Claude Code memory files support `@path/to/file` imports, with relative paths resolved from the importing file. Because both files live at the repository root, `@AGENTS.md` imports the shared guidance directly.

## Verification

Verify that:

- `CLAUDE.md` contains only `@AGENTS.md`.
- `AGENTS.md` contains the former Claude-only guidance.
- No repository `CLAUDE.local.md` files were missed.
- The working tree is clean after commit and push.
