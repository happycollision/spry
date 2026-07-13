## Rebuild Roadmap

See @docs/rebuild-roadmap.md for the feature gap between `main` and this branch, and decisions about what to port, redesign, or drop.

## Dogfooding `sp`

We dogfood `sp` for our own pull requests. Some `sp` commands are **interactive**
(they open a TUI and block on input), so the agent cannot run them — a backgrounded
interactive command just hangs on a closed stdin. When dogfooding, note which tools
are interactive and **ask the user to run those commands themselves** (e.g. via the
`! <command>` prompt prefix) rather than invoking them yourself.

Known interactive commands:

- `sp sync --open` — prompts in a TUI when opening PRs.
- `sp group` — interactive grouping/reordering editor.
- `sp land` (bare, no `--through`) — opens a single-select picker.

Non-interactive (safe for the agent to run): `sp view`, `sp sync` (push-only,
no `--open`), `sp rebase`, `sp clean`, `sp land --through <id>`. Confirm a command
is non-interactive before relying on it; when in doubt, ask the user to run it.

<!-- br-agent-instructions-v1 -->

## Beads Workflow Integration

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`/`bd`) for issue tracking. Issues live in `.beads/`, which is **not** tracked by this repo directly — it is a [git nook](#beads-issue-tracking-git-nook) published to a hidden ref on `origin`. See that section for the storage details; this section is the day-to-day `br` command reference.

### Essential Commands

```bash
# View ready issues (open, unblocked, not deferred)
br ready              # or: bd ready

# List and search
br list --status=open # All open issues
br show <id>          # Full issue details with dependencies
br search "keyword"   # Full-text search

# Create and update
br create --title="..." --description="..." --type=task --priority=2
br update <id> --status=in_progress
br close <id> --reason="Completed"
br close <id1> <id2>  # Close multiple issues at once

# Sync with git
br sync --flush-only  # Export DB to JSONL
br sync --status      # Check sync status
```

### Workflow Pattern

1. **Start**: Run `br ready` to find actionable work
2. **Claim**: Use `br update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: Use `br close <id>`
5. **Sync**: Always run `br sync --flush-only` at session end

### Key Concepts

- **Dependencies**: Issues can block other issues. `br ready` shows only open, unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers 0-4, not words)
- **Types**: task, bug, feature, epic, chore, docs, question
- **Blocking**: `br dep add <issue> <depends-on>` to add dependencies

### Session Protocol

**Before ending any session, run this checklist:**

```bash
git status                        # Check what changed in the main repo
git add <files>                   # Stage code changes
br sync --flush-only              # Export beads changes to JSONL
git nook beads add --all          # Stage issue data in the nook
git nook beads commit -m "issues" # Commit it (skip if nothing changed)
git nook beads push               # Publish the hidden ref on origin
git commit -m "..."               # Commit code (on a feature branch, not main)
git push                          # Push code
```

### Best Practices

- Check `br ready` at session start to find available work
- Update status as you work (in_progress → closed)
- Create new issues with `br create` when you discover tasks
- Use descriptive titles and set appropriate priority/type
- Always sync before ending session

### Capturing tangential discoveries

**Always log tangential discoveries as beads issues — never wonder whether it's
worth capturing.** If, while working on something, you notice an unrelated bug,
a broken/dangling config, a stale doc, a missing test, a footgun, or any "huh,
that's not right" — file it immediately, then return to your task. The bar is
zero: capturing a non-issue costs a `br close`; losing a real one costs a
rediscovery later.

- Title it with a `Discovery:` prefix, e.g.
  `br create --title="Discovery: dangling .git/info/exclude symlink" --type=chore --priority=3 --description="<what you saw, where, why it matters>"`.
- Inline the full context in the description — the finding, the file/location,
  and why it matters — since the issue is the only record.
