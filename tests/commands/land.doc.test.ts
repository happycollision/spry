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
 * branch), matching a synced stack, and wait for CI to pass — land's readiness
 * gate refuses PRs with pending checks or mis-targeted bases. Because setup
 * never changes a PR base after CI starts, there is no pending-CI re-trigger
 * race. The repo's per-run seeded commit dates make each run's SHAs unique, so
 * GitHub never accumulates historical check runs on a reused SHA — every PR
 * gets a clean, single-run rollup.
 */
async function setupLandStack(
  repo: TestRepo,
  opts: { recording: boolean; trunkName: string; branchPrefix: string },
): Promise<void> {
  const { recording, trunkName, branchPrefix } = opts;
  await repo.git.run(["checkout", "-b", "feature/x"]);
  for (const [subject, id] of [
    ["Add login", "aaa11111"],
    ["Add logout", "bbb22222"],
  ] as const) {
    await repo.git.run(["commit", "--allow-empty", "-m", `${subject}\n\nSpry-Commit-Id: ${id}`]);
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
    await waitForChecks(repo.path, `${branchPrefix}/aaa11111`);
    await waitForChecks(repo.path, `${branchPrefix}/bbb22222`);
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
});
