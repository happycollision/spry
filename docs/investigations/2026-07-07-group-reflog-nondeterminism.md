# Investigation: `sp group` reorder doc test — varying `--all --reflog` commit count (8 vs 9)

> **Note (2026-07-13):** the pinned-`2020-01-01` commit-date scheme described
> below has been superseded by per-run seeded dates (spry-qfc8.5, see
> `tests/lib/repo.ts`). The diagnosis and method remain valid history.

Date: 2026-07-07
Investigated on: `main` (branch `investigate/group-reflog-nondeterminism`, tip `9aab7f8`)
Environment: git 2.52.0, Bun 1.3.11, macOS 26.5.1 (no docker aliases needed; git ≥ 2.40)

## 1. Summary

**Hypothesis 1 — a timing race in the test — is confirmed, with high confidence.**
The commit that appears in 9-SHA runs and is missing in 8-SHA runs is not a stack
commit at all. It is the `refs/spry/groups` bookkeeping commit (`update group
records`, an empty tree with no parent) that `saveAllGroupRecords` creates
**after** `sp group` prints `✓ Reordered ...`. The reorder doc test waits for the
text `Reordered` and then immediately calls `term.close()`, which kills the
harness process. Whether the group-records `commit-tree`/`update-ref` pair
completes before the kill lands is a coin flip — that single commit's presence is
the entire 8-vs-9 variance. Every stack-rewrite commit count was constant across
all instrumented runs, which also rules out hypotheses 2 (variable rewriting) and
3 (object-store dedup) as causes of the _count_ variance.

## 2. Reproduction

Loop over the committed test, exactly as suggested in the investigation prompt:

```sh
for i in $(seq 1 20); do
  rm -rf .test-tmp/doc-fragments
  bun test tests/commands/group.doc.test.ts >/dev/null 2>&1
  bun -e 'const j=JSON.parse(await Bun.file(".test-tmp/doc-fragments/commands__group--020.json").text()); console.log(j.shas.length)'
done
```

Observed distribution (20 runs): **9 runs → 9 SHAs, 11 runs → 8 SHAs.**
`spryIds.length` was **2 in every run**. No value other than 8 or 9 ever appeared.

A standalone throwaway script (in the session scratchpad, not committed) that
replays the identical keystroke script against the same
`tests/fixtures/group-tui-harness.ts` and then dumps `for-each-ref`,
`log --all --reflog --format='%H p=%P t=%T ci=%ci s=%s'`, and `reflog` for both
the work repo and the bare origin reproduced the same variance (12 runs:
2 × nine, 10 × eight — the skew differs from the full-suite runs, but both
values occur).

## 3. The extra commit

Diffing a representative 9-run against an 8-run: the two logs are structurally
identical except for exactly one commit, present only in the 9-run:

```
e80b0883ddffa57fc000ed7d0c0a880804133240
  subject: update group records
  parents: (none)
  tree:    4b825dc642cb6eb9a060e54bf8d69288fbee4904   ← git's canonical empty tree
  committer date: wall clock (e.g. 2026-07-07 09:15:52 -0400)
  reachable via: refs/spry/groups (a real ref, so plain `--all` sees it)
```

In the 8-run, `refs/spry/groups` does not exist at all (`for-each-ref` shows no
such ref), so the commit is absent from `log --all --reflog`.

**Creator code path:**

- `saveAllGroupRecords` — `src/git/group-titles.ts:102-131`; the commit itself is
  `commit-tree` at `group-titles.ts:122-127`, ref update at `:129-130`.
- Called unconditionally from `groupCommand` — `src/commands/group.ts:129` —
  **after** `✓ Reordered N commits` is printed at `src/commands/group.ts:125`.