- Do **not** derail your current task to fix it; the issue is the capture.
- Publish it with the [Session Protocol](#session-protocol) before the session
  ends (a `br create` alone does not share it — it must be committed and pushed
  to the nook).

<!-- end-br-agent-instructions -->

## Beads issue tracking (git nook)

This repo's beads issues are **not** committed on `main`. They live in a
[git nook](https://github.com/happycollision/git-nook) named `beads`: an inner
git repository hidden under `.git/nook/beads.git`, whose worktree is the
repo-excluded `.beads/` dir, published to a custom ref on `origin`
(`refs/nook/happycollision/spry/beads`) that never appears in branch listings or
default clones. This keeps issue-tracker churn off the `main` branch history.

```bash
git nook list                 # see this repo's nooks (expect: beads)
git nook beads status         # any git command works against the nook
```

The daily beads flow on this repo:

```bash
br sync --flush-only          # beads DB -> .beads/issues.jsonl
git nook beads add --all
git nook beads commit -m "issues"
git nook beads pull --no-rebase   # only needed when another machine pushed
git nook beads push
```

If a pull merges `issues.jsonl` from another machine, do NOT hand-resolve JSONL
conflicts. `br` owns the merge: run `br sync --merge` (three-way merge of DB +
JSONL, per-issue newest-wins, tombstone-protected), then re-flush and commit the
result on the nook. `br sync --import-only` refuses any file that still contains
git conflict markers, so a botched hand-merge cannot slip in.

## Planning (designs and implementation plans)

Prefer tracking new designs and implementation plans **in beads** rather than as
committed markdown under `docs/plans/` on `main`. Issues live only on the beads
nook, so planning this way keeps `main` free of in-progress planning churn (and
dogfoods the nook). (Note: some existing planning docs — e.g.
`docs/rebuild-roadmap.md` — remain committed on `main` by design; this guidance
is for _new_ plans, not a mandate to migrate those.)

- Model a design as an `epic`, and each plan step as a child `task`/`feature` via
  `br create --parent <epic>`.
- Chain the steps with `blocks` deps (`br dep add <step> <prev-step>`) so
  `br ready` surfaces one step at a time, in order. Split a step into subagent
  sub-tasks as further children when needed.
- Beads descriptions are plain-text JSONL (not rendered markdown), and the issue
  is the _only_ record — so inline the full detail: files touched, key code, exact
  test assertions.
- After creating them, publish via the session protocol and verify the nook's ref
  received them (`git nook beads show origin/main:issues.jsonl | grep <id>`).

## Git

Please don't use `git -C ...` because it makes it impossible for me to whitelist commands for you. Just be in the correct directory and do normal git operations. Please pass this instruction to any sub-agents you spawn.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

### Bun APIs (use these instead of their counterparts)

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests ONLY after you have checked the version of Git that is installed. If it is less than 2.40, use the `<command>:docker` alias for all `bun run` commands that have a docker alias. (See package.json).

**Fast path:** `bun run test:concurrent` runs the suite with `--concurrent`
(~2.5x faster wall clock). It is the recommended local loop; plain `bun test`
remains the canonical serial run. Always use the script rather than a bare
`bun test --concurrent`: the script raises the per-test timeout, which
concurrent runs need because tests that capture console output serialize on a
shared lock (`tests/lib/capture.ts`) and the queue wait counts against each
test's own timeout. Record mode stays serial for now (`SPRY_RECORD=1 bun test`,
no `--concurrent`).

GitHub integration is tested via **gh cassettes**: doc tests run the real `sp`
binary while replaying committed recordings in `tests/fixtures/cassettes/`, so the
default suite is offline and needs no auth. If you change code on the real-`gh`
path and need to re-validate it against GitHub, re-record the relevant cassette
with `SPRY_RECORD=1` (real-record mode is the validation - see
`tests/fixtures/cassettes/README.md`).

**The agent should run recordings itself — do not ask the user to do it.**
`SPRY_RECORD=1 bun test <doc-test>` is a **non-interactive** command; when `gh`
is authenticated (it normally is — check with `gh auth status`), the agent has
everything it needs and is authorized to record. Recording mutates the real
`happycollision/spry-check` repo, but the fixture resets it, so this is expected
and safe. The fixture manages its own HTTPS clone of `spry-check` internally, so
the working repo's `origin` remote being SSH is **not** a blocker — do not
reconfigure `origin` and do not defer to the user over the remote protocol.
(The lone live-network unit test shares the `SPRY_RECORD` gate, so it runs
alongside cassette recording and verifies the fixture reset machinery that
recording depends on.)

Every user-facing command or UI output must have doc-producing tests in a `tests/commands/<command>.doc.test.ts` file using the `docTest` helper from `tests/lib/index.ts`. Doc tests are the source of truth for generated documentation in `docs/generated/`. See `tests/commands/sync.doc.test.ts` or `tests/commands/view.doc.test.ts` for the pattern.

### Pre-merge record + playback check

Before merging any branch, prove that record mode still works end-to-end and
that the generated docs are stable. Run this gate and expect it to pass:

1. **Record the whole suite once, regenerating docs from scratch:**
   ```bash
   bun run docs:clean            # wipe .test-tmp/doc-fragments + docs/generated
   SPRY_RECORD=1 bun test        # full suite in record mode (mutates spry-check)
   bun run docs:build            # regenerate docs/generated from the fresh fragments
   ```
2. **Play the suite back twice** (the normal offline path):
   ```bash
   bun test
   bun run docs:build
   bun test
   bun run docs:build
   ```

**Expected churn: at most CI check-run state inside cassettes.** Recording
normalizes cassettes as it writes them (`src/lib/recording-client.ts`):
GitHub-minted PR numbers are rewritten to a deterministic 1001, 1002, ...
sequence (consistently across stdout, args, and stdin) and recorded options
are stripped to `stdin` (the only option the replayer matches on), so
PR-number and temp-`cwd` churn no longer exist. The one remaining
nondeterminism is GitHub Actions check-run state (the `statusCheckRollup`
arrays) captured mid-flight in some cassettes — that residue is noise and
should be **dropped** (`git checkout -- tests/fixtures/cassettes/`). Any
OTHER cassette diff (a PR number, a `cwd` path, changed args) and any diff in
`docs/generated/` is a real failure: it means the recording or the docs are
non-deterministic or a fragment changed — investigate and fix before merging,
do not commit the churn. (A recorded-then-replayed run that leaves docs
unchanged is the proof the cassettes faithfully reproduce the live behavior.)

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Changelog

You should edit the changelog after each change that affects runtime, BEFORE YOU COMMIT. This is a per-commit responsibility, not a release-time task. The release script handles changelog formatting automatically.

## Releasing

Use the release script to cut a new version. Do not manually edit any files - the script handles everything:

```bash
./scripts/release.sh <version>

# Example:
./scripts/release.sh 0.1.0-alpha.5
```

This will:

1. Validate the version format (semver with optional prerelease)
2. Update the changelog
3. Check that there are no uncommitted changes
4. Verify the version is newer than the latest tag (use `--force` to bypass)
5. Update `package.json` version
6. Commit the version bump
7. Create and push the git tag

The GitHub workflow automatically builds binaries for all platforms and creates a release with notes extracted from `CHANGELOG.md`.

**Version format:** `X.Y.Z` or `X.Y.Z-prerelease` (e.g., `0.1.0`, `0.1.0-alpha.4`, `1.0.0-beta.1`)

We are doing main development on `main`. Split feature work off from `main` and merge it back there.
