import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { docTest, createRepo, createRealGitRunner, createTerminalDriver } from "../lib/index.ts";

const harnessPath = join(import.meta.dir, "../fixtures/group-tui-harness.ts");

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
});
