import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import {
  docTest,
  createRunner,
  createTerminalDriver,
  isRecording,
  setupDocRepo,
  withGitHubFixture,
} from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";
import { waitForValue } from "../lib/wait-for.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const harnessPath = join(import.meta.dir, "../fixtures/land-tui-harness.ts");
const pollHarnessPath = join(import.meta.dir, "../fixtures/land-poll-harness.ts");
const runSp = createRunner(cliPath);

// Replay never touches GitHub (gh traffic is cassette-served), but it is NOT
// wait-free: order 20's PTY spawn + TUI render run for real in replay too, and
// its declared inner waits are waitForText(15000) + waitForExit(20000) =
// 35000ms — so the replay budget must exceed that ceiling (bun's per-test
// timeout overrides any CLI --timeout, so nothing else rescues it). 60000ms
// covers the 35000ms TUI ceiling with headroom while still surfacing a
// genuine replay hang in a minute instead of inheriting the record-mode
// budgets below. (Order 10's replay body has no TUI and its polls are
// recording-gated, so it finishes in seconds either way.)
const REPLAY_TIMEOUT_MS = 60000;

// waitForChecks' per-call budget (its default `timeoutMs` parameter below).
const WAIT_FOR_CHECKS_TIMEOUT_MS = 240000;

// setupLandStack awaits waitForChecks twice, SEQUENTIALLY (2 * 240000 =
// 480000ms worst case) before either land docTest body even reaches its own
// assertions. That alone exceeds the old flat 300000ms timeout, which is
// Finding A. Both record-mode land docTest bodies below share this floor; the
// canonical test additionally pays the MERGED poll and the
// exclusive-lock/reset overhead (see CANONICAL_RECORD_TIMEOUT_MS).
const SETUP_LAND_STACK_WAIT_MS = 2 * WAIT_FOR_CHECKS_TIMEOUT_MS; // 480000

// "Picking the land point interactively" (order 20) is non-exclusive: it never
// contends the record lock, and it has no MERGED poll. Its worst case is
// setupLandStack's wait plus its own TUI waits (15000 + 20000 = 35000ms):
// SETUP_LAND_STACK_WAIT_MS + 35000 = 515000ms. Round up for headroom.
const NON_EXCLUSIVE_RECORD_TIMEOUT_MS = SETUP_LAND_STACK_WAIT_MS + 35000 + 65000; // 580000

// The MERGED-fidelity poll's own budget (see the waitForValue call below —
// Finding B): 48 attempts * 5000ms cadence, matching waitForChecks's ~240s
// ceiling rather than waitForValue's tiny 10 * 500ms defaults.
const MERGED_POLL_WAIT_MS = 48 * 5000; // 240000

// The canonical land test (order 10, exclusive: true) additionally pays:
//   - MERGED_POLL_WAIT_MS (240000ms, see above)
//   - up to the once-per-process suite-start reset (bounded in practice by the
//     spry-check repo's own residue, not separately budgeted here since it is
//     shared/memoized across the whole record run and typically far smaller
//     than the CI waits above)
//   - the record-lock ACQUIRE wait: withRecordLock's default acquire timeout
//     is 15 minutes (900000ms, see tests/lib/record-lock.ts) — this test is
//     one of only two lock contenders (itself and the suite-start reset), so
//     acquisition is normally near-instant, but the budget must not assume
//     that under a slow CI queue.
// Worst-case sum: SETUP_LAND_STACK_WAIT_MS (480000) + MERGED_POLL_WAIT_MS
// (240000) + lock-acquire (900000) = 1620000ms. 1500000ms undercuts that by
// design: the lock-acquire figure is itself a conservative ceiling
// (contention is normally near-zero with only one other holder), so
// 1500000ms (25 minutes) is sized to comfortably absorb the two CI-wait terms
// in full (720000ms) plus substantial real lock contention, without
// inheriting the full pathological 900000ms on top of everything else.
const CANONICAL_RECORD_TIMEOUT_MS = SETUP_LAND_STACK_WAIT_MS + MERGED_POLL_WAIT_MS + 780000; // 1500000