- In this test the user creates no groups (pure reorder), so `updatedRecords` is
  `{}`; `saveAllGroupRecords` still commits: empty `mktree` input → empty tree →
  `commit-tree` with no parent (the ref didn't exist yet).

**Why it races:** the doc test (`tests/commands/group.doc.test.ts:119-120`) does:

```ts
await term.waitForText("Reordered", { timeout: 10000 });
await term.close();
```

`term.close()` (`tests/lib/terminal-driver.ts:109-121`) closes the pty and calls
`proc.kill()`. Between the `Reordered` text appearing and the kill landing, the
harness still has to run the group-records save (`mktree`, `rev-parse --verify`,
`commit-tree`, `update-ref` — four subprocess spawns) plus `pushGroupRecords`.
The kill sometimes lands before `update-ref` completes (→ 8) and sometimes after
(→ 9). The fragment's SHA collection runs after `close()` resolves
(`tests/lib/doc.ts:108-152`), so it observes whichever state the kill froze.

**Full commit inventory of a 9-run** (all subjects/parents verified via
`log --format='%H p=%P t=%T ci=%ci s=%s'`; all stack trees are identical because
the test commits are `--allow-empty`):

| #   | commit                                                         | created by                                                                                                                    |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Initial commit` (2020-01-01, pinned)                          | `createRepo` (`tests/lib/repo.ts:88-94`)                                                                                      |
| 2   | `Add login form` — original, no ID, parent=1                   | test setup (pinned env via `repo.git`)                                                                                        |
| 3   | `Add session handling` — original, no ID, parent=2             | test setup                                                                                                                    |
| 4   | `Add login form` + `Spry-Commit-Id` trailer, parent=1          | `injectMissingIds` (`src/git/rebase.ts:68-115` → `rewriteCommitChain`) on editor load                                         |
| 5   | `Add session handling` + trailer, parent=4                     | same                                                                                                                          |
| 6   | `Add session handling` (reordered), parent=1                   | reorder `rewriteCommitChain` (`src/commands/group.ts:120-124` → `src/git/plumbing.ts:168-200`)                                |
| 7   | `Add login form` (reordered), parent=6                         | same                                                                                                                          |
| 8   | `update tracked branches` (`refs/spry/local/tracked-branches`) | `registerBranch` (`src/commands/group.ts:50` → `src/git/tracked-branches.ts:20-48`) — before the editor opens, always present |
| 9   | `update group records` (`refs/spry/groups`)                    | `saveAllGroupRecords` — **the racy one**                                                                                      |

Commits 2-5 are orphaned by later rewrites but stay reachable through the
`HEAD`/branch reflogs, which is exactly why the scrubber walks `--all --reflog`.
The bare origin contributes only commit 1 (its `main`); in none of the observed
runs did `pushGroupRecords` complete before the kill, and even when it would, it
pushes the _same_ object, so the deduplicating `Set` in `doc.ts` keeps the
maximum possible count at 9.

## 4. Evidence for the mechanism

1. **Perfect correlation.** Across 12 instrumented runs, `count == 9` if and only
   if an `update group records` commit was present. The stack-commit line count
   was exactly 6 in all 12 runs; `update tracked branches` was present in all 12.
2. **Waiting for the real completion message eliminates the variance.** Changing
   the wait (in the throwaway script only) from `Reordered` to `Groups updated` —
   the message printed at `src/commands/group.ts:138` _after_ the save/push —
   yielded **15/15 runs at 9**.
3. **A grace sleep also eliminates it.** Keeping the `Reordered` wait but
   sleeping 500 ms before `close()` yielded **10/10 runs at 9**. Longer wait →
   more 9s; the committed test (zero wait) → mixed. Monotonic in wait time, as a
   race predicts.
4. **Message-order code reading.** `✓ Reordered` (`group.ts:125`) precedes
   `saveAllGroupRecords` (`group.ts:129`), `pushGroupRecords` (`group.ts:132`),
   and `✓ Groups updated` (`group.ts:138`). The reorder test is the only group
   doc test that waits on a mid-command message; "Grouping commits"
   (`group.doc.test.ts:72`) and "Renaming a group" (`group.doc.test.ts:215`)
   both wait for `Groups updated`.

## 5. Ruled out

- **Hypothesis 3 — object-store dedup nondeterminism.** Ruled out by direct
  observation: the stack-rewrite commit count was constant (6) in every
  instrumented run, and the toggling commit contains no random content (fixed
  message, empty tree). There is also no collision opportunity: originals differ
  from injected commits (added trailer), injected differ from reordered
  (different parents), and the rewritten commits inherit the _pinned_ 2020-01-01
  author/committer dates from the originals via `getAuthorAndCommitterEnv`
  (`src/git/plumbing.ts:67-85`), so not even timestamps vary within the stack.
  Seeding `generateCommitId()` was therefore unnecessary — randomness affects
  which SHAs appear, never how many.
- **Hypothesis 2 — redundant/variable rewriting in `sp group`.** The command
  does rewrite twice (`injectMissingIds` on load; `rewriteCommitChain` on save),
  and it does write a group-records commit even for a pure reorder — but all of
  that is _unconditional and constant-count_ for a given scripted input. Nothing
  coalesces or varies. (The double rewrite is a real design observation, but it
  is not the source of the variance.)
- **Conflict prediction creating commits.** MOVE-MODE prediction uses
  `merge-tree --write-tree` (`src/git/plumbing.ts:111-126` via
  `src/git/conflict.ts:57-96`), which writes tree objects only. Confirmed
  empirically: no run's log contained any commit attributable to move mode.
- **A second racy commit / counts other than 8-9.** `pushGroupRecords` creates
  no new objects (it transfers the existing commit), and every other write
  happens strictly before `Reordered` is printed. Only 8 and 9 are reachable,
  matching 40+ observed runs.

## 6. Implications

- **The bug is in the test, not in `sp group`.** In real usage the process runs
  to completion; nobody kills `sp group` in the milliseconds between `Reordered`
  and `Groups updated`. Even if they did, the damage is a missing/stale
  `refs/spry/groups` update — the reorder itself (branch ref + working tree) is
  already finalized before the message prints. Nothing user-visible breaks.
- **For the doc-churn work:** the scrubber's input (`git log --all --reflog`)
  is sensitive to _any_ kill-timing race in a doc test. This one is the reorder
  test's alone; the other group tests already wait for the terminal message.
- **Pinning git identity/date in the harness would NOT fix this.** The 8-vs-9
  variance is about the _presence_ of a commit, not its SHA. (Pinning would fix
  a different problem: the `update tracked branches` / `update group records`
  commits get wall-clock committer dates because `group-tui-harness.ts:22` uses
  `createRealGitRunner()` without `DETERMINISTIC_GIT_ENV`, so their SHAs churn
  every run even at a stable count.)
- Side observations, deterministic but worth knowing (not causes of variance):
  - A pure reorder with zero groups still creates and pushes an empty
    `refs/spry/groups` commit and prints `✓ Groups updated (0 groups)`.
  - `sp group` rewrites the stack (`injectMissingIds`) on load, _before_ the
    editor opens — cancelling still leaves the branch rewritten with fresh
    random `Spry-Commit-Id`s.

## 7. Possible remedies (not yet decided)

Ranked; the diagnosis stands regardless of which (if any) is chosen.

1. **Test-side, minimal:** in the reorder doc test, wait for `Groups updated`
   instead of `Reordered` before `term.close()`
   (`tests/commands/group.doc.test.ts:119`). One line; makes the test consistent
   with the other group doc tests; pins the count at 9. Downside: none apparent.
2. **Driver-side, general:** give `term.close()` a graceful path — e.g. wait
   briefly for natural process exit before `proc.kill()`
   (`tests/lib/terminal-driver.ts:109-121`). Protects every current and future
   doc test from mid-command kills. Downside: more machinery; can slow tests
   that legitimately kill long-running processes.
3. **Command-side, skip empty/unchanged group writes:** make
   `saveAllGroupRecords` a no-op when records are empty and the ref doesn't
   exist (or unchanged vs. the loaded records). Removes a pointless commit+push
   for pure reorders. Downside: behavior change other tests/fragments may
   capture; does not fix the race in general (a non-empty grouping still writes
   after `Reordered`).
4. **Command-side, message ordering:** only print success messages after all
   persistence completes (or treat `Groups updated` as the sole completion
   sentinel, which it effectively already is). Downside: loses progressive
   feedback; the real issue is the test waiting on the wrong sentinel.

## 8. Open questions

- In 8-runs, does the kill land before `commit-tree` (no object created) or
  between `commit-tree` and `update-ref` (an unreachable object exists)? Not
  distinguishable via `log --all --reflog` and irrelevant to the count; `git
fsck --unreachable` could tell if it ever matters.
- `pushGroupRecords` never completed before the kill in any observed run (the
  origin never had `refs/spry/groups`). Harmless here, but it means the reorder
  doc test never exercises the push path at all.
- Is `✓ Groups updated (0 groups)` after a pure reorder the intended UX, or
  should a reorder-only save skip group-record persistence entirely (remedy 3)?
