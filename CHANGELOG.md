# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `sp group --apply <json>` runs grouping/reordering/PR-close/PR-adopt non-interactively from a JSON doc (`"-"` reads the doc from stdin), for scripting the editor without the TUI. `groupCommand` branches to a new `applyGroupDoc` (`src/commands/group.ts`) when `--apply` is set, leaving the interactive path untouched. The path is `parseApplyDoc` → `reconcile` (both already offline/pure, `src/parse/apply-doc.ts`) → apply the resulting plan: reissued ids get their `Spry-Commit-Id` trailer rewritten via `rewriteCommitChain`/`finalizeRewrite`, or (mutually exclusive with reissue — see below) a changed order is applied via the existing `rebasePlumbing` reorder path; group records are saved with `saveAllGroupRecords`; `pr:CLOSE` intents are recorded as `CLOSED` in the local PR cache (`refs/spry/prs`) for a later `sp sync` to execute against GitHub; group records are pushed best-effort. **Fully offline**: open-PR ids for adoption/close validation are read only from the local PR cache, never from `gh` — `applyGroupDoc` makes no `gh` calls. `reconcile` now rejects a doc that both reissues an id and reorders commits in the same apply (a reissue changes commit hashes via a trailer rewrite, which would make the reorder plan's captured hashes stale); do the two in separate applies. Wired in `src/cli/index.ts` as `--apply <json>` on the `group` command.

### Fixed

