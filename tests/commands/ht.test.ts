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

for (const layout of ["separate admin", "separate .git", "submodule"] as const) {
  test(`Happy Trees uses working directories with ${layout}`, async () => {
    const { createRepo, createRunner } = await import("../lib/index.ts");
    const repo = await createRepo();
    const run = createRunner(join(import.meta.dir, "../../src/cli/index.ts"));
    let root = repo.path;
    try {
      if (layout !== "submodule") {
        const admin = join(root, layout === "separate .git" ? "admin/.git" : "admin");
        await mkdir(join(root, "admin"), { recursive: true });
        expect(
          (await repo.git.run(["init", `--separate-git-dir=${admin}`], { cwd: root })).exitCode,
        ).toBe(0);
      } else {
        expect(
          (
            await repo.git.run(
              [
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                repo.originPath,
                "modules/lib",
              ],
              { cwd: root },
            )
          ).exitCode,
        ).toBe(0);
        root = join(root, "modules/lib");
      }
      expect((await run(root, "ht", ["setup", "--init"])).result.exitCode).toBe(0);
      expect(await Bun.file(join(root, "setup-worktree.sh")).exists()).toBe(true);
      expect(await Bun.file(join(root, "admin/setup-worktree.sh")).exists()).toBe(false);
      const topic = join(root, "../", `${root.split("/").pop()}.worktrees/topic`);
      expect((await run(root, "ht", ["co", "topic", "-s"])).result.exitCode).toBe(0);
      expect(await Bun.file(join(topic, ".git")).exists()).toBe(true);
      const listing = (await run(root, "ht", ["ls"])).result.stdout;
      expect(listing).toContain("topic\t");
      expect(listing).not.toContain("main\t");
      const setup = await run(topic, "ht", ["setup"]);
      expect(setup.result.exitCode).toBe(0);
      expect(setup.result.stdout).toContain(
        `Using setup script: ${await realpath(root)}/setup-worktree.sh`,
      );
      expect((await run(topic, "ht", ["destroy", "topic", "--force"])).result.exitCode).toBe(0);
      expect(await Bun.file(join(topic, ".git")).exists()).toBe(false);
      expect(
        (await repo.git.run(["show-ref", "--verify", "--quiet", "refs/heads/topic"], { cwd: root }))
          .exitCode,
      ).toBe(1);
    } finally {
      await rm(join(root, "../", `${root.split("/").pop()}.worktrees`), {
        recursive: true,
        force: true,
      });
      await repo.cleanup();
    }
  });
}

test("remove retains unique local commits when origin tracking is stale", async () => {
  const { createRepo, createRunner } = await import("../lib/index.ts");
  const repo = await createRepo();
  const run = createRunner(join(import.meta.dir, "../../src/cli/index.ts"));
  await repo.git.run(["config", "happy-trees.worktreesDir", join(repo.path, "trees")], {
    cwd: repo.path,
  });
  try {
    expect((await repo.git.run(["checkout", "-b", "topic"], { cwd: repo.path })).exitCode).toBe(0);
    const unique = await repo.commit("Unique local work");
    expect((await repo.git.run(["push", "origin", "topic"], { cwd: repo.path })).exitCode).toBe(0);
    await repo.checkout("main");
    expect((await run(repo.path, "ht", ["co", "topic", "-s"])).result.exitCode).toBe(0);
    expect(
      (
        await repo.git.run(["update-ref", "refs/heads/topic", "refs/heads/main"], {
          cwd: repo.originPath,
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await repo.git.run(["rev-parse", "refs/remotes/origin/topic"], { cwd: repo.path })
      ).stdout.trim(),
    ).toBe(unique);
    const result = (await run(repo.path, "ht", ["remove", "topic"])).result;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Kept local branch 'topic' (differs from remote)");
    expect(
      (await repo.git.run(["rev-parse", "refs/heads/topic"], { cwd: repo.path })).stdout.trim(),
    ).toBe(unique);
    expect(await Bun.file(join(repo.path, "trees/topic/.git")).exists()).toBe(false);
  } finally {
    await repo.cleanup();
  }
});

for (const [caseName, code, ref] of [
  ["failed query with partial stdout", 128, "refs/heads/topic"],
  ["successful query for a different ref", 0, "refs/heads/other"],
] as const) {
  test(`remove retains branch after ${caseName}`, async () => {
    const { createRepo, createRunner } = await import("../lib/index.ts");
    const repo = await createRepo();
    const run = createRunner(join(import.meta.dir, "../../src/cli/index.ts"));
    const bin = join(repo.path, "bin");
    const realGit = Bun.which("git");
    expect(realGit).not.toBeNull();
    await mkdir(bin);
    try {
      await repo.git.run(["branch", "topic"], { cwd: repo.path });
      await repo.git.run(["config", "happy-trees.worktreesDir", join(repo.path, "trees")], {
        cwd: repo.path,
      });
      expect((await run(repo.path, "ht", ["co", "topic", "-s"])).result.exitCode).toBe(0);
      const sha = (
        await repo.git.run(["rev-parse", "refs/heads/topic"], { cwd: repo.path })
      ).stdout.trim();
      await Bun.write(
        join(bin, "git"),
        '#!/bin/sh\nif [ "$1" = ls-remote ]; then\n  printf "%s\\t%s\\n" "$HT_SHA" "$HT_REF"\n  echo "transport failure" >&2\n  exit "$HT_EXIT"\nfi\nexec "$HT_REAL_GIT" "$@"\n',
      );
      await chmod(join(bin, "git"), 0o755);
      const result = (
        await run(repo.path, "ht", ["remove", "topic"], {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HT_REAL_GIT: realGit ?? "",
            HT_SHA: sha,
            HT_REF: ref,
            HT_EXIT: String(code),
          },
        })
      ).result;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Kept local branch 'topic'");
      expect(
        (await repo.git.run(["rev-parse", "refs/heads/topic"], { cwd: repo.path })).stdout.trim(),
      ).toBe(sha);
    } finally {
      await repo.cleanup();
    }
  });
}