// How long the [SLOW_CI_<n>] marker holds a check registered-and-pending, in
// seconds. Long enough that GitHub reliably registers the check as pending
// before it completes (registration latency is typically <10s), short enough
// that the record-mode wait doesn't drag: at 20s the nudge (order 30) catches
// a pending rollup on its first or second 5s waitForRegisteredPending poll, and
// the wait-loop (order 40) sees ~2-3 pending polls before green. The deployed
// spry-check workflow reads this number from the commit-subject marker.
const SLOW_CI_SECONDS = 20;

// The bare-land CI-pending nudge (order 30) no longer races land's first query
// against real CI turnaround (see the order-30 body comment): it marks its
// stack commits [SLOW_CI_<n>] and explicitly waits, for EACH of the two branches
// SEQUENTIALLY, until that branch's rollup is registered-and-pending, before
// invoking `sp land` once. Budget for two full waitForRegisteredPending calls
// at their worst case (2 * WAIT_FOR_CHECKS_TIMEOUT_MS = 480000ms) plus
// generous headroom for PR creation, the land invocation itself, and gh
// latency. (The [SLOW_CI] window itself is only SLOW_CI_SECONDS; the large
// budget covers the poll ceiling, not the expected time.)
const NUDGE_RECORD_TIMEOUT_MS = 2 * WAIT_FOR_CHECKS_TIMEOUT_MS + 60000; // 540000

// Real interval (seconds) the --poll wait-loop doc test uses in RECORD mode,
// passed via SPRY_POLL_INTERVAL. Short enough that the SLOW_CI_SECONDS window
// yields a few distinct pending polls before green, long enough to give CI real
// time to move between polls so each records a genuinely distinct rollup.
const POLL_WAIT_LOOP_RECORD_INTERVAL_SECONDS = 8;

// The --poll wait-loop doc test (order 40) never calls setupLandStack's CI
// wait either — it opens the PRs and immediately spawns the polling harness,
// which itself polls (in record mode) on POLL_WAIT_LOOP_RECORD_INTERVAL_SECONDS
// until CI passes. Order 40 also marks its stack commits [SLOW_CI_<n>] (like
// order 30) so the deployed workflow reliably stays pending for SLOW_CI_SECONDS,
// giving the harness several real pending polls before CI flips green instead of
// possibly finishing before the first poll. Budget generously: the SLOW_CI
// sleep, plus margin for the green-confirmation poll and harness spawn/exit
// overhead, still well inside WAIT_FOR_CHECKS_TIMEOUT_MS's own ceiling.
const POLL_WAIT_LOOP_RECORD_TIMEOUT_MS = WAIT_FOR_CHECKS_TIMEOUT_MS + 60000; // 300000

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

/**
 * Build a 2-unit stack on `feature/x` and publish both spry branches to the
 * origin (the spry config is already pinned by `setupDocRepo`). In record
 * mode, open each PR already-stacked (bottom→trunk, upper→the bottom unit's
 * branch), matching a synced stack, and — unless `waitForGreen: false` —
 * wait for CI to pass, since land's readiness gate refuses PRs with pending
 * checks or mis-targeted bases. Because setup never changes a PR base after
 * CI starts, there is no pending-CI re-trigger race. The repo's per-run seeded
 * commit dates make each run's SHAs unique, so GitHub never accumulates
 * historical check runs on a reused SHA — every PR gets a clean, single-run
 * rollup.
 *
 * `waitForGreen: false` (record mode only) skips the wait entirely, opening
 * the PRs and returning immediately so the caller observes CI mid-flight —
 * this is exactly what the `--poll` nudge and wait-loop doc tests need: a
 * genuinely pending rollup to record against.
 *
 * `slowCI: true` appends a `[SLOW_CI_<SLOW_CI_SECONDS>]` marker to both commit
 * subjects (ids and trailers are unaffected), which the deployed spry-check CI
 * workflow recognizes and sleeps that many seconds on before completing —
 * keeping the rollup registered-and-pending for a reliable window instead of
 * racing real CI turnaround. Callers that need a deterministic pending-CI
 * observation (the `--poll` nudge and wait-loop doc tests) should combine this
 * with `waitForGreen: false` and their own explicit pending-wait.
 */