- `sp sync`/`sp view` no longer treat a stale MERGED/CLOSED pull request as a branch's live PR. GitHub never deletes a PR, so a reused (or fixture-recycled) head branch accumulates old records — and the PR-lookup query (`src/gh/pr.ts`) asked for only the single most-recently-_updated_ PR on the branch (`first: 1`, `orderBy: UPDATED_AT DESC`), with no state filter. Closing a stale PR bumps its `UPDATED_AT`, so that dead record could sort ahead of the live one and become "the PR" spry cached and displayed. Two coordinated fixes: (1) the query now fetches `first: 10` and `parsePRResponse` prefers the lone `OPEN` node, falling back to the newest node only when none is open (so `sp view` still renders MERGED/CLOSED when there is genuinely no live PR); (2) `writePRCache` (`src/commands/sync.ts`) now caches a PR only when its state is `OPEN` — matching how retarget/park already gate on `OPEN` — so a stale non-open record found during sync is ignored rather than cached and announced via a spurious "✓ Updated PR cache" line. Merged-state display still comes from the cache write made while the PR was open; `sp land`/`sp clean` own its removal. This also makes the doc-generation record gate robust to residual PRs on the shared `spry-check` fixture: recorded cassettes may now contain stale CLOSED records for a branch and the generated docs stay byte-stable, because the code ignores them. Covered by new unit tests in `tests/gh/pr-parse.test.ts` (OPEN-preference selection) and `tests/commands/sync.test.ts` (sync does not cache a stale MERGED/CLOSED PR). **Cassettes re-recorded** because the query string (a replay match key) changed from `first: 1` to `first: 10`.
- Doc tests: `setupDocRepo` (`tests/lib/doc-repo.ts`) fixed two code-review findings in its per-test namespacing and record-mode repo slug. **(1)** The per-test GitHub namespace (trunk branch + spry branch prefix) was keyed by the doc section's LEAF (`options.section.split("/").pop()`) + order, while cassettes are keyed by the FULL sanitized section + order (`tests/lib/cassette-harness.ts`'s `commands/sync` -> `commands__sync--020.json`) — a documented, unaddressed hazard: two future sections sharing a leaf at the same order (e.g. a hypothetical `tui/sync` alongside `commands/sync`) would silently share a namespace and bulldoze each other's branches even though their cassettes would not collide. Fixed by factoring the sanitization into a single new export, `cassetteKey({ section, order })`, that `cassettePath`, `fragmentPath` (`tests/lib/doc.ts`, which previously open-coded the identical key a third time), and `setupDocRepo`'s namespace key now all call — so the three keyings are provably identical rather than parallel implementations that could drift, and a leaf collision is now structurally impossible. Fragment filenames are byte-identical before and after. **(2)** In record mode, `setupDocRepo` re-derived the repo slug pinned into `spry.repo` as `${SPRY_TEST_REPO_OWNER ?? "happycollision"}/${SPRY_TEST_REPO_NAME ?? "spry-check"}`, but the repo it actually cloned (`createRepo({origin: "github"})` -> `createGitHubFixture()`) resolves owner from `SPRY_TEST_REPO_OWNER` OR FALLS BACK to the authenticated `gh` user — a second, independent resolution that silently diverges from the pinned slug whenever a contributor records without that env var set (their `gh` traffic would target their own fork while `spry.repo` said "happycollision"). Fixed by requiring callers to thread the `GitHubFixture`'s already-resolved `owner`/`repo` through new `fixtureOwner`/`fixtureRepo` options in record mode (one resolution, one source of truth); replay keeps a new explicit `REPLAY_REPO_SLUG` constant (`happycollision/spry-check`) with a comment explaining why replay must pin it (recorded `gh` args embed the slug verbatim, and replay matches on args). All record-mode `docTest` call sites (`sync.doc.test.ts` x5, `land.doc.test.ts` x2, `group.doc.test.ts` x1) now capture the `fixture` parameter `withGitHubFixture` already hands them and pass it through. `tests/lib/doc-repo.test.ts` extended to cover both slug-derivation modes and the full-section namespace key (including a same-order, different-leaf collision case). **Cassettes invalidated by design**: changing the namespace key format changes the branch/trunk names embedded in every recorded `gh` arg, so all 8 fixture-backed doc tests (group order 25; land orders 10, 20; sync orders 20, 22, 25, 60, 70) now make `gh` calls whose args no longer match the OLD committed cassettes ("No matching recorded entry for args [...]"). 7 of the 8 surface this as a hard offline-replay failure; the 8th (`sync` order 70, "Reordering a stack without merging PRs") tolerates it silently — its mismatched call is the best-effort batched PR lookup that `sp sync` already catches and downgrades to a warning on any `gh` error, and its one `gh`-dependent assertion is gated behind `if (recording)` — so it still passes replay despite exercising the same stale cassette. This is expected for this commit; cassettes are re-recorded in the immediately following commit. (No `sp` runtime change; test-infra only.)
- Doc tests: the `sp group` TUI doc tests (`tests/commands/group.doc.test.ts`) now distinguish a completed save from a cancel instead of asserting only `waitForExit(...) === 0` — the cancel path (`console.log("Cancelled."); return;` in `src/commands/group.ts`) exits 0 identically to a successful save, so the bare exit-code check could not tell a mistimed keystroke, or a regression where the editor exits cleanly without persisting, from a genuine save. The three save-path tests ("Grouping commits", "Reordering commits", "Renaming a group") now assert `term.capture().text` contains the completed-save sentinel `"Groups updated"` after `waitForExit`, following the same post-exit `capture()` pattern the "Adopting a PR" test already used. The two cancel-path tests ("Dirty tree disables reordering", "Conflict prediction") now assert `"Cancelled."` post-exit, since they previously asserted only the same ambiguous exit code. Verified the new assertions have teeth: temporarily simulating a cancel keypress in place of the "Grouping commits" save keypress reproduced exit code 0 while `"Groups updated"` was absent from the captured screen (replaced by `"Cancelled."`), failing the new assertion as expected; reverted after confirming. Assertion-only change — no `src/` change, no change to what doc fragments capture, no cassette impact. (No `sp` runtime change; test-infra only.)
- Doc tests: the two record-mode `sp land` doc tests (`tests/commands/land.doc.test.ts`) no longer carry an outer `docTest` timeout smaller than the sum of their own inner record-mode waits. Both call `setupLandStack`, which awaits `waitForChecks` twice SEQUENTIALLY at up to 240000ms each (480000ms worst case alone) — already exceeding the previous flat `timeout: 300000`, so a slow GitHub Actions queue could kill the suite's single most important validation (the canonical land test, order 10) with bun's generic timeout instead of a diagnostic error. The canonical test additionally pays a MERGED-fidelity poll and the exclusive record-lock's acquire wait. Fix: both tests now use a mode-dependent timeout — `isRecording()` selects a record-mode budget sized to its own worst-case inner-wait sum (order 10: 1500000ms, covering `setupLandStack` + the MERGED poll + lock-acquire headroom; order 20: 580000ms, covering `setupLandStack` + its TUI waits) versus a replay budget of 60000ms — sized above order 20's TUI waits (15000 + 20000 = 35000ms), which run for real in replay too (only the gh traffic is cassette-served), while still surfacing a genuine replay hang in a minute instead of the old 300000ms. Separately, the canonical test's MERGED-fidelity poll (`waitForValue`) was using the library's tiny default budget (10 attempts × 500ms ≈ 5s) despite polling the same class of GitHub-eventual-consistency signal as `waitForChecks` (240000ms budget, 5s cadence) — two orders of magnitude under-provisioned for an async flip the test's own comment says GitHub applies after the push. It now passes an explicit `intervalMs: 5000, attempts: 48` (~240s ceiling), matching `waitForChecks`'s cadence. Audited `sync.doc.test.ts` and `group.doc.test.ts` for the same outer-timeout-vs-inner-wait-sum bug: neither has any `waitForChecks`/`waitForValue` polling loop, so their existing flat `timeout: 180000` budgets (dominated by TUI waits of at most ~35000ms) are not undersized and were left unchanged. (No `sp` runtime change; test-infra only. The record-mode budgets are validated by the pre-merge record gate; the replay budget is exercised by every offline run.)
- Test fixture: `reset()` (`tests/lib/github-fixture.ts`) no longer silently swallows per-item `gh` failures in `closeAllPRs`/`deleteAllBranches`. Both ran their write calls under `.nothrow()` inside a `Promise.all` and returned only a success count, so a failure (e.g. a secondary rate limit under concurrent writes) just lowered the count — `reset()`'s `report.errors` was populated solely from THROWN exceptions, so `ensureSessionFixture`'s `if (report.errors.length > 0) throw` guard could never fire on this path, and a stale OPEN PR could survive the once-per-process suite-start reset undetected. Fix: a new generic `runWithRetry` helper runs the first pass concurrently as before, then retries any failures once, sequentially, after a short pause (1.5s) to let rate limits/cascades settle. A close-retry failure is rechecked against a real `gh pr view --json state` query (`isPRAlreadyClosed`) before being reported, because GitHub auto-closes a PR when its head branch is deleted — a benign race with `deleteAllBranches`, not a genuine failure. Failures that persist past the retry (and the recheck, for PR close) now land in `report.errors` with operation + item + stderr context, so a broken reset throws loudly instead of reporting a clean one. `closeAllPRs()`/`deleteAllBranches()`'s public `Promise<number>` signatures are unchanged; `reset()` uses new internal `*WithFailures` variants. Covered by new offline unit tests in `tests/lib/github-fixture.test.ts` (no `gh`/network — `runWithRetry`'s `attempt`/`isAlreadyDone` are injected fakes). (No `sp` runtime change; test-infra only.)
- Test fixture: the "Test repository ... not found" / missing-safety-marker error hint always said `bun run scripts/setup-spry-check.ts`, which bootstraps the WRONG repo whenever `SPRY_TEST_REPO_NAME` (or `SPRY_TEST_REPO_OWNER`) is overridden — e.g. the fixture's own unit tests' dedicated `spry-check-fixture` repo. New `buildSetupHint()` builds the hint dynamically, prefixing `SPRY_TEST_REPO_NAME=<name>`/`SPRY_TEST_REPO_OWNER=<owner>` exactly when the resolved repo/owner differ from the default, so following the hint verbatim now bootstraps the right repo. Covered by new offline unit tests. (No `sp` runtime change; test-infra only.)
- Test infra: several `sync.test.ts` unit tests (`checkSync`, and three `parkMismatchedToTrunk` cases) called console-emitting command code without holding `tests/lib/capture.ts`'s output-capture mutex, so under `bun test --concurrent` a concurrently-running sibling test could have its captured lines corrupted by these tests' uncaptured `console.log` calls (e.g. `parkMismatchedToTrunk`'s "↻ parked PR #..." or `writePRCache`'s "✓ Updated PR cache ..."), an intermittent-flip risk for the assertion at `sync.test.ts`'s "no park calls when the stack is not reordered" test. All four now wrap their command-code invocation in `captureLogs()`/`restore()`; a full sweep of every test file for other uncaptured console-emitting `src/` calls found no other offenders. Separately, `tests/lib/capture.ts`'s shared output lock (`acquireOutputLock`) had no visibility when a holder's test hung: Bun's per-test timeout fails that test but never releases the lock, so every later capturing test timed out with no clue why. `acquireOutputLock`/`captureLogs` now accept an optional `holder` label and, when a waiter has queued past a threshold (default 30s, overridable for tests), emit one diagnostic naming the current holder and how long it's been held — through the real `console.error` captured at module load, so the diagnostic itself is never swallowed by another test's capture. No force-release or acquire-rejection was added: a legitimately long queue must still work. New `tests/lib/capture.test.ts` covers the diagnostic firing/not-firing and confirms mutual exclusion still holds. (No `sp` runtime change; test-infra only.)
- Doc tests: the scrub-SHA scan (`tests/lib/doc.ts`) no longer leaks concurrent siblings' commits into a fragment's SHA pool under parallel record mode (spry-4zs6, found by the pre-merge gate: `SHA_POOL exhausted — 19 unique SHAs needed but pool only has 18` on `commands__sync--060.json`, with racy discovery COUNT and — worse for fragments that do render SHAs — racy ORDER). Root cause: in record mode every fixture test's clone points at the one shared `spry-check` repo, and `sp sync`'s `git fetch` pulls every in-flight sibling's branches into `refs/remotes/*`; the scan's `git log --all --reflog` walk swept those foreign commits, and `--exclude` cannot fix it because the remote-tracking REFLOGS still feed `--reflog`. Fix: the scan now runs `git remote remove origin` on the doc repo first — one stroke that drops all remote-tracking refs AND their reflogs (including the `origin/HEAD` symref) — before the existing walks, scoping discovery to the test's own work: local branches, HEAD/refs-heads reflogs (which fetch never writes), local `refs/spry/*`, and the origin-side walk. The scan runs after the test body on a repo that is torn down immediately after, so the mutation is invisible to tests. Replay discovery is unchanged (a local bare origin only ever contains that test's own pushes, so its remote-tracking refs were redundant): verified by two full record runs with byte-identical per-fragment SHA counts and `docs/generated` byte-identical through record + double playback. (Test-infra only. Fixes spry-4zs6; follows spry-qfc8.7.)

