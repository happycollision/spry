import { test, expect } from "bun:test";
import { join } from "node:path";
import { createRepo, createRunner } from "../lib/index.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const runSp = createRunner(cliPath);

test("unset cassette env: --help works unchanged", async () => {
  const { result } = await runSp(process.cwd(), "--help");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Spry");
});

test("command errors are printed without a Bun source-frame stack", async () => {
  const repo = await createRepo();
  try {
    await repo.git.run(["config", "spry.trunk", "main"]);
    await repo.git.run(["config", "spry.remote", "origin"]);
    await repo.git.run(["config", "spry.branchPrefix", "spry/test"]);
    await Bun.write(join(repo.path, "README.md"), "# Test repo\n\ndirty\n");

    const { result } = await runSp(repo.path, "rebase");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "✗ Cannot proceed: there are uncommitted changes in the working tree",
    );
    expect(result.stderr).not.toContain("throw new Error");
    expect(result.stderr).not.toContain("src/git/status.ts");
    expect(result.stderr).not.toContain("Bun v");
  } finally {
    await repo.cleanup();
  }
});

// The --interval guard fires during CLI arg parsing, before any git/gh work, so
// a plain cwd is enough — no configured repo needed. A rejected interval must
// never reach the poll loop (where it would become setTimeout(…, NaN|<=0) and
// hot-loop the GitHub API).
for (const bad of ["abc", "0", "-5"]) {
  test(`land --interval ${bad} is rejected before doing any work`, async () => {
    const { result } = await runSp(process.cwd(), "land", [
      "--through",
      "x",
      "--poll",
      "--interval",
      bad,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--interval must be a positive number of seconds");
    expect(result.stderr).toContain(`(got "${bad}")`);
  });
}

test("land --interval 15 is accepted (positive value parses)", async () => {
  // Not a poll run — no --poll, no configured repo — so it exits for another
  // reason; the point is only that the interval parse does NOT reject 15.
  const { result } = await runSp(process.cwd(), "land", ["--through", "x", "--interval", "15"]);
  expect(result.stderr).not.toContain("--interval must be");
});