async function setupLandStack(
  repo: TestRepo,
  opts: {
    recording: boolean;
    trunkName: string;
    branchPrefix: string;
    /** Default true. Set false to open PRs and return without waiting for CI. */
    waitForGreen?: boolean;
    /** Default false. Set true to mark both commits `[SLOW_CI_<SLOW_CI_SECONDS>]` so the deployed spry-check workflow sleeps that many seconds before completing. */
    slowCI?: boolean;
  },
): Promise<void> {
  const { recording, trunkName, branchPrefix, waitForGreen = true, slowCI = false } = opts;
  await repo.git.run(["checkout", "-b", "feature/x"]);
  for (const [subject, id] of [
    ["Add login", "aaa11111"],
    ["Add logout", "bbb22222"],
  ] as const) {
    const fullSubject = slowCI ? `${subject} [SLOW_CI_${SLOW_CI_SECONDS}]` : subject;
    await repo.git.run([
      "commit",
      "--allow-empty",
      "-m",
      `${fullSubject}\n\nSpry-Commit-Id: ${id}`,
    ]);
    const head = (await repo.git.run(["rev-parse", "HEAD"])).stdout.trim();
    await repo.git.run(["push", "origin", `${head}:refs/heads/${branchPrefix}/${id}`]);
  }

  if (recording) {
    const { $ } = await import("bun");
    await $`gh pr create --title ${"Add login"} --head ${`${branchPrefix}/aaa11111`} --base ${trunkName} --body ${"Login"}`
      .cwd(repo.path)
      .quiet();
    await $`gh pr create --title ${"Add logout"} --head ${`${branchPrefix}/bbb22222`} --base ${`${branchPrefix}/aaa11111`} --body ${"Logout"}`
      .cwd(repo.path)
      .quiet();
    if (waitForGreen) {
      await waitForChecks(repo.path, `${branchPrefix}/aaa11111`);
      await waitForChecks(repo.path, `${branchPrefix}/bbb22222`);
    }
  }
}

/**
 * Record-mode only: poll until the PR for `branch` has at least one check that
 * has completed successfully, and none pending or failing.
 *
 * We must NOT use `gh pr checks`' exit code: it exits 0 *before the workflow
 * registers any check* (zero checks reads as success), so a naive wait can
 * return during the window between opening the PR and CI starting — leaving
 * land to observe a `pending` rollup moments later. Instead poll the same
 * `statusCheckRollup` signal `sp land` reads, and require a NON-EMPTY, fully
 * green rollup before returning.
 */
async function waitForChecks(
  cwd: string,
  branch: string,
  timeoutMs = WAIT_FOR_CHECKS_TIMEOUT_MS,
): Promise<void> {
  const { $ } = await import("bun");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await $`gh pr view ${branch} --json statusCheckRollup`.cwd(cwd).nothrow().quiet();
    if (res.exitCode === 0) {
      try {
        const parsed = JSON.parse(res.stdout.toString()) as {
          statusCheckRollup?: Array<{ status?: string; conclusion?: string | null }>;
        };
        const rollup = parsed.statusCheckRollup ?? [];
        const allComplete = rollup.every((c) => c.status === "COMPLETED");
        const allPass = rollup.every(
          (c) => c.conclusion === "SUCCESS" || c.conclusion === "SKIPPED",
        );
        // Require at least one check so we don't return before CI registers.
        if (rollup.length > 0 && allComplete && allPass) return;
      } catch {
        // fall through and retry on malformed output
      }
    }
    await Bun.sleep(5000);
  }
  throw new Error(`CI checks did not pass for ${branch} within ${timeoutMs}ms`);
}

