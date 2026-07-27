// Doc-producing tests for `sp --version`. The version flag is registered on the
// commander program itself (not a subcommand), so it needs no repo state — it
// just prints the package.json version and exits 0.
import { describe, afterAll } from "bun:test";
import { join } from "node:path";
import { docTest, createRunner, createRepo } from "../lib/index.ts";
import pkg from "../../package.json" with { type: "json" };

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const runSp = createRunner(cliPath);

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

describe("sp --version docs", () => {
  docTest("Printing the version", { section: "commands/version", order: 10 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);

    doc.prose("Pass `--version` (or `-v`) to print the installed `sp` version and exit:");

    const { command, result } = await runSp(repo.path, "--version");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  docTest("The -v short flag", { section: "commands/version", order: 20 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);

    const { result } = await runSp(repo.path, "-v");

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});
