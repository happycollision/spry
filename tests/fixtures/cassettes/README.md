# gh cassettes

These JSON files are **real recordings of `gh` traffic** captured against the
live `spry-check` test repository. Doc tests replay them offline (no network, no
auth) so they exercise the real `sp` binary while producing realistic, stable
output.

Design: `docs/plans/2026-06-13-gh-cassettes-real-recording-design.md`.

## The one hard rule

**Never hand-author a cassette.** Every byte here must come from a real `gh`
invocation in record mode. A JSON file you typed by hand is just an in-process
stub relocated to disk — it checks fiction against fiction and will silently
drift from GitHub's real responses. (Recording is what caught the broken PR
query that every stubbed test missed.)

## How it works

A doc fragment runs the same body two ways, switching on `SPRY_RECORD`:

- **Replay (default):** `git` origin is a local bare repo, the CLI's `gh` seam
  (`SPRY_GH_CASSETTE`) serves responses from the committed cassette. Offline.
- **Record (`SPRY_RECORD=1`):** `git` origin is a real `spry-check` clone, the
  seam (`SPRY_GH_CASSETTE_RECORD`) wraps real `gh` and writes the cassette.

Determinism is the bridge: pinned commit dates/identity + a fixed `spry.repo`
slug make the `gh` arguments byte-identical across both modes, so the args-keyed
replayer matches. See `tests/lib/cassette-harness.ts` and `tests/lib/repo.ts`.

Cassettes are keyed by doc section + order, mirroring `fragmentPath`:
`commands__sync--020.json` ⇔ `{ section: "commands/sync", order: 20 }`.

## Re-recording

Recording mutates the real `spry-check` repo (pushes branches, opens/merges
PRs). Each record-mode test `reset()`s the repo (via `withGitHubFixture`)
**before** its body runs — there is no trailing reset, so `spry-check` is left
dirty (leftover branches/PRs, possibly an advanced `main`) after the last test
of a recording session. That residue is expected and harmless: the next
recording session's first reset clears it, and nothing reads the repo between
sessions.

Recording is **non-interactive** — the agent runs it itself (do not ask the
user) whenever `gh` is authenticated. See the AGENTS.md testing section.

Prerequisites:

- `gh` authenticated against an account that owns a `spry-check` repo carrying
  the safety marker `<!-- spry-test-repo:v1 -->` (run `bun run scripts/setup-spry-check.ts`).
- A git config that pushes to GitHub over **HTTPS**. If your global git config
  rewrites `https://github.com/` to SSH (e.g. a 1Password `insteadOf` rule), the
  non-interactive test subprocess will hang on the SSH agent. Point
  `GIT_CONFIG_GLOBAL` at a minimal HTTPS config for the recording run:

  ```
  # /tmp/rec-gitconfig
  [credential "https://github.com"]
  	helper = !gh auth git-credential
  ```

Record one fragment:

```sh
GIT_CONFIG_GLOBAL=/tmp/rec-gitconfig SPRY_RECORD=1 \
  bun test tests/commands/sync.doc.test.ts -t "Opening a new PR"
```

Then verify it replays offline and regenerate docs:

```sh
bun test tests/commands/sync.doc.test.ts -t "Opening a new PR"   # offline
bun run docs:build
```

Review the JSON diff — it must contain genuine GitHub fields (real node IDs,
URLs, PR numbers), not anything you typed.

## Notes

- **PR numbers/URLs are GitHub-minted** and captured raw, so re-recording can
  change them. Fragments scrub the volatile bits (PR number, repo slug) for
  stable docs. If churn ever becomes painful, normalize-on-record is the
  follow-up (see the design doc's "Decisions").
- `spry.repo` currently defaults to `happycollision/spry-check` to match the
  committed cassettes; override with `SPRY_TEST_REPO_OWNER`/`SPRY_TEST_REPO_NAME`
  when recording under a different account (and commit that account's cassettes).
