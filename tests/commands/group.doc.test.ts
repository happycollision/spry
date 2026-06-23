import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  docTest,
  createRepo,
  createRealGitRunner,
  createTerminalDriver,
  cassetteEnv,
  isRecording,
} from "../lib/index.ts";
import { createGitHubFixture } from "../lib/github-fixture.ts";

const harnessPath = join(import.meta.dir, "../fixtures/group-tui-harness.ts");
const adoptHarnessPath = join(import.meta.dir, "../fixtures/group-adopt-harness.ts");

const repos: Array<{ cleanup(): Promise<void> }> = [];
afterAll(async () => {
  for (const repo of repos) await repo.cleanup();
});

describe("sp group docs", () => {
  docTest("Grouping commits", { section: "commands/group", order: 10 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });
    await git.run(["checkout", "-b", "feature/auth"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login form"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add session handling"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Fix typo in README"], { cwd: repo.path });

    doc.prose(
      "Run `sp group` to open the interactive group editor. Use ↑↓ to move between commits and ←→ to assign or remove group membership. Commits in the same group ship as a single PR.",
    );

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 80,
      rows: 20,
    });

    // Wait for editor to appear, capture the initial screen
    await term.waitForText("Stack:", { timeout: 15000 });
    await Bun.sleep(200);

    // Assign first two commits to group A
    term.press("ArrowRight");
    await Bun.sleep(150);
    term.press("ArrowDown");
    await Bun.sleep(150);
    term.press("ArrowRight");
    await Bun.sleep(150);

    // Rename the group
    term.type("r");
    await Bun.sleep(150);
    term.type("Auth Flow");
    await Bun.sleep(150);
    term.press("Enter");
    await Bun.sleep(150);

    const { expect } = await import("bun:test");
    await term.waitForText("Auth Flow", { timeout: 3000 });
    const snapshot = term.capture();
    doc.screen(snapshot);

    // Save
    term.press("Enter");
    await term.waitForText("Groups updated", { timeout: 10000 });
    await term.close();

    expect(snapshot.text).toContain("Auth Flow");
  });

  docTest("Reordering commits", { section: "commands/group", order: 20 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });
    await git.run(["checkout", "-b", "feature/auth"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login form"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add session handling"], { cwd: repo.path });

    doc.prose(
      "Press Space to grab a commit and ↑↓ to reorder it. Spry predicts rebase conflicts as you move — rows with ⚠ may conflict. Press Space or Enter to drop the commit at its new position.",
    );

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 80,
      rows: 20,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    await Bun.sleep(200);

    // Grab the second commit and move it up
    term.press("ArrowDown");
    await Bun.sleep(150);
    term.press(" "); // grab
    await term.waitForText("MOVE MODE", { timeout: 5000 });
    term.press("ArrowUp"); // move up
    await Bun.sleep(300); // wait for conflict prediction

    const { expect } = await import("bun:test");
    const snapshot = term.capture();
    doc.screen(snapshot);
    expect(snapshot.text).toContain("MOVE MODE");

    term.press(" "); // drop
    await Bun.sleep(100);
    term.press("Enter"); // save
    await term.waitForText("Reordered", { timeout: 10000 });
    await term.close();
  });

  docTest("Renaming a group", { section: "commands/group", order: 15 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });
    await git.run(["checkout", "-b", "feature/auth"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login form"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add session handling"], { cwd: repo.path });

    doc.prose(
      "Press `r` to rename the group at the cursor. Type a title and press Enter to confirm, or Esc to cancel.",
    );

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 80,
      rows: 20,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    await Bun.sleep(200);

    // Assign both commits to group A, then rename it
    term.press("ArrowRight");
    await Bun.sleep(150);
    term.press("ArrowDown");
    await Bun.sleep(150);
    term.press("ArrowRight");
    await Bun.sleep(150);

    // Enter rename mode and start typing — capture mid-edit
    term.type("r");
    await term.waitForText("RENAME MODE", { timeout: 3000 });
    await Bun.sleep(150);
    term.type("Auth");
    await Bun.sleep(150);

    const { expect } = await import("bun:test");
    const snapshot = term.capture();
    doc.screen(snapshot);
    expect(snapshot.text).toContain("RENAME MODE");

    // Finish the title and save
    term.type(" Flow");
    await Bun.sleep(150);
    term.press("Enter"); // confirm rename
    await Bun.sleep(150);
    term.press("Enter"); // save editor
    await term.waitForText("Groups updated", { timeout: 10000 });
    await term.close();
  });

  docTest("Conflict prediction", { section: "commands/group", order: 30 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });
    await git.run(["checkout", "-b", "feature/config"], { cwd: repo.path });

    // Two commits that both modify the same line — will conflict if reordered
    writeFileSync(join(repo.path, "config.txt"), "version = 1\n");
    await git.run(["add", "config.txt"], { cwd: repo.path });
    await git.run(["commit", "-m", "Set version to 1"], { cwd: repo.path });

    writeFileSync(join(repo.path, "config.txt"), "version = 2\n");
    await git.run(["add", "config.txt"], { cwd: repo.path });
    await git.run(["commit", "-m", "Set version to 2"], { cwd: repo.path });

    doc.prose(
      "While reordering, Spry predicts rebase conflicts in the background. Rows marked with ⚠ are likely to conflict if dropped in their current position.",
    );

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 80,
      rows: 20,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    await Bun.sleep(200);

    // Grab the second commit and move it above the first
    term.press("ArrowDown");
    await Bun.sleep(150);
    term.press(" "); // grab
    await term.waitForText("MOVE MODE", { timeout: 5000 });
    term.press("ArrowUp"); // move up — triggers conflict prediction
    await term.waitForText("⚠", { timeout: 5000 }); // wait for prediction to land

    const { expect } = await import("bun:test");
    const snapshot = term.capture();
    doc.screen(snapshot);
    expect(snapshot.text).toContain("⚠");
    expect(snapshot.text).toContain("MOVE MODE");

    term.press("Escape"); // cancel move
    await Bun.sleep(100);
    term.press("q"); // quit without saving
    await term.waitForText("Cancelled", { timeout: 5000 });
    await term.close();
  });

  docTest(
    "Adopting a PR",
    { section: "commands/group", order: 25, timeout: 60000 },
    async (doc) => {
      // Record mode publishes one real PR on spry-check (for the bottom commit)
      // and captures group's pre-editor PR lookup (findPRsForBranches); replay
      // serves it offline. The TUI itself makes no gh calls — adoption is decided
      // after the editor returns, from the already-fetched PR map — so the only
      // recorded traffic is the per-branch GraphQL lookups, keyed by branch name
      // and owner/repo (no SHA), which makes replay matching fully deterministic.
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
      // gh needs explicit owner/repo for its GraphQL query; pin to the slug the
      // committed cassette was recorded against (see sync.doc.test.ts).
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

      // Pre-publish the bottom commit's branch and, in record mode, open its PR.
      // This is the open PR the new group will adopt; the top commit has none.
      const aSha = (await repo.git.run(["rev-parse", "HEAD~1"])).stdout.trim();
      await repo.git.run(["push", "origin", `${aSha}:refs/heads/spry/dondenton/aaa11111`]);
      if (recording) {
        const { $ } = await import("bun");
        await $`gh pr create --title ${"Add login form"} --head spry/dondenton/aaa11111 --base main --body ${"Login form PR"}`
          .cwd(repo.path)
          .quiet();
      }

      doc.prose(
        "When you group commits and one of them already has an open PR, `sp group` adopts that PR for the new group instead of stranding it. Spry looks up each commit's branch on GitHub before the editor opens, then re-keys the new group's record to the PR's commit on save:",
      );

      const term = await createTerminalDriver("bun", [adoptHarnessPath, repo.path], {
        cols: 80,
        rows: 20,
        env: cassetteEnv({ section: "commands/group", order: 25 }),
      });

      await term.waitForText("Stack:", { timeout: 15000 });
      await Bun.sleep(200);

      // Assign both commits to a single new group.
      term.press("ArrowRight");
      await Bun.sleep(150);
      term.press("ArrowDown");
      await Bun.sleep(150);
      term.press("ArrowRight");
      await Bun.sleep(150);

      // Save — adoption runs on the way out, before "Groups updated".
      term.press("Enter");
      await term.waitForText("Groups updated", { timeout: 15000 });

      const snap = term.capture();
      const lines = snap.lines
        .map((l) => l.trimEnd())
        .filter((l) => l.includes("adopted PR") || l.includes("Groups updated"));
      doc.output(lines.join("\n") + "\n");

      await term.close();
      if (fixture) await fixture.reset();

      const { expect } = await import("bun:test");
      expect(snap.text).toContain("adopted PR");
      expect(snap.text).toContain("Groups updated");
    },
  );
});
