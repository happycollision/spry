import { expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, chmod, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { htCommand } from "../../src/commands/ht.ts";
import { createTerminalDriver } from "../lib/terminal-driver.ts";

async function runTerminal(cwd: string, args: string[], env: Record<string, string> = {}) {
  const term = await createTerminalDriver(
    process.execPath,
    [join(import.meta.dir, "../../src/cli/index.ts"), ...args],
    {
      cwd,
      cols: 160,
      rows: 60,
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        SPRY_NON_INTERACTIVE: "0",
        ...env,
      },
    },
  );
  try {
    const exitCode = await term.waitForExit({ timeout: 10000 });
    return { exitCode, output: term.capture().text };
  } finally {
    await term.close();
  }
}

for (const command of ["checkout", "co", "remove", "destroy"]) {
  test(`${command} without a branch refuses before any Git or config read`, async () => {
    const run = mock(async () => {
      throw new Error("Git must not be called");
    });
    const error: unknown = await htCommand({ run }, [command]).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`sp ht ${command} <branch>`);
    expect(run).not.toHaveBeenCalled();
  });
}

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

test("fzf requires PTY opt-in and drives checkout/remove/destroy without harming cancelled worktrees", async () => {
  const { createRepo, createRunner, withIsolatedGitConfig } = await import("../lib/index.ts");
  const repo = await createRepo();
  const run = withIsolatedGitConfig(createRunner(join(import.meta.dir, "../../src/cli/index.ts")));
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
    for (const command of ["co", "remove", "destroy"]) {
      const denied = await runTerminal(repo.path, ["ht", command], env);
      expect(denied.exitCode).toBe(1);
      expect(denied.output).toContain("Interactive input is disabled by default");
      expect(denied.output).toContain(`sp ht ${command} <branch>`);
      const locked = await runTerminal(repo.path, ["-i", "ht", command], {
        ...env,
        SPRY_NON_INTERACTIVE: "1",
      });
      expect(locked.exitCode).toBe(1);
      expect(locked.output).toContain("disabled by SPRY_NON_INTERACTIVE=1");
      const dumb = await runTerminal(repo.path, ["-i", "ht", command], {
        ...env,
        TERM: "dumb",
      });
      expect(dumb.exitCode).toBe(1);
      expect(dumb.output).toContain("requires terminal stdin and stdout and a usable TERM");
      const piped = await run(repo.path, ["-i", "ht"], [command], { env });
      expect(piped.result.exitCode).toBe(1);
      expect(piped.result.stderr).toContain("requires terminal stdin and stdout");
      expect(await Bun.file(env.HT_ENTRIES).exists()).toBe(false);
    }
    expect((await runTerminal(repo.path, ["-i", "ht", "co", "-s", "-E"], env)).exitCode).toBe(0);
    expect(await Bun.file(env.HT_ENTRIES).text()).toContain("topic\t(local)");
    const cancelled = await runTerminal(repo.path, ["--interactive", "ht", "remove"], {
      ...env,
      HT_SELECTION: "cancel",
    });
    expect(cancelled.exitCode).toBe(1);
    expect(cancelled.output).toContain("Selection cancelled");
    expect(await Bun.file(join(trees, "topic/.git")).exists()).toBe(true);
    expect((await runTerminal(repo.path, ["-i", "ht", "remove"], env)).exitCode).toBe(0);
    expect(await Bun.file(env.HT_ENTRIES).text()).toContain("topic\t(worktree:");
    expect((await run(repo.path, "ht", ["co", "topic", "-s"])).result.exitCode).toBe(0);
    expect((await runTerminal(repo.path, ["-i", "ht", "destroy"], env)).exitCode).toBe(0);
    expect(await Bun.file(env.HT_ENTRIES).text()).not.toContain("main\t");
    expect(
      (await repo.git.run(["show-ref", "--verify", "refs/heads/topic"], { cwd: repo.path }))
        .exitCode,
    ).not.toBe(0);
  } finally {
    await repo.cleanup();
  }
});

test("setup and exec receive EOF by default, inherit only with valid opt-in, and can be skipped", async () => {
  const { createRepo, createRunner, withIsolatedGitConfig } = await import("../lib/index.ts");
  const repo = await createRepo();
  const run = withIsolatedGitConfig(createRunner(join(import.meta.dir, "../../src/cli/index.ts")));
  const trees = join(repo.path, "trees");
  const script = join(repo.path, "setup.sh");
  const probe =
    "if [ -t 0 ]; then echo HT_STDIN_TTY; elif read -r line; then echo HT_STDIN_DATA; else echo HT_STDIN_EOF; fi";
  try {
    await Bun.write(script, `#!/bin/sh\necho HT_SETUP\n${probe}\n`);
    await chmod(script, 0o755);
    await repo.git.run(["config", "happy-trees.worktreesDir", trees], { cwd: repo.path });
    await repo.git.run(["config", "happy-trees.setupLocation", script], { cwd: repo.path });
    await repo.git.run(["config", "happy-trees.exec", `echo HT_EXEC; ${probe}`], {
      cwd: repo.path,
    });
    for (const [branch, prefix, env, expected] of [
      ["default", [], {}, "HT_STDIN_EOF"],
      ["interactive", ["-i"], {}, "HT_STDIN_TTY"],
      ["locked", [], { SPRY_NON_INTERACTIVE: "1" }, "HT_STDIN_EOF"],
      ["dumb", ["-i"], { TERM: "dumb" }, "HT_STDIN_EOF"],
    ] as const) {
      const result = await runTerminal(repo.path, [...prefix, "ht", "co", branch], { ...env });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("HT_SETUP");
      expect(result.output).toContain("HT_EXEC");
      expect(result.output.match(new RegExp(expected, "g"))).toHaveLength(2);
      const setup = await runTerminal(join(trees, branch), [...prefix, "ht", "setup"], { ...env });
      expect(setup.exitCode).toBe(0);
      expect(setup.output).toContain(expected);
    }
    const piped = (await run(repo.path, ["-i", "ht"], ["co", "piped"])).result;
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout.match(/HT_STDIN_EOF/g)).toHaveLength(2);
    for (const branch of ["skipped", "default"]) {
      const result = await runTerminal(repo.path, ["ht", "co", branch, "-s", "-E"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("HT_SETUP");
      expect(result.output).not.toContain("HT_EXEC");
    }
  } finally {
    await repo.cleanup();
  }
});

for (const layout of ["separate admin", "separate .git", "submodule"] as const) {
  test(`Happy Trees uses working directories with ${layout}`, async () => {
    const { createRepo, createRunner, withIsolatedGitConfig } = await import("../lib/index.ts");
    const repo = await createRepo();
    const run = withIsolatedGitConfig(
      createRunner(join(import.meta.dir, "../../src/cli/index.ts")),
    );
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
  const { createRepo, createRunner, withIsolatedGitConfig } = await import("../lib/index.ts");
  const repo = await createRepo();
  const run = withIsolatedGitConfig(createRunner(join(import.meta.dir, "../../src/cli/index.ts")));
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
    const { createRepo, createRunner, withIsolatedGitConfig } = await import("../lib/index.ts");
    const repo = await createRepo();
    const run = withIsolatedGitConfig(
      createRunner(join(import.meta.dir, "../../src/cli/index.ts")),
    );
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
