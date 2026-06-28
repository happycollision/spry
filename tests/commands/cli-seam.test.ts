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