- Test repos (`tests/lib/repo.ts`) now stamp per-run seeded commit dates instead of the pinned `2020-01-01` constant: a base date derived once per process (shifted ~11 years into the past) advances by one hour on every commit-capable git invocation via a process-global counter — so seeded dates (and thus SHAs) are unique across runs _and_ across repos within a run, while staying strictly monotonic inside each repo. Byte-stable SHAs were never load-bearing — no cassette contains a SHA, no doc test asserts one, and the doc scrubber maps SHAs to a placeholder pool by discovery order — but _reused_ SHAs across recording sessions were actively harmful: GitHub accumulates check runs on a repeated SHA, so a re-recorded PR's `statusCheckRollup` grew a stale-run residue every session (the `sp land` readiness-gate trap, spry-76lu's accumulation half). Per-run unique SHAs end that accumulation, which also let `land.doc.test.ts` drop its hand-rolled per-run nonce paragraph. The distinct monotonic dates additionally give the scrubber's date-ordered `git log --all --reflog` walk a total order — strictly stronger than the previous all-identical dates. The wall-clock-dated bookkeeping commits some harnesses make without the seeded env still sort deterministically (now strictly newer than every seeded commit, since the base sits in the past). Generated docs re-baselined once (placeholder pool slots reassigned by the new walk order) and are stable thereafter. (No `sp` runtime change; test-infra only. spry-qfc8.5.)

- Cassettes: recording (`src/lib/recording-client.ts`) now normalizes cassettes as it writes them, eliminating the two structural churn sources that made every re-record dirty `git status`. (1) GitHub-minted PR numbers are rewritten to a deterministic 1001, 1002, ... sequence in first-seen order, via anchored patterns only (`pull/<n>` in URLs, `"number":<n>` in JSON — never a bare numeric replace, which would collide with fields like `totalCount`); the same map is applied simultaneously (single pass, so real numbers overlapping the 1001+ range cannot cascade) to recorded stdout/stderr, **args**, and **stdin** — args and stdin are replay match keys, and the CLI derives tokens like `pr edit <n>` by parsing an earlier entry's normalized stdout, so an unrewritten recorded arg could never match at replay time (real case: `commands__sync--070.json`'s `pr edit` entries). (2) Recorded options are stripped to `stdin` — the only option the args-keyed replayer matches on — dropping the per-run `/tmp/spry-test-<pid>-<n>` `cwd` paths that `commands__land--020.json` and `commands__sync--025.json` carried. All eight cassettes re-recorded in normalized form; the AGENTS.md pre-merge gate now expects at most GitHub Actions check-run (`statusCheckRollup`) state to differ across re-records, and any PR-number/`cwd`/args diff is a real failure. Cassette JSONs are now excluded from oxfmt (`.oxfmtrc.json`): the formatter collapsed short arrays that the recorder's `JSON.stringify` expands, so a formatted committed cassette could never byte-match a fresh recording — the recorder's output is the canonical format for these machine-generated files. (No `sp` runtime change; the recording client is the test-only record seam. spry-qfc8.4.)

