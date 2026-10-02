import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, chmod, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Happy Trees unchanged shell behavior suite", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spry-ht-")));
  const cli = join(import.meta.dir, "../../src/cli/index.ts");
  try {
    await mkdir(join(root, "test"));
    await mkdir(join(root, "bin"));
    await copyFile(
      join(import.meta.dir, "../fixtures/happy-trees/git-ht-test.sh"),
      join(root, "test/git-ht-test.sh"),
    );
    // The suite expects the git-ht executable and its usage spelling.
    await Bun.write(
      join(root, "bin/git-ht"),
      `#!/bin/sh\nout=$("${process.execPath}" "${cli}" ht "$@" 2>&1)\ncode=$?\nprintf '%s\\n' "$out" | sed 's/Usage: sp ht/Usage: git ht/g'\nexit "$code"\n`,
    );
    await chmod(join(root, "bin/git-ht"), 0o755);
    const child = Bun.spawn(["sh", join(root, "test/git-ht-test.sh")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, failures: code ? stdout + stderr : "" }).toEqual({ code: 0, failures: "" });
    expect(stdout).toContain("Tests failed: \u001b[0;31m0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

test("fzf drives checkout/remove/destroy and cancellation leaves worktrees intact", async () => {
  const { createRepo, createRunner } = await import("../lib/index.ts");
  const repo = await createRepo();
  const run = createRunner(join(import.meta.dir, "../../src/cli/index.ts"));
  const bin = join(repo.path, "bin");
  const trees = join(repo.path, "trees");
  await mkdir(bin);
  await repo.git.run(["config", "happy-trees.worktreesDir", trees], { cwd: repo.path });
  const stub = join(bin, "fzf");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HT_SELECTION: "topic",
    HT_ENTRIES: join(repo.path, "entries"),
  };
  await Bun.write(
    stub,
    '#!/bin/sh\ncat > "$HT_ENTRIES"\nif [ "$HT_SELECTION" = cancel ]; then exit 130; fi\ngrep "^$HT_SELECTION" "$HT_ENTRIES"\n',
  );
  await chmod(stub, 0o755);
  try {
    await repo.git.run(["branch", "topic"], { cwd: repo.path });
    expect((await run(repo.path, "ht", ["co", "-s"], { env })).result.exitCode).toBe(0);
    expect(await Bun.file(env.HT_ENTRIES).text()).toContain("topic\t(local)");
    expect(
      (await run(repo.path, "ht", ["remove"], { env: { ...env, HT_SELECTION: "cancel" } })).result
        .exitCode,
    ).toBe(1);
    expect(await Bun.file(join(trees, "topic/.git")).exists()).toBe(true);
    expect((await run(repo.path, "ht", ["remove"], { env })).result.exitCode).toBe(0);
    expect(await Bun.file(env.HT_ENTRIES).text()).toContain("topic\t(worktree:");
    expect((await run(repo.path, "ht", ["co", "topic", "-s"])).result.exitCode).toBe(0);
    expect((await run(repo.path, "ht", ["destroy"], { env })).result.exitCode).toBe(0);
    expect(await Bun.file(env.HT_ENTRIES).text()).not.toContain("main\t");
    expect(
      (await repo.git.run(["show-ref", "--verify", "refs/heads/topic"], { cwd: repo.path }))
        .exitCode,
    ).not.toBe(0);
  } finally {
    await repo.cleanup();
  }
});