/**
 * Record-mode only: poll until the PR for `branch` has a REGISTERED rollup
 * (non-empty) that is still PENDING — at least one check not yet COMPLETED,
 * and none failed. This is the mirror image of `waitForChecks`: instead of
 * waiting for CI to finish, we need to catch it registered and still running,
 * so that invoking `sp land` immediately afterward reliably observes land's
 * readiness gate seeing `pending` (not "none") and prints the nudge.
 *
 * The gap this closes: right after `gh pr create`, GitHub has not yet
 * registered any check run — `statusCheckRollup` reads `null`/empty, which
 * land's readiness gate treats as "no blocker" (checksStatus "none"), not
 * "pending". Invoking land during that pre-registration window would land the
 * stack instead of nudging. Combined with `slowCI` stack commits (which make
 * the deployed workflow sleep SLOW_CI_SECONDS before completing), waiting here
 * for a non-empty-but-incomplete rollup gives a reliable window in which to
 * invoke `sp land` and deterministically observe the nudge.
 */
async function waitForRegisteredPending(
  cwd: string,
  branch: string,
  timeoutMs = WAIT_FOR_CHECKS_TIMEOUT_MS,
): Promise<void> {
  const { $ } = await import("bun");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await $`gh pr view ${branch} --json statusCheckRollup`.cwd(cwd).nothrow().quiet();
    if (res.exitCode === 0) {
      try {
        const parsed = JSON.parse(res.stdout.toString()) as {
          statusCheckRollup?: Array<{ status?: string; conclusion?: string | null }>;
        };
        const rollup = parsed.statusCheckRollup ?? [];
        const anyIncomplete = rollup.some((c) => c.status !== "COMPLETED");
        const anyFailed = rollup.some(
          (c) =>
            c.conclusion === "FAILURE" ||
            c.conclusion === "TIMED_OUT" ||
            c.conclusion === "CANCELLED",
        );
        if (rollup.length > 0 && anyIncomplete && !anyFailed) return;
      } catch {
        // fall through and retry on malformed output
      }
    }
    await Bun.sleep(5000);
  }
  throw new Error(
    `CI checks did not reach registered-and-pending for ${branch} within ${timeoutMs}ms`,
  );
}