- Test fixture: `tests/lib/github-fixture.test.ts` no longer fails intermittently under `SPRY_RECORD=1`. Its assertions read GitHub's eventually-consistent endpoints once, immediately after a write, so they raced the write's replication: (1) `mainCommitCount` (a single `commits?sha=main` read) was asserted right after `reset()`'s ref PATCH and could still see the stale pre-restore listing (`expect(...).toBe(1)` got `2`); (2) `verifyTestRepo`'s single `contents/README.md` read could transiently error or return an empty body during a concurrent `main` rewrite, spuriously reporting the safety marker missing and making `reset()` push a "Refusing to mutate … missing safety marker" error. The failing subset _shifted_ between runs — the eventual-consistency tell — while the live repo was always clean afterward, proving the machinery worked and only the reads were racy. Fix: a new condition-based-waiting helper (`tests/lib/wait-for.ts`, `waitForValue` — polls a fresh read until a predicate holds, else throws) now backs both sites: the test polls `mainCommitCount` until it converges, and `verifyTestRepo` retries only _inconclusive_ reads (gh error or empty body) while a decisive "content present but marker absent" still fails immediately, preserving the safety guard. The existing `waitForSpryRef` was rewritten on the same helper (no behavior change). Additionally, the file's three mutating tests now hold the shared `spry-check` record lock (new `withSpryCheckRecordLock` export) so a full-suite record can't interleave their `reset()`/`main` rewrites with a concurrent doc test's `sp land` — closing the concurrency amplifier that a poll-for-`==1` would otherwise hard-timeout on. (No `sp` runtime change; record-mode-only. Fixes spry-69mf; unblocks the AGENTS.md pre-merge record gate.)
- Doc tests: the `sp sync` "Opening a new PR" fragment (`tests/commands/sync.doc.test.ts`, order 20) is now deterministic across re-recordings. It was missing the two PR-number scrubs its siblings have, so a fresh `SPRY_RECORD=1` run leaked the GitHub-minted PR number (`Created PR #1148` / `pull/1148`) into `docs/generated/commands/sync.{md,html}` instead of the canonical `#42`. It also registered `doc.scrub(repo)` before the github-host canonicalization scrub: in record mode `repo.originPath` _is_ the fixture URL (`https://github.com/<owner>/spry-check`), so `doc.scrub(repo)` rewrote that prefix to `/tmp/repo-origin` first and shadowed the `.../spry-check → owner/repo` scrub, producing a non-deterministic (and md/html-divergent) PR URL. Fix: order-20 now canonicalizes the github host _before_ `doc.scrub(repo)` and gets the same `Created PR #\d+`/`pull/\d+` scrubs as orders 22/25/70; the four sibling live-fixture fragments (22/25/60/70) got the same scrub-ordering fix so a full-suite record stays record-safe. Substitutions apply in registration order, so the earlier-registered host scrub now wins in record mode; replay (originPath is a `/tmp` bare path) is unaffected. (No `sp` runtime change; test/doc-only. Fixes spry-w313; follows spry-cteo.)
- Test fixture: the three live-fixture doc-test files (`sync`, `land`, `group`) no longer race under a full-suite `SPRY_RECORD=1 bun test`. They all mutate the single shared `happycollision/spry-check` repo, and Bun runs test files concurrently — so while one test had pushed a branch and was waiting on GitHub, another test's repo-wide `fixture.reset()` (close PRs + delete branches + purge `refs/spry/*` + restore main) would delete the first test's branch/PR, failing it with `No commits between main and <branch>`, a `CLOSED` PR, or a CI-wait timeout. The tell was a _shifting_ subset of these tests failing between identical record runs; recording each file serially always passed. Fix: a new `withGitHubFixture()` wrapper (`tests/lib/github-fixture.ts`) serializes record-mode bodies via a cross-process advisory lock (`tests/lib/record-lock.ts`, atomic `mkdir` + stale-lock recovery). The lock is held for a test's _entire_ body — the opening reset, the `sp` run, the assertions, and the closing reset — because tests interleave between reset and their PR work, so a reset-only lock does not help. Only record mode locks; offline replay runs fully parallel with `fixture === undefined` and no lock. (No `sp` runtime change; record-mode-only. Fixes spry-cteo; follows spry-bei/spry-xil.)
- `sp sync` now parks reordered PRs to trunk before pushing. When the stack has been reordered since the last sync, an in-place force-push could make an open PR's head reachable from its _stale_ GitHub base, and GitHub would mark that PR `MERGED` even though it was never merged. `syncCommand` now checks for a reorder (`stackHasReorder`) before the push phase and, when found, retargets every mismatched open PR to `config.trunk` first (`parkMismatchedToTrunk` — trunk never contains a stack head, so this retarget cannot look like a merge). Branches whose park fails are excluded from the push (`pushExistingBranches` now takes a skip-set) and flip the run's failure exit code, rather than pushing an unparked branch into a stale-base race. The existing post-push retarget phase still runs afterward to move each PR onto its correct stacked base. `sp sync --all` gets the same protection: it now batches its PR lookup before the push loop and parks each tracked stack that has been reordered before force-pushing it.
- `sp sync` no longer risks clobbering a concurrent remote force-push. `checkSync` now runs a `git fetch` before the push phase, which refreshes the remote-tracking ref (`refs/remotes/<remote>/<branch>`) that a bare `--force-with-lease` uses as its lease baseline — so a concurrent force-push would no longer be detected. `sync` now snapshots the pre-fetch remote-tracking tips (`snapshotRemoteTips`, keyed like `listRemoteBranches`) and pins each push's lease to that baseline via an explicit-sha `--force-with-lease=refs/heads/<branch>:<pre-fetch-sha>`. Because the sha is explicit, git compares the actual remote against it (not the already-advanced tracking ref), so a remote that moved off the snapshotted SHA is rejected as stale. Branches with no pre-fetch tracking ref (first publish, or `sp sync --all`, which does not fetch) fall back to the bare `--force-with-lease` — today's behavior. `sp land`'s ff-push (`forceWithLease: false`) is unaffected.

