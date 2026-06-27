# Agent Guidance Agnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move live project guidance from Claude-only files into shared `AGENTS.md` while keeping Claude Code compatibility through an import reference.

**Architecture:** `AGENTS.md` is the canonical instruction file. `CLAUDE.md` is a compatibility shim that imports `AGENTS.md` with Claude Code's `@AGENTS.md` syntax.

**Tech Stack:** Markdown documentation and git.

---

### Task 1: Convert Agent Guidance Files

**Files:**

- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Create: `docs/superpowers/specs/2026-06-27-agent-guidance-agnostic-design.md`
- Create: `docs/superpowers/plans/2026-06-27-agent-guidance-agnostic.md`

- [ ] **Step 1: Confirm Claude files**

Run:

```bash
find . -path ./node_modules -prune -o \( -name 'CLAUDE.md' -o -name 'CLAUDE.local.md' \) -print
```

Expected:

```text
./CLAUDE.md
```

- [ ] **Step 2: Move guidance into `AGENTS.md`**

Replace the contents of `AGENTS.md` with the former contents of `CLAUDE.md`.

- [ ] **Step 3: Replace `CLAUDE.md` with import reference**

Set `CLAUDE.md` to exactly:

```md
@AGENTS.md
```

- [ ] **Step 4: Verify conversion**

Run:

```bash
cat CLAUDE.md
rg -n "## Rebuild Roadmap|## Bun|## Testing|## Frontend|## Changelog|## Releasing" AGENTS.md
find . -path ./node_modules -prune -o \( -name 'CLAUDE.md' -o -name 'CLAUDE.local.md' \) -print
```

Expected:

```text
@AGENTS.md
```

and one repository Claude file:

```text
./CLAUDE.md
```

- [ ] **Step 5: Commit and push**

Run:

```bash
git add AGENTS.md CLAUDE.md docs/superpowers/specs/2026-06-27-agent-guidance-agnostic-design.md docs/superpowers/plans/2026-06-27-agent-guidance-agnostic.md
git commit -m "docs: make agent guidance environment-agnostic"
git pull --rebase
git push
git status
```

Expected final status says the branch is up to date with its upstream and the working tree is clean.
