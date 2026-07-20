import { describe, test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { createRepo, createRealGitRunner, createTerminalDriver } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";
import { loadGroupRecords } from "../../src/git/group-titles.ts";

const harnessPath = join(import.meta.dir, "../fixtures/group-tui-harness.ts");

const repos: TestRepo[] = [];
// afterAll, not afterEach: under --concurrent a per-test cleanup hook would delete
// repos out from under still-running sibling tests.
afterAll(async () => {
  while (repos.length > 0) await repos.pop()!.cleanup();
});

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  const git = createRealGitRunner();
  await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
  await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
  await git.run(["config", "spry.branchPrefix", "spry/test"], { cwd: repo.path });
  return repo;
}

describe("sp group TUI", () => {
  test("assigns two commits to a group and saves a record", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add login form"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add session handling"], { cwd: repo.path });

    // Launch TUI: press → on first row (assign to A), ↓ to second row,
    // → to assign to A, then Enter to save
    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 100,
      rows: 30,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    term.press("ArrowRight"); // assign row 1 to group A
    await Bun.sleep(100);
    term.press("ArrowDown"); // move cursor to row 2
    await Bun.sleep(100);
    term.press("ArrowRight"); // assign row 2 to group A
    await Bun.sleep(100);
    term.press("Enter"); // save
    await term.waitForText("Groups updated", { timeout: 10000 });
    await term.close();

    // Verify group record was saved
    const records = await loadGroupRecords(git, { cwd: repo.path });
    const allRecords = Object.values(records);
    expect(allRecords).toHaveLength(1);
    expect(allRecords[0]!.members).toHaveLength(2);
  });

  test("renames a group", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add auth"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add session"], { cwd: repo.path });

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 100,
      rows: 30,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    term.press("ArrowRight"); // assign row 1 to A
    await Bun.sleep(100);
    term.press("ArrowDown");
    await Bun.sleep(100);
    term.press("ArrowRight"); // assign row 2 to A
    await Bun.sleep(100);
    term.type("r"); // enter rename mode
    await Bun.sleep(100);
    term.type("Auth Flow"); // type the title
    await Bun.sleep(100);
    term.press("Enter"); // confirm rename
    await Bun.sleep(100);
    term.press("Enter"); // save editor
    await term.waitForText("Groups updated", { timeout: 10000 });
    await term.close();

    const records = await loadGroupRecords(git, { cwd: repo.path });
    const allRecords = Object.values(records);
    expect(allRecords).toHaveLength(1);
    expect(allRecords[0]!.title).toBe("Auth Flow");
  });

  test("dirty working tree disables reordering but still allows grouping", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "First commit"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Second commit"], { cwd: repo.path });
    await Bun.write(join(repo.path, "README.md"), "# Test repo\n\ndirty but local\n");

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 100,
      rows: 30,
    });

    await term.waitForText("Reordering disabled: working tree is dirty.", { timeout: 15000 });
    term.press(" "); // would enter move mode if reordering were enabled
    await Bun.sleep(100);
    expect(term.capture().text).not.toContain("MOVE MODE");

    term.press("ArrowRight"); // grouping is still allowed
    await Bun.sleep(100);
    term.press("Enter");
    await term.waitForText("Groups updated", { timeout: 10000 });
    await term.close();

    const records = await loadGroupRecords(git, { cwd: repo.path });
    const allRecords = Object.values(records);
    expect(allRecords).toHaveLength(1);
    expect(allRecords[0]!.members).toHaveLength(1);

    const status = (await git.run(["status", "--porcelain"], { cwd: repo.path })).stdout;
    expect(status).toContain(" M README.md");
  });

  test("cancelling with q writes no records", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Add feature"], { cwd: repo.path });

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 100,
      rows: 30,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    term.press("ArrowRight"); // assign to group A
    await Bun.sleep(100);
    term.type("q"); // cancel
    await term.waitForText("Cancelled.", { timeout: 5000 });
    await term.close();

    const records = await loadGroupRecords(git, { cwd: repo.path });
    expect(Object.keys(records)).toHaveLength(0);
  });

  test("reordering two commits rewrites the git history", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();

    await git.run(["checkout", "-b", "feature/x"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "First commit"], { cwd: repo.path });
    await git.run(["commit", "--allow-empty", "-m", "Second commit"], { cwd: repo.path });

    // Get original order
    const logBefore = await git.run(["log", "--reverse", "--format=%s", "main..HEAD"], {
      cwd: repo.path,
    });
    expect(logBefore.stdout.trim()).toBe("First commit\nSecond commit");

    const term = await createTerminalDriver("bun", ["run", harnessPath, repo.path], {
      cols: 100,
      rows: 30,
    });

    await term.waitForText("Stack:", { timeout: 15000 });
    await Bun.sleep(300);
    term.press("ArrowDown"); // move cursor to second commit
    await Bun.sleep(300);
    term.press(" "); // grab it - enters move mode
    await term.waitForText("MOVE MODE", { timeout: 5000 }); // wait for move mode to show
    term.press("ArrowUp"); // move it up
    await Bun.sleep(500); // wait for conflict prediction + re-render
    term.press(" "); // drop it
    await Bun.sleep(300);
    term.press("Enter"); // save
    await term.waitForText("Reordered", { timeout: 10000 });
    await term.close();

    const logAfter = await git.run(["log", "--reverse", "--format=%s", "main..HEAD"], {
      cwd: repo.path,
    });
    expect(logAfter.stdout.trim()).toBe("Second commit\nFirst commit");
  });
});
