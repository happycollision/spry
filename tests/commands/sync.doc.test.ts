import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import {
  docTest,
  createRunner,
  createRepo,
  createRealGitRunner,
  createTerminalDriver,
  cassetteEnv,
  isRecording,
} from "../lib/index.ts";
import { createGitHubFixture } from "../lib/github-fixture.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const harnessPath = join(import.meta.dir, "../fixtures/sync-tui-harness.ts");
const runSp = createRunner(cliPath);

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

describe("sp sync docs", () => {
  docTest("Pushing existing branches", { section: "commands/sync", order: 10 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Pre-publish the branch
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${head}:refs/heads/spry/dondenton/aaa11111`], {
      cwd: repo.path,
    });

    doc.prose(
      "Run `sp sync` to push your stack's commits to their already-published remote branches. Spry derives each branch as `<spry.branchPrefix>/<unit-id>` and only pushes branches that already exist on the remote — it never creates new ones. Use `sp sync --open` to publish for the first time.",
    );

    // Canonicalize the gh-unavailable hint so fragments stay deterministic
    doc.scrub(/PR retargeting unavailable: [^\n]+/, "PR retargeting unavailable: <hint>");

    const { command, result } = await runSp(repo.path, "sync");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pushed spry/dondenton/aaa11111");
  });

  docTest(
    "Opening a new PR",
    { section: "commands/sync", order: 20, timeout: 60000 },
    async (doc) => {
      // Record mode drives the real spry-check repo and captures genuine gh
      // responses into the committed cassette; replay (default) serves them
      // offline. The same body runs both ways — only the git origin and the
      // gh seam env differ. See docs/plans/2026-06-13-gh-cassettes-real-recording.md.
      const recording = isRecording();
      const fixture = recording ? await createGitHubFixture() : undefined;
      if (fixture) await fixture.reset();

      const repo = await createRepo({ origin: recording ? "github" : "local" });
      repos.push(repo);
      doc.scrub(repo);
      // Neutralize the real test-repo slug in generated docs.
      doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");

      // Deterministic commits (repo.git pins identity/date) so the branch SHA is
      // byte-identical between the recording run and every offline replay.
      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
      // gh needs explicit owner/repo for its GraphQL query. In replay the origin
      // is a local bare repo, so pin the slug to whatever the committed cassette
      // was recorded against (defaults to the maintainer's spry-check).
      const repoSlug = `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`;
      await repo.git.run(["config", "spry.repo", repoSlug]);
      await repo.git.run(["checkout", "-b", "feature/x"]);
      await repo.git.run([
        "commit",
        "--allow-empty",
        "-m",
        "Add login\n\nSpry-Commit-Id: aaa11111",
      ]);

      doc.prose(
        "Use `sp sync --open <id>` to publish a commit for the first time — Spry pushes the branch and opens a PR on GitHub targeting trunk (or the previous unit's branch for a stacked PR):",
      );

      const { command, result } = await runSp(repo.path, "sync", ["--open", "aaa11111"], {
        env: cassetteEnv({ section: "commands/sync", order: 20 }),
      });
      doc.command(command);
      doc.output(result.stdout);

      // Tidy up the real PR/branch we just created on spry-check.
      if (fixture) await fixture.reset();

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created PR #");
      expect(result.stdout).toContain("Sync complete");
    },
  );

  docTest("Auto-injecting commit IDs", { section: "commands/sync", order: 40 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    // No Spry-Commit-Id trailer — sync will inject one automatically
    await git.run(["commit", "--allow-empty", "-m", "Add login"], { cwd: repo.path });

    doc.prose(
      "If a commit lacks a `Spry-Commit-Id` trailer, `sp sync` rewrites it with one before doing anything else. This happens automatically on first use:",
    );

    // No remote branches exist, so no gh calls are made — use the CLI runner directly
    const { command, result } = await runSp(repo.path, "sync");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Injected 1 commit ID");
    expect(result.stdout).toContain("Sync complete");
  });

  docTest(
    "Retargeting stacked PRs",
    { section: "commands/sync", order: 50, timeout: 60000 },
    async (doc) => {
      // Record mode publishes two real stacked PRs on spry-check (with bbb22222
      // deliberately mis-based on main) and captures sync's retarget traffic;
      // replay serves it offline. Same body both ways.
      const recording = isRecording();
      const fixture = recording ? await createGitHubFixture() : undefined;
      if (fixture) await fixture.reset();

      const repo = await createRepo({ origin: recording ? "github" : "local" });
      repos.push(repo);
      doc.scrub(repo);
      doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");

      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
      const repoSlug = `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`;
      await repo.git.run(["config", "spry.repo", repoSlug]);

      await repo.git.run(["checkout", "-b", "feature/x"]);
      await repo.git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"]);
      await repo.git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"]);

      // Pre-publish both branches (sync only pushes branches that already exist
      // on the remote).
      const aSha = (await repo.git.run(["rev-parse", "HEAD~1"])).stdout.trim();
      const bSha = (await repo.git.run(["rev-parse", "HEAD"])).stdout.trim();
      await repo.git.run(["push", "origin", `${aSha}:refs/heads/spry/dondenton/aaa11111`]);
      await repo.git.run(["push", "origin", `${bSha}:refs/heads/spry/dondenton/bbb22222`]);

      // In record mode, open the two real PRs. bbb22222 gets the WRONG base
      // (main) so sync has a PR to retarget onto aaa11111's branch.
      if (recording) {
        const { $ } = await import("bun");
        await $`gh pr create --title A --head spry/dondenton/aaa11111 --base main --body ${"Stacked PR A"}`
          .cwd(repo.path)
          .quiet();
        await $`gh pr create --title B --head spry/dondenton/bbb22222 --base main --body ${"Stacked PR B"}`
          .cwd(repo.path)
          .quiet();
      }

      doc.prose(
        "After pushing, `sp sync` checks each open PR's base, retargets any that are wrong, and refreshes the local PR status cache read by `sp view`. No network call is needed at view time — sync is the mechanism that fetches fresh status from GitHub:",
      );

      // PR numbers are GitHub-minted (non-deterministic); canonicalize the one
      // shown so the generated doc stays stable across re-recordings.
      doc.scrub(/retargeted PR #\d+/g, "retargeted PR #11");

      const { command, result } = await runSp(repo.path, "sync", [], {
        env: cassetteEnv({ section: "commands/sync", order: 50 }),
      });
      doc.command(command);
      doc.output(result.stdout);

      if (fixture) await fixture.reset();

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pushed spry/dondenton/aaa11111");
      expect(result.stdout).toContain("pushed spry/dondenton/bbb22222");
      expect(result.stdout).toMatch(/retargeted PR #\d+/);
      expect(result.stdout).toContain("Updated PR cache");
      expect(result.stdout).toContain("Sync complete");
    },
  );

  docTest(
    "Selecting which branches to open as PRs",
    { section: "commands/sync", order: 25, timeout: 40000 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
      await git.run(["commit", "--allow-empty", "-m", "Add login\n\nSpry-Commit-Id: aaa11111"], {
        cwd: repo.path,
      });

      doc.prose(
        "Run `sp sync --open` (no arguments) to choose which unpublished branches to open as PRs. Spry shows an interactive menu — use Space to toggle, Enter to confirm:",
      );
      doc.command("sp sync --open");

      // Spawn the harness in a real PTY — TUI runs for real, gh is stubbed in-process
      const driver = await createTerminalDriver("bun", [harnessPath, repo.path], {
        cols: 80,
        rows: 24,
      });
      // Register cleanup via the repos array so afterAll handles it
      repos.push({ cleanup: () => driver.close() });

      // Wait for TUI to render (label is "<id>  <subject>", substring match is sufficient)
      // 15 s matches the later waitForText — Bun cold-start + git ops can exceed 5 s in Docker
      await driver.waitForText("Add login", { timeout: 15000 });

      // Capture the menu before any selection
      doc.screen(driver.capture());

      // Select the candidate and confirm
      driver.press("Space");
      driver.press("Enter");

      // Wait for sync to complete
      // Note: if this times out, the harness likely hit an error path — print driver.capture().text to diagnose
      await driver.waitForText("Sync complete", { timeout: 15000 });

      // After the TUI exits, sync logs are appended to the 24-row buffer. The upper rows
      // still contain TUI rendering artifacts. Extract only the sync output lines for docs.
      const snap = driver.capture();
      const syncLines = snap.lines
        .map((l) => l.trimEnd())
        .filter(
          (l) =>
            l.includes("pushed") ||
            l.includes("Created") ||
            l.includes("Sync complete") ||
            l.includes("https://") ||
            l.includes("↑") ||
            l.includes("✓"),
        );
      doc.output(syncLines.join("\n") + "\n");

      const { expect } = await import("bun:test");
      expect(snap.text).toContain("Sync complete");
      expect(syncLines.join("\n")).toContain("pull/42");
    },
  );

  docTest(
    "Pushing every tracked stack with --all",
    { section: "commands/sync", order: 60, timeout: 60000 },
    async (doc) => {
      // Record mode publishes two independent single-commit stacks on
      // spry-check, each with its own PR, and captures --all's PR-cache
      // refresh; replay serves it offline.
      const recording = isRecording();
      const fixture = recording ? await createGitHubFixture() : undefined;
      if (fixture) await fixture.reset();

      const repo = await createRepo({ origin: recording ? "github" : "local" });
      repos.push(repo);
      doc.scrub(repo);
      doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");

      await repo.git.run(["config", "spry.trunk", "main"]);
      await repo.git.run(["config", "spry.remote", "origin"]);
      await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
      const repoSlug = `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`;
      await repo.git.run(["config", "spry.repo", repoSlug]);

      const { registerBranch } = await import("../../src/git/tracked-branches.ts");
      const { $ } = await import("bun");

      // Two independent stacks, each already published once (and, in record
      // mode, each with its own PR targeting trunk).
      for (const [branch, id] of [
        ["feature/login", "aaa11111"],
        ["feature/search", "bbb22222"],
      ] as const) {
        await repo.git.run(["checkout", "main"]);
        await repo.git.run(["checkout", "-b", branch]);
        await repo.git.run(["commit", "--allow-empty", "-m", `Work\n\nSpry-Commit-Id: ${id}`]);
        const head = (await repo.git.run(["rev-parse", "HEAD"])).stdout.trim();
        await repo.git.run(["push", "origin", `${head}:refs/heads/spry/dondenton/${id}`]);
        await registerBranch(repo.git, branch);
        if (recording) {
          await $`gh pr create --title ${branch} --head spry/dondenton/${id} --base main --body ${"Stack"}`
            .cwd(repo.path)
            .quiet();
        }
      }

      doc.prose(
        "When you keep several independent stacks in flight, `sp sync --all` pushes every tracked stack's already-published branches in one run — no need to check each one out. It is push-only: it never rebases and never opens new PRs (use `sp rebase --all` to restack, and `sp sync --open` to publish).",
      );

      const { command, result } = await runSp(repo.path, "sync", ["--all"], {
        env: cassetteEnv({ section: "commands/sync", order: 60 }),
      });
      doc.command(command);
      doc.output(result.stdout);

      if (fixture) await fixture.reset();

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pushed spry/dondenton/aaa11111");
      expect(result.stdout).toContain("pushed spry/dondenton/bbb22222");
      expect(result.stdout).toContain("Updated PR cache");
    },
  );

  docTest("Empty stack", { section: "commands/sync", order: 30 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    doc.prose("On a branch with no commits ahead of trunk, `sp sync` no-ops:");

    const { command, result } = await runSp(repo.path, "sync");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });
});