- Test fixture: `createGitHubFixture().reset()` now purges every custom ref under `refs/spry/*` (via `git/matching-refs/spry/` + `DELETE`), not just PRs and branches. Because the doc-test commit-ids are deterministic, a stale `refs/spry/groups` record left on the live `spry-check` repo by a prior record run would re-match today's commits and silently collapse a multi-commit stack into a single group unit during record mode — breaking `sp land` re-recording. The purge re-lists and retries until `refs/spry/` is actually empty, because GitHub's git-refs API is eventually consistent and `gh api -X DELETE` exits 0 even on a 422 "reference does not exist" — so a single delete pass could report success while the ref survived. `reset()` reports the genuinely-deleted count as `CleanupReport.spryRefsDeleted`. (No `sp` runtime change; record-mode-only. Blocked spry-dzp.5.)
- Test fixture: `createGitHubFixture().reset()` now rolls the default branch back to its single-commit baseline (`restoreMainToBaseline`), closing the _second_ record-mode pollution vector alongside the `refs/spry/*` purge above. `sp land`'s whole job is to fast-forward `origin/main` past the baseline, and neither `closeAllPRs` nor `deleteAllBranches` (which deliberately skips the default branch) rolls it back — so a prior land recording left `main` advanced, and the next record run's `setupLandStack` branched `feature/x` off the already-landed `main`, corrupting the stack parse (`Add login`/`Add logout` residue accumulated on `main` run after run). Reset now finds the branch's root commit (the one setup-spry-check.ts force-pushes) via `git/commits?sha=<branch>` and force-PATCHes the branch ref back to it when it is ahead; it reports whether it moved as `CleanupReport.mainRestored`. Land cassettes are now re-recordable back-to-back with no manual `setup-spry-check.ts` run. (No `sp` runtime change; record-mode-only. Fixes spry-bei.)
- `sp land` no longer retargets in-scope PRs to trunk before the fast-forward push. Retargeting while trunk was still at its old position froze a cumulative `old-trunk…head_k` three-dot diff into each merged PR — the bottom PR showed 1 commit, the top PR the entire stack and the union of every file it touched. GitHub marks a PR `MERGED` on reachability from the default branch (which the ff-push guarantees), not on its base, so the retarget was never needed for merged status. Land now leaves each PR on its stacked base, so every merged PR keeps its own single-unit diff. Land makes zero `gh pr edit` calls.
- Generated docs (`docs/generated/`) no longer churn on every `bun test` + `bun run docs:build`. Three independent causes were fixed: (1) the HTML renderer switched from `ansi-to-html@0.7.2` to `anser` — the former (its final release) renders the SGR reset `ESC[22m` as an _opening_ `<span>`, producing unbalanced markup that changed run-to-run; (2) the `sp group` reorder doc test killed the TUI subprocess after the mid-command `Reordered` message, racing the group-records write that follows it — the repo's reflog commit count flipped between runs, shifting the doc scrubber's placeholder assignments (diagnosis in `docs/investigations/2026-07-07-group-reflog-nondeterminism.md`); the test now waits for the final `Groups updated` message. (3) A root `.gitattributes` (`* text=auto eol=lf`) neutralizes `core.autocrlf` line-ending churn.
- `sp sync` no longer force-pushes a branch whose remote tip already equals the local tip. `listRemoteBranches` already fetches each remote branch's SHA via `ls-remote`; that SHA is now compared against the unit tip and the redundant `git push` is skipped when they match. A second `sp sync` with no new commits does no branch-push network work. Branches that are up to date are still included in the retarget pass, so a correct-tip branch with a stale PR base is still fixed. `sp land` inherits the speedup through its embedded `sp sync`. (PR-cache push churn is unchanged for now.)
- CLI-thrown command errors now print as clean `✗ ...` failures instead of leaking Bun source-frame stack traces when running from TypeScript in development.
- `sp sync --open` no longer hangs when opening a pull request whose body is empty. The git/gh subprocess runners now feed stdin via `Bun.spawn`, so an empty stdin is a real EOF instead of being inherited from the terminal — Bun's `$` shell silently no-ops a `< ${buffer}` redirect when the buffer is empty, which left `gh pr create --body-file -` blocking on the TUI's terminal forever.
- PR status query against GitHub was broken: it referenced `$REPOSITORY_OWNER`/`$REPOSITORY_NAME`, which `gh api graphql` does not auto-populate, so every real PR lookup failed with `variableNotDefined`. This was masked because all tests stubbed `gh`. The query now declares `$owner`/`$repo` and `sp sync`/`sp view`/`sp land`/`sp group` pass them from a resolved repo slug (a new optional `spry.repo` git-config override, falling back to parsing the remote URL). This restores `sp sync`'s PR-cache refresh and retargeting against real GitHub.
- `sp group` reorder: `rewriteCommitChain` now accepts an optional `base` commit so reordered stacks are rooted at the merge base rather than being appended on top of the original chain. Previously, reordering two commits would produce a three-commit history instead of two.
- `sp group` rename: spaces typed during rename mode were silently dropped because the `space` keypress event was not handled in `applyRename`. Spaces are now treated as literal characters when renaming a group title.
- `sp group` reorder no longer silently drops commit content. Reordering now diff-replays each commit (via the same engine as `sp rebase`) and aborts with a conflict message instead of producing a corrupted stack.

### Changed

- Record mode is now concurrent: `bun run record` (`SPRY_RECORD=1 bun test --concurrent`) records the whole suite with the GitHub CI waits overlapping, dropping record wall clock from the sum of per-test waits (~320s serial) to roughly the slowest single test (~135s observed). Three structural changes make that safe. (1) **Per-test namespaces**: `setupDocRepo` now gives every fixture doc test its own trunk (`trunk/<section-leaf>-<order>`, pushed from the fixture repo's baseline/root commit) and branch prefix (`spry/t-<section-leaf>-<order>`), pinned PER TEST (not per run) because both are cassette keys (`pr create --base <trunk>` is recorded); new scrubs map them back to `main`/`spry/dondenton` so the generated docs are byte-identical to before. `spry.trunk` is first-class explicit config, so nothing in `sp` assumes trunk == default branch. (2) **Suite-start reset instead of per-test lock**: `withGitHubFixture` record mode now runs ONE memoized repo-wide `reset()` per process (under the record lock) before the first body, then runs bodies lock-free in parallel — cross-run staleness is handled by that single reset, and one-process recording is the supported topology. (3) **Canonical land test**: `commands/land` order 10 alone keeps `spry.trunk` on the real default branch and serializes via a new `exclusive: true` option (record lock + best-effort `restoreMainToBaseline` afterward) as the standing validation of the real MERGED transition; the other land test lands onto its own per-test trunk. A first concurrent record run exposed one more piece of shared repo-wide state the task hadn't anticipated: the remote `refs/spry/prs` / `refs/spry/groups` bookkeeping refs, which every concurrent test's `sp` best-effort fetches/pushes — the resulting nondeterministic `⚠ Could not push PR cache` warnings leaked into the generated docs. Fixed with a small runtime env seam (`src/lib/refs-seam.ts`, `SPRY_REMOTE_REFS_PREFIX`, read at call time like the existing `SPRY_GH_CASSETTE*` seam): `fetchPRCache`/`pushPRCache`/`deletePRCacheRemote` and `fetchGroupRecords`/`pushGroupRecords` remap only the REMOTE side of those refs (local names untouched, so in-process test helpers keep working), and `setupDocRepo` sets `refs/spry/t-<section-leaf>-<order>` in the env it hands each test's subprocesses. Identity when unset — production refspecs are byte-identical. Recording that validation live exposed that GitHub flips a PR to MERGED on reachability from its **base** branch when the base is pushed (a side-branch trunk push flips its PR too, and the upper stacked PR stays OPEN even on a default-branch land) — refining the roadmap's "reachability from the default branch" phrasing; captured as beads spry-tm2l, and the canonical test asserts the trunk-based PR's MERGED flip. The fixture's own unit tests (`tests/lib/github-fixture.test.ts`) exercise repo-wide destructive ops that no namespace contains, so they now target a second dedicated repo (`spry-check-fixture`, bootstrapped via `SPRY_TEST_REPO_NAME=spry-check-fixture bun run scripts/setup-spry-check.ts`; `createGitHubFixture` grew a `repo` option) and serialize among themselves in-process. Carried `setupDocRepo` fixes: the returned gh-seam env now derives from the caller's `recording` option instead of re-reading the global `SPRY_RECORD` (a contradictory setup is impossible), and the github-host scrub regex is built from the env-derived repo name instead of hardcoding `spry-check`. All eight cassettes re-recorded with the namespaced keys; `docs/generated` reproduced byte-identically through record + double playback. (Runtime change limited to the no-op-by-default remote-refs seam; everything else is test-infra. spry-qfc8.7.)

- Doc tests: a new `setupDocRepo` helper (`tests/lib/doc-repo.ts`) now owns the invariant setup prefix every live-fixture (cassette-backed) doc test repeated by hand — create the repo against the right origin (`github` when recording, `local` on replay), register the determinism scrubs, pin the `spry.trunk`/`spry.remote`/`spry.branchPrefix`/`spry.repo` config, and hand back the gh-seam cassette env. The scrub registration order is the point: the github-host canonicalization (`https://github.com/<owner>/spry-check → owner/repo`) MUST precede `doc.scrub(repo)` because in record mode `repo.originPath` _is_ the fixture URL — reversed, the repo scrub rewrites the URL prefix to `/tmp/repo-origin` and leaks a divergent PR URL into the generated docs (the spry-w313 bug, previously guarded only by a 4-line comment copy-pasted into five tests). The helper deletes the footgun instead of documenting it: sync orders 20/22/25/60/70, group order 25, and both land doc tests now call it, keeping only per-test additions (commits, group records, tracked branches, extra scrubs) in their bodies. A unit test (`tests/lib/doc-repo.test.ts`) locks the ordering via the real doc-pipeline scrubber (`createDocScrubber`, extracted from `docTest`) in fake-record mode with an injected repo factory — no network. Pure refactor: replay suite + `docs:build` reproduce `docs/generated/` byte-identically. (No `sp` runtime change; test-infra only. spry-qfc8.6.)

- `sp land` now verifies stack readiness (Spry-Commit-Ids present, branches pushed, PRs correctly targeted, checks green) via a read-only check and fails with guidance to run `sp sync`, instead of embedding a mutating `sp sync` that retargeted PR bases mid-land. Land calls `checkSync` (fetch + PR lookup + PR-cache refresh, no writes), runs `analyzeStack` over the `--through` scope, and aborts through `landBlockers` before the fast-forward push — surfacing every unready unit's reasons (missing id, unpushed branch, mis-targeted PR base, failing/pending checks, changes-requested/review-required, no open PR). It no longer injects commit ids and no longer issues any `gh pr edit`. A unit whose remote branch is gone is now caught by the readiness gate rather than the cleanup tail (the tail's already-gone tolerance remains covered by `sp clean`).