describe("sp land docs", () => {
  docTest(
    "Landing through a commit",
    {
      section: "commands/land",
      order: 10,
      timeout: isRecording() ? CANONICAL_RECORD_TIMEOUT_MS : REPLAY_TIMEOUT_MS,
    },
    async (doc) => {
      // THE CANONICAL LAND TEST. It lands on the repo's REAL default branch
      // (trunk: "default-branch") and, in record mode, runs exclusively (record
      // lock + main restored to baseline afterward). It is the one standing
      // validation that `sp land`'s bare ff-push — no merge API, no retarget —
      // really flips the trunk-based PR to MERGED on the true default branch,
      // exactly as in a real repo (the property the land redesign rests on;
      // see docs/rebuild-roadmap.md, refined by beads spry-tm2l). Every other
      // fixture test lands/pushes in its own per-test trunk namespace and
      // records lock-free in parallel.
      //
      // Record mode publishes two real already-stacked PRs on spry-check and
      // captures land's gh traffic — pure readiness lookups (PR state + checks),
      // no `gh pr edit`: land verifies and fast-forwards, it never retargets.
      // Replay serves it offline. Same body both ways — only the git origin and
      // the gh seam env differ.
      const recording = isRecording();
      await withGitHubFixture({ recording, exclusive: true }, async (fixture) => {
        const { repo, env, trunkName, branchPrefix } = await setupDocRepo(doc, {
          recording,
          fixtureOwner: fixture?.owner,
          fixtureRepo: fixture?.repo,
          section: "commands/land",
          order: 10,
          trunk: "default-branch",
        });
        repos.push(repo);

        await setupLandStack(repo, { recording, trunkName, branchPrefix });
        const tip = (await repo.git.run(["rev-parse", "HEAD"])).stdout.trim();

        doc.prose(
          "`sp land --through <id>` lands the stack from the bottom **through** the unit identified by `<id>` (a group ID, unit-ID prefix, or commit-hash prefix). Spry fast-forwards trunk to that unit's tip — it never uses the GitHub merge API and never retargets PR bases. GitHub marks each PR `MERGED` because its commits become reachable from the default branch; leaving each PR on its stacked base keeps that PR's diff scoped to just its own unit. `sp land` never deletes branches (that is `sp clean`'s job):",
        );

        const { command, result } = await runSp(repo.path, "land", ["--through", "bbb22222"], {
          env,
        });
        doc.command(command);
        doc.output(result.stdout);

        const { expect } = await import("bun:test");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Landed");
        const originMain = (await repo.git.run(["rev-parse", `origin/${trunkName}`])).stdout.trim();
        expect(originMain).toBe(tip);

        // Real-GitHub MERGED fidelity check: after the ff-push (no merge API,
        // no retarget), GitHub must mark the trunk-based bottom PR MERGED.
        // Poll: the merged flip is applied asynchronously after the push.
        //
        // Deliberately the BOTTOM PR only. Observed live (2026-07-13, beads
        // spry-tm2l): GitHub flips a PR to MERGED when a push to its BASE
        // branch makes the head reachable from that base — the upper stacked
        // PR (based on the bottom unit's spry branch, which land never pushes)
        // stays OPEN immediately after a land, even though its commits are
        // reachable from the default branch. (This refines the roadmap's
        // "reachability from the default branch" phrasing; the ff-push alone
        // still suffices for every PR whose base is the pushed trunk.)
        if (recording) {
          const { $ } = await import("bun");
          const state = await waitForValue(
            async () => {
              const res = await $`gh pr view ${`${branchPrefix}/aaa11111`} --json state --jq .state`
                .cwd(repo.path)
                .nothrow()
                .quiet();
              return res.stdout.toString().trim();
            },
            (s) => s === "MERGED",
            {
              description: `PR for ${branchPrefix}/aaa11111 to be marked MERGED`,
              // Same cadence as waitForChecks: this is the same class of
              // GitHub-eventual-consistency wait (the MERGED flip applies
              // asynchronously after the ff-push), so it gets the same
              // interval and the same ~240s ceiling (48 * 5000ms) rather than
              // waitForValue's tiny 10 * 500ms defaults.
              intervalMs: 5000,
              attempts: 48,
            },
          );
          expect(state).toBe("MERGED");
        }
      });
    },
  );

  docTest(
    "Picking the land point interactively",
    {
      section: "commands/land",
      order: 20,
      timeout: isRecording() ? NON_EXCLUSIVE_RECORD_TIMEOUT_MS : REPLAY_TIMEOUT_MS,
    },
    async (doc) => {
      // Non-canonical land test: it lands onto its own per-test trunk
      // (trunk/commands__land--020), so in record mode it runs lock-free in parallel with
      // the other fixture tests. FIDELITY CAVEAT: this is a side-branch trunk,
      // not the repo's default branch, so it is deliberately NOT the standing
      // validation of real-world land behavior — that's the canonical test
      // above. (Land's recorded gh traffic is all pre-push readiness lookups,
      // identical in shape either way; observed live, GitHub even flips the
      // trunk-based PR to MERGED on a side-branch trunk push — beads spry-tm2l.)
      const recording = isRecording();
      await withGitHubFixture({ recording }, async (fixture) => {
        const { repo, env, trunkName, branchPrefix } = await setupDocRepo(doc, {
          recording,
          fixtureOwner: fixture?.owner,
          fixtureRepo: fixture?.repo,
          section: "commands/land",
          order: 20,
        });
        repos.push(repo);

        await setupLandStack(repo, { recording, trunkName, branchPrefix });

        doc.prose(
          "Run `sp land` with no arguments to choose the land point interactively. Spry shows a single-select menu of the stack's units (bottom→top) — use ↑/↓ to move, Enter to select. The chosen unit becomes the `--through` target:",
        );
        doc.command("sp land");

        // Spawn the harness in a real PTY. The gh seam (cassette env) records/replays
        // the land traffic; the TUI picker runs for real.
        const driver = await createTerminalDriver("bun", [harnessPath, repo.path], {
          cols: 80,
          rows: 24,
          env,
        });
        repos.push({ cleanup: () => driver.close() });

        // Wait for the picker to render (labels are "<id>  <subject>").
        await driver.waitForText("Add login", { timeout: 15000 });

        // Capture the menu before any selection.
        doc.screen(driver.capture());

        // Select the cursor row (the bottom unit) and land it.
        driver.press("Enter");

        // Wait for the harness process to exit rather than the "Landed"
        // sentinel + close(): land-tui-harness exits right after landCommand
        // resolves and flush() runs, so waiting for exit avoids racing any
        // trailing work with a hard kill (see
        // docs/investigations/2026-07-07-group-reflog-nondeterminism.md).
        const { expect } = await import("bun:test");
        expect(await driver.waitForExit({ timeout: 20000 })).toBe(0);

        const snap = driver.capture();
        expect(snap.text).toContain("Landed");
      });
    },
  );

  docTest(
    "Bare land nudges toward --poll when CI is still running",
    {
      section: "commands/land",
      order: 30,
      timeout: isRecording() ? NUDGE_RECORD_TIMEOUT_MS : REPLAY_TIMEOUT_MS,
    },
    async (doc) => {
      // Non-canonical, non-exclusive: lands onto its own per-test trunk (like
      // order 20), so it runs lock-free in parallel with the other fixture
      // tests. The whole point of this test is to observe CI MID-FLIGHT.
      // `runSp` (not the TUI harness) is used so the binary's real non-TTY
      // stdin path fires: under a non-interactive shell, land can't prompt to
      // poll, so it prints the reinvoke hint and exits 1 instead.
      //
      // DETERMINISTIC by construction, no timing race: setupLandStack marks
      // both stack commits `[SLOW_CI_<n>]` (slowCI: true), which the deployed
      // spry-check workflow recognizes and sleeps SLOW_CI_SECONDS on before
      // completing — so CI stays registered-and-pending for a reliable window instead
      // of racing real CI turnaround. We explicitly wait (waitForGreen: false,
      // then waitForRegisteredPending for each branch) until both PRs' rollups
      // are registered-and-pending before invoking `sp land` once, so land's
      // readiness gate reliably observes `pending` (not the pre-registration
      // "none") and prints the nudge. Land's scope is `--through bbb22222`,
      // which covers BOTH units, and readiness gates on ALL in-scope PRs — so
      // we wait for both branches, not just the top one.
      const recording = isRecording();
      await withGitHubFixture({ recording }, async (fixture) => {
        const { repo, env, trunkName, branchPrefix } = await setupDocRepo(doc, {
          recording,
          fixtureOwner: fixture?.owner,
          fixtureRepo: fixture?.repo,
          section: "commands/land",
          order: 30,
        });
        repos.push(repo);

        await setupLandStack(repo, {
          recording,
          trunkName,
          branchPrefix,
          waitForGreen: false,
          slowCI: true,
        });

        if (recording) {
          await waitForRegisteredPending(repo.path, `${branchPrefix}/aaa11111`);
          await waitForRegisteredPending(repo.path, `${branchPrefix}/bbb22222`);
        }

        doc.prose(
          "If CI is still running, a non-interactive `sp land` (no TTY — e.g. in a script or CI job) can't prompt to wait, so it prints a ready-to-copy re-invoke command and exits non-zero instead of blocking:",
        );

        const { command, result } = await runSp(repo.path, "land", ["--through", "bbb22222"], {
          env,
        });
        doc.command(command);
        doc.output(result.stdout + result.stderr);

        const { expect } = await import("bun:test");
        // The nudge path is EXPECTED to exit non-zero — that is the documented
        // behavior (land refuses to guess in a non-interactive shell). Assert
        // the exit code explicitly rather than treating any non-zero exit as a
        // pass, so a different failure mode doesn't masquerade as the nudge.
        expect(result.exitCode).toBe(1);
        const combined = result.stdout + result.stderr;
        expect(combined).toContain("sp land --through");
        expect(combined).toContain("--poll");
      });
    },
  );

  docTest(
    "sp land --poll waits for CI, then lands",
    {
      section: "commands/land",
      order: 40,
      timeout: isRecording() ? POLL_WAIT_LOOP_RECORD_TIMEOUT_MS : REPLAY_TIMEOUT_MS,
    },
    async (doc) => {
      // Non-canonical, non-exclusive: like order 20/30, this lands onto its
      // own per-test trunk, not the repo's real default branch — so it never
      // contends the exclusive record lock and runs in parallel with the rest
      // of the fixture tests.
      //
      // setupLandStack skips the CI wait (waitForGreen: false) so the PRs'
      // real rollup is still `pending` when the harness is spawned. It also
      // marks both stack commits `[SLOW_CI_<n>]` (slowCI: true), like order 30, so
      // the deployed spry-check workflow sleeps SLOW_CI_SECONDS before completing —
      // this keeps CI reliably pending across SEVERAL polls (poll interval is
      // POLL_WAIT_LOOP_RECORD_INTERVAL_SECONDS = 8s in record mode, so a
      // SLOW_CI_SECONDS window yields a few "still pending" polls) instead of
      // risking CI finishing in one poll or before the first. In record mode
      // the harness polls on that real interval so CI has time to go green
      // between polls — each poll is a genuinely distinct `gh` call, recorded
      // in sequence (pending, ..., passing). In replay those same calls are
      // served back from the cassette in the same order with no real sleeping
      // (the harness makes `sleep` a no-op in replay), so the wait loop
      // reproduces deterministically offline with the exact same number of
      // "still pending" iterations recorded live. (Unlike order 30's former
      // race — now also removed — this test polls until CI passes rather than
      // racing land's first query against it, so a re-record here is expected
      // to be fully deterministic.)
      const recording = isRecording();
      await withGitHubFixture({ recording }, async (fixture) => {
        const { repo, env, trunkName, branchPrefix } = await setupDocRepo(doc, {
          recording,
          fixtureOwner: fixture?.owner,
          fixtureRepo: fixture?.repo,
          section: "commands/land",
          order: 40,
        });
        repos.push(repo);

        await setupLandStack(repo, {
          recording,
          trunkName,
          branchPrefix,
          waitForGreen: false,
          slowCI: true,
        });

        doc.prose(
          "Pass `--poll` to wait for CI instead of nudging: `sp land` re-checks on a cadence (30s by default; `--interval <seconds>` to change it) and lands automatically the moment every in-scope PR is green:",
        );
        doc.command("sp land --through bbb22222 --poll");

        const pollEnv = {
          ...env,
          // Same interval value in BOTH modes so the captured banner reads a
          // sensible "polling every 8s…" in the generated doc rather than
          // "every 0s". The value only feeds the banner TEXT and the record-mode
          // spacing between real polls; the harness gates its actual sleep on
          // isRecording() (not on this number), so replay still never waits.
          SPRY_POLL_INTERVAL: String(POLL_WAIT_LOOP_RECORD_INTERVAL_SECONDS),
        };

        const driver = await createTerminalDriver("bun", [pollHarnessPath, repo.path, "bbb22222"], {
          cols: 80,
          rows: 24,
          env: pollEnv,
        });
        repos.push({ cleanup: () => driver.close() });

        const { expect } = await import("bun:test");
        // Wait for the harness process to exit rather than for a "Landed"
        // sentinel + close(): mirrors order 20's rationale (see
        // docs/investigations/2026-07-07-group-reflog-nondeterminism.md) —
        // waiting for exit avoids racing trailing cleanup work with a hard
        // kill of the pty.
        expect(await driver.waitForExit({ timeout: WAIT_FOR_CHECKS_TIMEOUT_MS })).toBe(0);

        const snap = driver.capture();
        // Capture only the STABLE head (the pending banner) and tail ("✓
        // Landed") lines, not the full variable middle: the number of
        // "…still pending" lines depends on exactly how many polls elapsed
        // before CI went green, and while replay reproduces record's exact
        // recorded sequence (so the count IS deterministic run-to-run), pinning
        // the doc capture to the count as well would make the generated docs
        // fragile to any future re-recording where CI happens to flip on a
        // different poll. The banner + final line are what's worth documenting
        // anyway.
        const lines = snap.text.split("\n");
        const bannerLine = lines.find((l) => l.includes("CI pending on"));
        const landedLine = lines.find((l) => l.includes("Landed"));
        expect(bannerLine).toBeDefined();
        expect(landedLine).toBeDefined();
        doc.output(`${bannerLine}\n  …\n${landedLine}\n`);

        expect(snap.text).toContain("Landed");
      });
    },
  );
});
