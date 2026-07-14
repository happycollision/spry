import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import {
  docTest,
  createRunner,
  createRepo,
  createTerminalDriver,
  cassetteEnv,
  isRecording,
  withGitHubFixture,
} from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const harnessPath = join(import.meta.dir, "../fixtures/land-tui-harness.ts");
const runSp = createRunner(cliPath);

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

function repoSlug(): string {
  return `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`;
}

/**
 * Build a 2-unit stack on `feature/x` and publish both spry branches to the
 * origin. In record mode, open each PR already-stacked (bottom→`main`,
 * upper→the bottom unit's branch), matching a synced stack, and wait for CI to
 * pass — land's readiness gate refuses PRs with pending checks or mis-targeted
 * bases. Because setup never changes a PR base after CI starts, there is no
 * pending-CI re-trigger race. The repo's per-run seeded commit dates make each
 * run's SHAs unique, so GitHub never accumulates historical check runs on a
 * reused SHA — every PR gets a clean, single-run rollup.
 */
async function setupLandStack(repo: TestRepo, recording: boolean): Promise<void> {
  await repo.git.run(["config", "spry.trunk", "main"]);
  await repo.git.run(["config", "spry.remote", "origin"]);
  await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
  // gh needs explicit owner/repo for its GraphQL query; in replay the origin is
  // a local bare repo, so pin the slug to whatever the cassette was recorded
  // against (defaults to the maintainer's spry-check).
  await repo.git.run(["config", "spry.repo", repoSlug()]);

  await repo.git.run(["checkout", "-b", "feature/x"]);
  for (const [subject, id] of [
    ["Add login", "aaa11111"],
    ["Add logout", "bbb22222"],
  ] as const) {
    await repo.git.run(["commit", "--allow-empty", "-m", `${subject}\n\nSpry-Commit-Id: ${id}`]);
    const head = (await repo.git.run(["rev-parse", "HEAD"])).stdout.trim();
    await repo.git.run(["push", "origin", `${head}:refs/heads/spry/dondenton/${id}`]);
  }

  if (recording) {
    const { $ } = await import("bun");
    await $`gh pr create --title ${"Add login"} --head spry/dondenton/aaa11111 --base main --body ${"Login"}`
      .cwd(repo.path)
      .quiet();
    await $`gh pr create --title ${"Add logout"} --head spry/dondenton/bbb22222 --base spry/dondenton/aaa11111 --body ${"Logout"}`
      .cwd(repo.path)
      .quiet();
    await waitForChecks(repo.path, "spry/dondenton/aaa11111");
    await waitForChecks(repo.path, "spry/dondenton/bbb22222");
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
async function waitForChecks(cwd: string, branch: string, timeoutMs = 240000): Promise<void> {
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
    { section: "commands/land", order: 10, timeout: 300000 },
    async (doc) => {
      // Record mode publishes two real already-stacked PRs on spry-check and
      // captures land's gh traffic — pure readiness lookups (PR state + checks),
      // no `gh pr edit`: land verifies and fast-forwards, it never retargets.
      // Replay serves it offline. Same body both ways — only the git origin and
      // the gh seam env differ.
      const recording = isRecording();
      await withGitHubFixture({ recording }, async () => {
        const repo = await createRepo({ origin: recording ? "github" : "local" });
        repos.push(repo);
        doc.scrub(repo);
        doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");

        await setupLandStack(repo, recording);
        const tip = (await repo.git.run(["rev-parse", "HEAD"])).stdout.trim();

        doc.prose(
          "`sp land --through <id>` lands the stack from the bottom **through** the unit identified by `<id>` (a group ID, unit-ID prefix, or commit-hash prefix). Spry fast-forwards trunk to that unit's tip — it never uses the GitHub merge API and never retargets PR bases. GitHub marks each PR `MERGED` because its commits become reachable from the default branch; leaving each PR on its stacked base keeps that PR's diff scoped to just its own unit. `sp land` never deletes branches (that is `sp clean`'s job):",
        );

        const { command, result } = await runSp(repo.path, "land", ["--through", "bbb22222"], {
          env: cassetteEnv({ section: "commands/land", order: 10 }),
        });
        doc.command(command);
        doc.output(result.stdout);

        const { expect } = await import("bun:test");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Landed");
        const originMain = (await repo.git.run(["rev-parse", "origin/main"])).stdout.trim();
        expect(originMain).toBe(tip);
      });
    },
  );

  docTest(
    "Picking the land point interactively",
    { section: "commands/land", order: 20, timeout: 300000 },
    async (doc) => {
      const recording = isRecording();
      await withGitHubFixture({ recording }, async () => {
        const repo = await createRepo({ origin: recording ? "github" : "local" });
        repos.push(repo);
        doc.scrub(repo);
        doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");

        await setupLandStack(repo, recording);

        doc.prose(
          "Run `sp land` with no arguments to choose the land point interactively. Spry shows a single-select menu of the stack's units (bottom→top) — use ↑/↓ to move, Enter to select. The chosen unit becomes the `--through` target:",
        );
        doc.command("sp land");

        // Spawn the harness in a real PTY. The gh seam (cassetteEnv) records/replays
        // the land traffic; the TUI picker runs for real.
        const driver = await createTerminalDriver("bun", [harnessPath, repo.path], {
          cols: 80,
          rows: 24,
          env: cassetteEnv({ section: "commands/land", order: 20 }),
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
        await driver.waitForExit({ timeout: 20000 });

        const { expect } = await import("bun:test");
        const snap = driver.capture();
        expect(snap.text).toContain("Landed");
      });
    },
  );
});