### Added

- `sp land` now scrubs the state of the units it just landed, immediately after the fast-forward push succeeds. (1) It drops the landed units' entries from the PR cache (`refs/spry/prs`) — always, not gated by any setting — because `sp sync`'s self-heal cannot clear a fully-landed stack (`writePRCache` early-returns on an empty cache), leaving stale merged-PR entries behind; when the whole stack lands the cache is emptied and the now-empty ref is propagated to the remote as a ref deletion. (2) It removes the landed group records from `refs/spry/groups` (always; groups are atomic so a landed group is wholly in scope). (3) When `spry.autoDeleteOnLand` is true, it deletes each landed unit's spent remote branch (an already-gone branch is treated as benign). Every cleanup step is best-effort: a failure warns and continues, never aborting the completed land. The closing guidance now reflects what cleanup did — pointing at `sp clean` only when auto-delete is off. No new `gh` calls are made (all cleanup is git plumbing).
- `spry.autoDeleteOnLand` git-config setting (boolean, default `false`) — read by `readConfig` into `SpryConfig.autoDeleteOnLand`. When true, `sp land` deletes the remote branches of the units it just landed (see the `sp land` scrub entry above); it is opt-in because some repos already have GitHub auto-delete head branches on merge. Parsed via `git config --get --type=bool`, so truthy values (`true`/`1`/`yes`/`on`) become true and unset, empty, falsy, or invalid values all resolve to false without throwing.
- `sp clean` — deletes remote spry branches whose commits have landed on trunk. "Landed" is defined deterministically as the branch tip being an ancestor of `<remote>/<trunk>` (`git merge-base --is-ancestor`); it does not attempt patch-id/cherry, `Spry-Commit-Id` trailer, or squash/rebase-merge detection. It fetches the remote with `--prune` (so refs deleted upstream don't linger as stale tracking refs), finds landed branches under `<remote>/<branchPrefix>/*`, and deletes each from the remote. A genuine delete failure warns and continues the sweep, then exits 1; deleting a branch that is already gone upstream is treated as benign, so the command is idempotent. `--dry-run` lists what would be deleted without touching the remote. `sp land` already points users at it. Backed by a new `deleteRemoteBranch` helper in `src/gh/push.ts`.
- Real `gh` cassette record/replay for doc tests. An env-guarded seam in the CLI (`SPRY_GH_CASSETTE` to replay, `SPRY_GH_CASSETTE_RECORD` to record; inert when unset) lets doc tests run the real `sp` binary while serving `gh` from JSON recorded against the live `spry-check` repo. Pinned commit identity + a `spry.repo` slug make the recordings replay deterministically offline. The `sp sync` "Opening a new PR", "Retargeting stacked PRs", and `--all` doc fragments now show genuine recorded happy paths instead of hand-stubbed or degraded output, and both `sp land` doc fragments (`--through` and the interactive picker) now record/replay real `gh` traffic the same way — land's readiness lookups plus the fast-forward push, with zero `gh pr edit` calls (land verifies, it never retargets). See `tests/fixtures/cassettes/README.md`.
- `sp land` — lands the stack into trunk by fast-forwarding `origin/<trunk>` to the target unit's tip. `sp land --through <id>` lands from the bottom through a group/unit/commit id (whole stack = through the top unit, bottom-only = through the first); bare `sp land` opens a single-select picker. It runs a full `sp sync` first, gates on live PR readiness (failing/pending checks and changes-requested/review-required abort; unresolved review threads prompt), fast-forwards trunk to the target tip without retargeting PR bases, and surfaces "behind trunk" as a fast-forward rejection pointing at `sp rebase`. Never uses the GitHub merge API and never deletes branches (use `sp clean`).
- `sp sync --all` — pushes every tracked stack in one command. Push-only: it never rebases and never opens new PRs (use `sp rebase --all` to restack and `sp sync --open` to publish), and it cannot be combined with `--open`. Each stack's already-published branches are pushed, PRs are retargeted, and the `refs/spry/prs` cache is updated once across all stacks. Branches that no longer exist locally are pruned from the tracking list. Operates entirely via git plumbing, so the working tree and `HEAD` are never moved.
- `sp rebase --all` — rebases all tracked branches onto trunk in one command. Branches are tracked automatically whenever `sp sync`, `sp group`, or `sp rebase` is run. Branches that no longer exist are removed from the tracking list. Tracking metadata is stored locally in `refs/spry/local/tracked-branches` and is never pushed to the remote.
- `sp rebase` — fetches the remote, checks if the stack is behind trunk, predicts conflicts via dry-run, and rebases if clean. Prints conflicting files and exits 1 if a conflict is detected. Separate from `sp sync` — sync is push-only.
- `src/git/behind.ts` — `fetchRemote` and `isStackBehindTrunk` primitives used by `sp rebase`
- PR status cache stored in `refs/spry/prs` — `sp view` now reads PR status instantly from a local git ref written by `sp sync`, with no `gh` API calls needed. Teammates can get PR status via `git fetch` without gh auth.
- `sp sync` writes and pushes `refs/spry/prs` after each run; `sp view` reads from it.
- `src/gh/pr-cache.ts` — `loadPRCache`, `savePRCache`, `fetchPRCache`, `pushPRCache`
- `enrichFromCache` in `src/gh/enrich.ts` — synchronous cache-backed unit enrichment

- `sp group` command — interactive TUI for grouping, renaming, and reordering commits
  - ↑↓ to move cursor, ←→ to assign/remove group membership
  - Space to grab a commit and reorder via ↑↓; live conflict prediction as you drag
  - `r` to rename the group at the cursor (inline edit mode)
  - Groups saved as JSON records in `refs/spry/groups` — no commit rewrites needed for grouping
  - Reordering rewrites the commit chain via plumbing
  - PR adoption: if commits being grouped already have open PRs, group inherits the PR ID automatically (single PR) or prompts for selection (multiple PRs)
  - Pushes `refs/spry/groups` to the remote after saving (best-effort)
- `saveAllGroupRecords` in `src/git/group-titles.ts` — atomic write of all group records
- Integration tests for `sp group` TUI: assign, rename, cancel, and reorder scenarios (`tests/commands/group.test.ts`)
- Doc tests for `sp group` producing generated docs for the Grouping and Reordering sections (`tests/commands/group.doc.test.ts`)
- Generated docs for `sp group` (`docs/generated/commands/group.md`, `docs/generated/commands/group.html`)

### Changed

- `sp sync` and `sp sync --all` now tolerate a dirty working tree. Sync is push-only and no longer performs a real rebase, so local uncommitted changes do not affect the explicit commit SHAs it publishes.
- `sp group` now allows metadata-only grouping and renaming with a dirty working tree, while disabling commit reordering in the TUI until the tree is clean.
- Internal: extracted the gh cassette seam into a shared `createSeamedGhClient` helper (`src/lib/gh-seam.ts`) so the CLI and test harnesses select record/replay/real consistently.
- Group membership now stored in `refs/spry/groups` alongside titles instead of `Spry-Group` commit trailers. Each group record is a JSON blob `{"title":"...","members":["commitId1",...]}`. `parseStack` now accepts an explicit `CommitGroupMap` (Spry-Commit-Id → groupId) instead of reading `Spry-Group` from commit messages, so grouping never requires a commit rewrite.
- `loadGroupTitles`/`saveGroupTitle`/`fetchGroupTitles` replaced by `loadGroupRecords`/`saveGroupRecord`/`fetchGroupRecords` plus `buildCommitGroupMap` and `extractGroupTitles` helpers.
- `sp view` now fetches and loads group records so groups appear correctly (previously group titles were not loaded in view).

### Added

- Group-title storage (`loadGroupTitles` / `saveGroupTitle` / `fetchGroupTitles` in `src/git/group-titles.ts`) persists group titles as a metadata commit tree at `refs/spry/groups`; portable across clones and collaborators
- `sp sync` fetches `refs/spry/groups` from the remote before parsing so group PRs receive their stored titles
- `sp sync --open <group-id>` now works for group units
- `formatPRBody` returns empty string for group units instead of throwing
- Doc-fragment `doc.scrub(repo | pattern, replacement?)` helper so generated docs stay deterministic across test runs (eliminates per-run churn from random repo unique IDs and temp paths)
- GitHub integration module (`src/gh/`) — read-only PR lookup
  - `findPRsForBranches(ctx, branches)` returns `Map<branch, PRInfo | null>` with state, baseRef, checks status, and review decision
  - Per-branch GraphQL queries via `gh api graphql`; auth/install failures surface as typed `GhAuthError` / `GhNotInstalledError` throws
  - `withRetry` helper with exponential backoff (±20% jitter, max 3 attempts) for transient network/5xx failures
- `createRealGhClient` factory promoted from `tests/lib/` to `src/lib/context.ts`; CLI now wires a real gh client into `SpryContext`
- CLI entry point (`src/cli/index.ts`) and `sp view` command (`src/commands/view.ts`)
  - `sp view` orchestrates: load config, get branch, get commits, parse trailers, parse stack, format, output
  - CLI built on Commander with extensible command structure
- `formatStackView` and `formatValidationError` UI formatters (`src/ui/format.ts`) for terminal-friendly stack display
  - Auto-generated sequential letter titles (A, B, C...) for untitled groups
  - Status icon legend (no PR, open, merged, closed)
  - Split-group validation error formatting with remediation steps
- Git operations module (`src/git/`) with explicit config, queries, plumbing, rebase, conflict prediction, and status
  - Explicit `spry.trunk` and `spry.remote` config required (no auto-detection)
  - Git version check (requires 2.40+) at config load
  - Plumbing-based rebase and commit chain rewriting via GitRunner DI
  - Conflict prediction for TUI commit reordering
- `parseCommitTrailers` batch helper to bridge `CommitInfo[]` to `CommitWithTrailers[]` for stack parsing
- Core parsing module (`src/parse/`) with types, trailer parsing, stack detection, commit ID generation, title resolution, identifier resolution, input validation
- `stdin` support for `GitRunner`/`CommandOptions` in test lib
- Doc-producing tests for `sp view` (`tests/commands/view.doc.test.ts`) — first tests that double as the source of user-facing docs
- Doc-fragment disk bridge: `docTest` writes passing fragments to `.test-tmp/doc-fragments/`; `scripts/build-docs.ts` reads them and produces `docs/generated/<section>.md`
- `docs:build` and `docs:clean` npm scripts
- `fragmentPath` helper exported from `tests/lib` for deterministic fragment file paths
- `sp view` now enriches each unit with PR state (◐ open, ✓ merged, ✗ closed),
  PR URL, checks status, review decision, and resolved-comment count on a
  two-line layout. Defaults to enrichment; falls back to local-only with a
  hint when gh is missing, unauthenticated, the repo isn't a GitHub repo, or
  the network is unreachable.
- `sp view --no-fetch` flag for offline/CI use (skips GitHub enrichment).
- `spry.branchPrefix` config (required) — derives PR branch names as
  `<prefix>/<unit-id>`. For legacy parity, set to `spry/<your-username>`.
- `branchForUnit(unit, config)` helper in `src/git/branch.ts`.
- `enrichUnits(ctx, units, config)` orchestrator in `src/gh/enrich.ts` that
  classifies infra failures into `EnrichmentError` (`no-gh` | `auth` |
  `network` | `no-remote`).
- `PRInfo.reviewThreads: { resolved, total }` from extended GraphQL query.
- `sp sync` command — first writer in the rebuild.
  - Bare `sp sync` injects missing `Spry-Commit-Id` trailers, then pushes any
    units whose `<branchPrefix>/<unit-id>` ref already exists on the remote.
    Never creates new remote branches. Force-with-lease semantics. After
    pushing, looks up PRs and retargets any whose base ref doesn't match the
    current local stack order. If gh is unavailable (no-gh / auth /
    no-remote / network), prints a hint and exits cleanly — branches were
    still pushed.
  - `sp sync --open <ids>` (comma-separated, full or prefix-matched unit
    IDs) pushes branches and creates PRs for the selected single-commit
    units. PR title = commit subject; PR body = commit prose with all
    trailers stripped. Each PR is opened with the appropriate base from the
    local stack order. Errors if any target is a group, has no match, has
    multiple matches, or already has a published branch. If a target's push
    fails, dependent targets are skipped to avoid `gh pr create --base
<missing-branch>`.
  - `sp sync --open` (no value) drops into a TUI multi-select listing the
    units that don't yet have remote branches; cancellable with Esc/Ctrl+C.
    Already-published and group units are shown disabled with a hint.
    Cancelling falls through to the retarget phase so push-phase work is
    still reconciled.
  - Partial failures (push or PR-creation errors) cause the command to
    print `⚠ Sync completed with warnings` and exit 1, so CI scripts catch
    them.
- `src/gh/pr-body.ts` — pure `formatPRTitle`, `formatPRBody`, and
  `stripTrailers` helpers. `stripTrailers` removes the entire trailer block
  (Spry-Commit-Id, Co-Authored-By, Signed-off-by, etc.) when preceded by a
  blank line.
- `src/gh/push.ts` — `pushBranch` (force-with-lease, classifies stale-ref
  vs other rejection) and `listRemoteBranches` (returns `Set<string>` for a
  given prefix).
- `src/gh/pr.ts` — `createPR` and `retargetPR` write operations. Both use
  the shared retry predicate; bodies are passed via stdin (`--body-file -`)
  to avoid shell-quoting and arg-length limits.
- `createRealGhClient` extended to forward `stdin` symmetrically with
  `createRealGitRunner`.
- `src/tui/select.ts` — multi-select widget over the Phase 1
  `TerminalDriver`. Handles Space/Enter/Esc/Ctrl+C/'a'/Arrow keys with
  wrap-around. First feature use of the PTY infrastructure. Restores
  terminal state on errors and signals (SIGINT/SIGTERM).
- `src/git/queries.ts` — `getStackCommits`/`getStackCommitsForBranch` now
  use `%b` (body without subject) so `CommitInfo.body` matches the contract
  the rest of the codebase already assumed. `parseCommitTrailers` and
  `injectMissingIds` reconstruct full messages before calling
  `git interpret-trailers --parse`.

### Changed

- Reset codebase for test-first rebuild. Testing infrastructure is now the foundation.
- Removed the in-memory doc-fragment collection API (`collectFragment`, `getDocFragments`, `clearDocFragments`). Disk is now the single source of truth for fragments.

## [1.0.0-beta.5] - 2026-02-24

### Added

- `sp sync --all` to sync all Spry-tracked branches in the repository at once
  - Discovers branches with Spry-Commit-Id trailers
  - Rebases each branch onto the remote default branch without manual checkout
  - Injects missing Spry-Commit-Ids before rebasing
  - Predicts conflicts and skips branches that would fail (never enters failed rebase state)
  - Validates stack structure and skips branches with split groups
  - Handles worktrees: skips dirty ones, updates clean ones after rebase
  - Clear summary showing rebased vs skipped branches with reasons
- Branch-aware core functions: `injectMissingIds()`, `predictRebaseConflicts()`, `rebaseOntoMain()` now accept optional `branch` parameter
- `validateBranchStack()` function to detect split groups on any branch
- `listSpryLocalBranches()` function to discover all Spry-tracked local branches

## [1.0.0-beta.4] - 2026-01-28

### Fixed

- Group titles now display correctly in `sp view` (were showing fallback subjects instead of stored titles)
- Adding commits to an existing group via `sp group` now preserves the group ID, maintaining PR association

## [1.0.0-beta.3] - 2026-01-20

### Added

- Configurable remote name via `spry.remote` config option (no longer hardcoded to 'origin')
- Smart remote auto-detection: uses single remote if only one exists (persists to config), falls back to 'origin' if present among multiple, or prompts user to configure
- `sp sync` now automatically fetches from remote and rebases the current stack onto the remote default branch if behind
- `sp sync` now fast-forwards the local default branch if it's behind the remote (without checking it out)
- `sp sync` now predicts rebase conflicts before rebasing; warns user instead of starting a rebase they'd need to abort

### Changed

- Show progress feedback ("Creating PR for... #number") when opening PRs for the first time
- PR footer now says "beta" instead of "alpha"

### Fixed

- User-facing messages now reference `sp` instead of `spry` for command suggestions
- `sync --open -i` now only pushes branches up to the last commit with a PR, avoiding unnecessary branch pushes for unselected commits

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
- Warning footer in generated PR bodies
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
