import { expect } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { docTest, createRepo, createRunner } from "../lib/index.ts";

const runSp = createRunner(join(import.meta.dir, "../../src/cli/index.ts"));

docTest(
  "Happy Trees commands and configuration",
  { section: "commands/ht", order: 10 },
  async (doc) => {
    const { command, result } = await runSp(import.meta.dir, "ht", ["help"]);
    expect(result.exitCode).toBe(0);
    doc.command(command);
    doc.output(result.stdout);
  },
);

docTest("Gardening worktrees", { section: "commands/ht", order: 20 }, async (doc) => {
  const repo = await createRepo();
  doc.scrub(await realpath(repo.path), "/tmp/repo");
  doc.scrub(repo);
  const trees = join(repo.path, "trees");
  await repo.git.run(["config", "happy-trees.worktreesDir", trees], { cwd: repo.path });
  try {
    doc.prose(
      "Create a branch and worktree from the default branch. Existing Happy Trees Git configuration also applies to Spry.",
    );
    for (const args of [
      ["co", "feature/login", "-s"],
      ["ls"],
      ["setup", "--init"],
      ["setup"],
      ["remove", "feature/login"],
      ["co", "feature/login", "-s"],
      ["destroy", "feature/login"],
    ]) {
      const cwd =
        args[0] === "setup" && args.length === 1 ? join(trees, "feature/login") : repo.path;
      const { command, result } = await runSp(cwd, "ht", args);
      expect(result.exitCode).toBe(0);
      doc.command(command);
      doc.output(result.stdout);
    }
  } finally {
    await repo.cleanup();
  }
});

docTest("Actionable errors", { section: "commands/ht", order: 30 }, async (doc) => {
  const repo = await createRepo();
  doc.scrub(await realpath(repo.path), "/tmp/repo");
  doc.scrub(repo);
  try {
    for (const args of [
      ["co", "--bogus"],
      ["co", "one", "two", "three"],
      ["co", "-e"],
      ["remove", "missing"],
      ["destroy", "main", "--force"],
      ["setup"],
    ]) {
      const { command, result } = await runSp(repo.path, "ht", args);
      expect(result.exitCode).toBe(1);
      doc.command(command);
      doc.output(result.stderr);
    }
  } finally {
    await repo.cleanup();
  }
});
