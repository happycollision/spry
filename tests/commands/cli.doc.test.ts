import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner, docTest } from "../lib/index.ts";

const runSp = createRunner(join(import.meta.dir, "../../src/cli/index.ts"));
const operations = ["view", "sync", "group", "rebase", "land", "clean"];
let cwd: string;

beforeAll(async () => {
  // No repository or spry configuration: routing must not invoke handlers.
  cwd = await mkdtemp(join(tmpdir(), "spry-cli-help-"));
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

docTest("Root and stack help", { section: "commands/cli", order: 10 }, async (doc) => {
  doc.prose("Run `sp` for the command namespaces, or `sp stack` for stacked PR operations:");
  for (const path of [[], ["stack"]]) {
    const { command, result } = await runSp(cwd, path);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Usage: sp${path.length ? " stack" : ""} `);
    const explicit = await runSp(cwd, [...path, "--help"]);
    expect(explicit.result.exitCode).toBe(0);
    expect(explicit.result.stdout).toBe(result.stdout);
    if (!path.length) {
      expect(result.stdout).toContain("stack");
      expect(result.stdout).toContain("ht");
      for (const operation of operations) {
        expect(result.stdout).not.toMatch(new RegExp(`^  ${operation}\\b`, "m"));
      }
    } else {
      for (const operation of operations) expect(result.stdout).toContain(operation);
    }
    doc.command(command);
    doc.output(result.stdout);
  }
});

docTest("Retired root commands", { section: "commands/cli", order: 20 }, async (doc) => {
  doc.prose(
    "The former root commands fail with a migration hint; they never forward to an operation:",
  );
  for (const operation of operations) {
    const { command, result } = await runSp(cwd, operation);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Use sp stack ${operation}\n`);
    doc.command(command);
    doc.output(result.stderr);
  }
});

for (const operation of operations) {
  test(`sp stack ${operation} --help needs no repository`, async () => {
    const { result } = await runSp(cwd, ["stack", operation], ["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Usage: sp stack ${operation} [options]`);
  });

  test(`retired ${operation} rejects arbitrary arguments before client creation`, async () => {
    for (const args of [
      ["--help"],
      ["--version"],
      ["--unknown", "value", "extra"],
      ["--open", "--apply", "-", "--interval", "invalid"],
      ["--", "stack", "view"],
    ]) {
      const { result } = await runSp(cwd, operation, args, {
        // A bad cassette would fail if routing initialized the gh seam.
        env: { SPRY_GH_CASSETTE: join(cwd, "missing-cassette.json") },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`Use sp stack ${operation}\n`);
    }
  });
}
