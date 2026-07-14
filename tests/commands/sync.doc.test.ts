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
  withGitHubFixture,
} from "../lib/index.ts";

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

    // Pre-publish the branch at an older sha (main) so its remote tip is behind
    // the local commit — this is the case where `sp sync` actually pushes. When
    // the remote already matches the local tip, sync skips the redundant push.
    const mainSha = (await git.run(["rev-parse", "main"], { cwd: repo.path })).stdout.trim();
    await git.run(["push", "origin", `${mainSha}:refs/heads/spry/dondenton/aaa11111`], {
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

    doc.prose(
      "Spry skips any branch whose remote tip already matches its local commit, so running `sp sync` again with nothing new does no redundant push — the branch simply isn't listed:",
    );

    const { command: command2, result: result2 } = await runSp(repo.path, "sync");
    doc.command(command2);
    doc.output(result2.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pushed spry/dondenton/aaa11111");
    // Second sync: the branch is already up to date, so it is NOT pushed again.
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).not.toContain("pushed spry/dondenton/aaa11111");
  });

  docTest(
    "Opening a new PR",
    { section: "commands/sync", order: 20, timeout: 60000 },
    async (doc) => {
      // Record mode drives the real spry-check repo and captures genuine gh
      // responses into the committed cassette; replay (default) serves them
      // offline. The same body runs both ways — only the git origin and the
      // gh seam env differ. See docs/plans/2026-06-13-gh-cassettes-real-recording.md.
      // withGitHubFixture serializes record-mode bodies (which all mutate the
      // one shared spry-check repo) via a cross-process lock and resets the
      // fixture before the body; replay runs unlocked with fixture === undefined.
      const recording = isRecording();
      await withGitHubFixture({ recording }, async () => {
        const repo = await createRepo({ origin: recording ? "github" : "local" });
        repos.push(repo);
        // Neutralize the real test-repo slug BEFORE doc.scrub(repo). In record
        // mode repo.originPath IS the fixture URL (https://github.com/<owner>/spry-check),
        // and doc.scrub(repo) would rewrite that prefix to /tmp/repo-origin — which
        // would then shadow the github-host canonicalization and leave a divergent,
        // non-deterministic PR URL in the generated docs. Registering this first lets
        // it win in record mode; in replay originPath is a /tmp path so order is moot.
        doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");
        doc.scrub(repo);
        // PR numbers are GitHub-minted (non-deterministic); canonicalize the ones
        // shown so the generated doc stays stable across re-recordings.
        doc.scrub(/Created PR #\d+/g, "Created PR #42");
        doc.scrub(/pull\/\d+/g, "pull/42");

        // Seeded commits: repo.git pins identity and stamps per-run monotonic
        // dates. Replay does not need matching SHAs — the cassette keys gh
        // calls by branch name, never by SHA.
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

        const { expect } = await import("bun:test");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Created PR #");
        expect(result.stdout).toContain("Sync complete");
      });
    },
  );

  docTest(
    "Opening a group as a single PR",
    { section: "commands/sync", order: 22, timeout: 60000 },
    async (doc) => {
      // Record mode publishes one real PR on spry-check for the grouped unit and
      // captures gh's create + PR-status traffic; replay serves it offline. Same
      // body both ways — only the git origin and the gh seam env differ.
      const recording = isRecording();
      await withGitHubFixture({ recording }, async () => {
        const repo = await createRepo({ origin: recording ? "github" : "local" });
        repos.push(repo);
        // github-host canonicalization must precede doc.scrub(repo): in record mode
        // repo.originPath is the fixture URL, and doc.scrub(repo) would otherwise
        // rewrite it to /tmp/repo-origin and shadow this scrub. See order 20.
        doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");
        doc.scrub(repo);

        await repo.git.run(["config", "spry.trunk", "main"]);
        await repo.git.run(["config", "spry.remote", "origin"]);
        await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
        const repoSlug = `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`;
        await repo.git.run(["config", "spry.repo", repoSlug]);

        await repo.git.run(["checkout", "-b", "feature/auth"]);
        await repo.git.run([
          "commit",
          "--allow-empty",
          "-m",
          "Add login form\n\nSpry-Commit-Id: aaa11111",
        ]);
        await repo.git.run([
          "commit",
          "--allow-empty",
          "-m",
          "Add session handling\n\nSpry-Commit-Id: bbb22222",
        ]);

        // Group both commits under one record so they ship as a single PR. The
        // group id becomes the unit id (and the branch suffix); pin it so the gh
        // arguments — and therefore the cassette key — are deterministic.
        const { saveGroupRecord } = await import("../../src/git/group-titles.ts");
        await saveGroupRecord(repo.git, "grp00001", {
          title: "Auth flow",
          members: ["aaa11111", "bbb22222"],
        });

        doc.prose(
          "When you group commits with `sp group`, `sp sync --open <group-id>` publishes the whole group as a single PR. The PR title is the group's title and its body is left empty by design — the individual commit messages carry the detail:",
        );

        // PR numbers are GitHub-minted (non-deterministic); canonicalize the ones
        // shown so the generated doc stays stable across re-recordings.
        doc.scrub(/Created PR #\d+/g, "Created PR #42");
        doc.scrub(/pull\/\d+/g, "pull/42");

        const { command, result } = await runSp(repo.path, "sync", ["--open", "grp00001"], {
          env: cassetteEnv({ section: "commands/sync", order: 22 }),
        });
        doc.command(command);
        doc.output(result.stdout);

        // Recording is the real-gh validation: confirm the live PR was opened with
        // the group title and an empty body before a later reset tears it down.
        if (recording) {
          const { $ } = await import("bun");
          const view =
            await $`gh pr view spry/dondenton/grp00001 --repo ${repoSlug} --json title,body`
              .cwd(repo.path)
              .quiet();
          const pr = JSON.parse(view.stdout.toString()) as { title: string; body: string };
          const { expect } = await import("bun:test");
          expect(pr.title).toBe("Auth flow");
          expect(pr.body).toBe("");
        }

        const { expect } = await import("bun:test");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("↑ pushed spry/dondenton/grp00001");
        expect(result.stdout).toContain("Created PR #");
        expect(result.stdout).toContain("Auth flow");
        expect(result.stdout).toContain("Sync complete");
      });
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
    "Selecting which branches to open as PRs",
    { section: "commands/sync", order: 25, timeout: 60000 },
    async (doc) => {
      const recording = isRecording();
      await withGitHubFixture({ recording }, async () => {
        const repo = await createRepo({ origin: recording ? "github" : "local" });
        repos.push(repo);
        // github-host canonicalization must precede doc.scrub(repo): in record mode
        // repo.originPath is the fixture URL, and doc.scrub(repo) would otherwise
        // rewrite it to /tmp/repo-origin and shadow this scrub. See order 20.
        doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");
        doc.scrub(repo);

        await repo.git.run(["config", "spry.trunk", "main"]);
        await repo.git.run(["config", "spry.remote", "origin"]);
        await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
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
          "Run `sp sync --open` (no arguments) to choose which unpublished branches to open as PRs. Spry shows an interactive menu — use Space to toggle, Enter to confirm:",
        );
        doc.command("sp sync --open");

        // Canonicalize the GitHub-minted PR number for stable docs.
        doc.scrub(/pull\/\d+/g, "pull/42");
        doc.scrub(/Created PR #\d+/g, "Created PR #42");

        // Spawn the harness in a real PTY. The gh seam (cassetteEnv) records/replays
        // gh pr create + the PR-status graphql query; the TUI runs for real.
        const driver = await createTerminalDriver("bun", [harnessPath, repo.path], {
          cols: 80,
          rows: 24,
          env: cassetteEnv({ section: "commands/sync", order: 25 }),
        });
        repos.push({ cleanup: () => driver.close() });

        // Wait for the TUI to render (label is "<id>  <subject>", substring is enough).
        // 15 s, not the default 5 s: Bun cold-start + git ops can exceed 5 s in Docker.
        await driver.waitForText("Add login", { timeout: 15000 });
        doc.screen(driver.capture());

        driver.press("Space");
        driver.press("Enter");

        // 20 s, not the default 5 s: in record mode everything after the push
        // (gh pr create + the PR-status graphql query + the PR-cache push) is real
        // network. On replay the cassette makes it instant, so the larger cap is
        // never approached. If this times out, the harness likely hit an error
        // path — print driver.capture().text to diagnose.
        // Wait for the harness process to exit rather than the "Sync complete"
        // sentinel + close(): sync-tui-harness exits right after syncCommand
        // resolves and flush() runs, so waiting for exit avoids racing any
        // trailing work with a hard kill (see
        // docs/investigations/2026-07-07-group-reflog-nondeterminism.md).
        await driver.waitForExit({ timeout: 20000 });

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
        // The captured terminal text is the real (unscrubbed) output: a created PR
        // with a GitHub-minted number. (The scrubs above only canonicalize the
        // rendered doc to pull/42 for stability; they don't touch syncLines.)
        expect(syncLines.join("\n")).toMatch(/Created PR #\d+/);
        expect(syncLines.join("\n")).toMatch(/pull\/\d+/);
      });
    },
  );

  docTest(
    "Pushing every tracked stack with --all",
    { section: "commands/sync", order: 60, timeout: 60000 },
    async (doc) => {
      // Record mode builds two independent stacks on spry-check, opens each
      // stack's PR (via `sp sync --open`, so the PR has a real diff and stays
      // open), then adds one more commit per stack so each remote tip is
      // genuinely behind its local tip. `sp sync --all` then performs a real
      // push for every stack; replay serves it offline.
      const recording = isRecording();
      await withGitHubFixture({ recording }, async () => {
        const repo = await createRepo({ origin: recording ? "github" : "local" });
        repos.push(repo);
        // github-host canonicalization must precede doc.scrub(repo): in record mode
        // repo.originPath is the fixture URL, and doc.scrub(repo) would otherwise
        // rewrite it to /tmp/repo-origin and shadow this scrub. See order 20.
        doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");
        doc.scrub(repo);

        await repo.git.run(["config", "spry.trunk", "main"]);
        await repo.git.run(["config", "spry.remote", "origin"]);
        await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
        const repoSlug = `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`;
        await repo.git.run(["config", "spry.repo", repoSlug]);

        const { registerBranch } = await import("../../src/git/tracked-branches.ts");

        // Two independent stacks. For each: create the branch + commit, open its
        // PR so the branch is published with a real diff (the PR stays open), then
        // AMEND the commit — keeping its `Spry-Commit-Id` (so the unit/branch
        // identity is unchanged and deterministic) but giving it a new SHA. That
        // leaves every remote tip legitimately behind its local tip — the case
        // where `sp sync --all` actually pushes.
        for (const [branch, id] of [
          ["feature/login", "aaa11111"],
          ["feature/search", "bbb22222"],
        ] as const) {
          await repo.git.run(["checkout", "main"]);
          await repo.git.run(["checkout", "-b", branch]);
          await repo.git.run(["commit", "--allow-empty", "-m", `Work\n\nSpry-Commit-Id: ${id}`]);
          await registerBranch(repo.git, branch);
          // Publish the PR for this stack (real diff vs main → PR opens and stays
          // open). In replay the gh traffic comes from the cassette.
          await runSp(repo.path, "sync", ["--open", id], {
            env: cassetteEnv({ section: "commands/sync", order: 60 }),
          });
          // Amend to advance the local SHA past the published remote tip (same
          // Spry-Commit-Id, so no re-injection and a stable branch id) — the
          // upcoming `--all` push is then a genuine, non-redundant push.
          await repo.git.run([
            "commit",
            "--amend",
            "--allow-empty",
            "-m",
            `Work (revised)\n\nSpry-Commit-Id: ${id}`,
          ]);
        }

        doc.prose(
          "When you keep several independent stacks in flight, `sp sync --all` pushes every tracked stack's already-published branches in one run — no need to check each one out. It is push-only: it never rebases and never opens new PRs (use `sp rebase --all` to restack, and `sp sync --open` to publish).",
        );

        const { command, result } = await runSp(repo.path, "sync", ["--all"], {
          env: cassetteEnv({ section: "commands/sync", order: 60 }),
        });
        doc.command(command);
        doc.output(result.stdout);

        const { expect } = await import("bun:test");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("pushed spry/dondenton/aaa11111");
        expect(result.stdout).toContain("pushed spry/dondenton/bbb22222");
        expect(result.stdout).toContain("Updated PR cache");
      });
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

  docTest(
    "Reordering a stack without merging PRs",
    { section: "commands/sync", order: 70, timeout: 60000 },
    async (doc) => {
      const recording = isRecording();
      await withGitHubFixture({ recording }, async () => {
        const repo = await createRepo({ origin: recording ? "github" : "local" });
        repos.push(repo);
        // github-host canonicalization must precede doc.scrub(repo): in record mode
        // repo.originPath is the fixture URL, and doc.scrub(repo) would otherwise
        // rewrite it to /tmp/repo-origin and shadow this scrub. See order 20.
        doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");
        doc.scrub(repo);

        await repo.git.run(["config", "spry.trunk", "main"]);
        await repo.git.run(["config", "spry.remote", "origin"]);
        await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
        const repoSlug = `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`;
        await repo.git.run(["config", "spry.repo", repoSlug]);

        // Build a 2-unit stack A(aaa)->B(bbb), open both PRs stacked.
        await repo.git.run(["checkout", "-b", "feature/reorder"]);
        await repo.git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"]);
        await repo.git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"]);

        doc.scrub(/Created PR #\d+/g, "Created PR #42");
        doc.scrub(/pull\/\d+/g, "pull/42");
        // Park/retarget log lines echo GitHub-minted PR numbers; canonicalize so
        // the generated doc stays stable across re-recordings.
        doc.scrub(/parked PR #\d+/g, "parked PR #42");
        doc.scrub(/retargeted PR #\d+/g, "retargeted PR #42");

        // Open both PRs first.
        await runSp(repo.path, "sync", ["--open", "aaa11111,bbb22222"], {
          env: cassetteEnv({ section: "commands/sync", order: 70 }),
        });

        // Reorder locally: swap so B is bottom, A is top (amend history).
        await repo.git.run(["reset", "--hard", "HEAD~2"]);
        await repo.git.run(["commit", "--allow-empty", "-m", "B\n\nSpry-Commit-Id: bbb22222"]);
        await repo.git.run(["commit", "--allow-empty", "-m", "A\n\nSpry-Commit-Id: aaa11111"]);

        doc.prose(
          "Reordering commits in a stack and re-syncing must never mark an open PR as merged. `sp sync` parks every affected PR onto trunk before force-pushing the reordered branches, then re-stacks them — so a reorder is safe:",
        );

        const { command, result } = await runSp(repo.path, "sync", [], {
          env: cassetteEnv({ section: "commands/sync", order: 70 }),
        });
        doc.command(command);
        doc.output(result.stdout);

        // Real-gh validation: this test's two branches must each still have an
        // OPEN PR after the reorder sync. Query per branch with `--state open` so
        // stale CLOSED/MERGED PRs on the SAME branch name (left by prior recording
        // runs — the doc tests reuse the spry/dondenton/{aaa,bbb} branch names and
        // commit ids) cannot contaminate the assertion. If the reorder had wrongly
        // merged a PR, that branch would have no OPEN PR and this would fail.
        if (recording) {
          const { $ } = await import("bun");
          const { expect } = await import("bun:test");
          for (const branch of ["spry/dondenton/aaa11111", "spry/dondenton/bbb22222"]) {
            const view =
              await $`gh pr list --repo ${repoSlug} --head ${branch} --state open --json number`
                .cwd(repo.path)
                .quiet();
            const open = JSON.parse(view.stdout.toString()) as Array<{ number: number }>;
            expect(open.length).toBeGreaterThan(0); // branch still has an OPEN PR
          }
        }

        const { expect } = await import("bun:test");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Sync complete");
      });
    },
  );
});
