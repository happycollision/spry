import { expect, test } from "bun:test";
import { join } from "node:path";
import { createRepo, createRunner, createTerminalDriver, docTest } from "../lib/index.ts";

const cli = join(import.meta.dir, "../../src/cli/index.ts");
const runSp = createRunner(cli);
const requests = [
  { args: ["stack", "sync", "--open"], hint: "sp stack sync --open <id1,id2>" },
  { args: ["stack", "group"], hint: "sp stack group --apply <json>" },
  { args: ["stack", "land"], hint: "sp stack land --through <id>" },
  { args: ["ht", "co"], hint: "sp ht co <branch>" },
  { args: ["ht", "remove"], hint: "sp ht remove <branch>" },
  { args: ["ht", "destroy"], hint: "sp ht destroy <branch>" },
];

docTest("Explicit interaction", { section: "commands/cli", order: 30 }, async (doc) => {
  doc.prose(
    "Spry never opens its own picker or confirmation by default, even in a terminal. Supply explicit arguments for automation; humans can opt in with the global `-i, --interactive` flag and a usable terminal. Missing choices fail before repository or network work:",
  );
  for (const { args, hint } of requests.slice(0, 3)) {
    const { command, result } = await runSp(process.cwd(), args);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(hint);
    expect(result.stderr).not.toContain("\x1b[?1049h");
    doc.command(command);
    doc.output(result.stderr);
  }
  doc.prose(
    "Interactive forms are `sp -i stack sync --open`, `sp -i stack group`, `sp -i stack land`, and `sp -i ht co`. `--non-interactive` explicitly asserts the default and conflicts with `-i`. Set `SPRY_NON_INTERACTIVE=1` in orchestration environments to reject either spelling of the opt-in. Explicit `stack land --through <id>` never asks a follow-up question: use `--poll` to wait for CI and `--allow-unresolved-threads` to acknowledge that specific advisory. Neither option bypasses other readiness gates.",
  );
});

for (const { args, hint } of requests) {
  test(`${args.join(" ")} refuses an agent's held-open pipe without mutation`, async () => {
    const repo = await createRepo();
    try {
      await repo.git.run(["commit", "--allow-empty", "-m", "Unstamped work"]);
      const snapshot = async () =>
        Promise.all([
          repo.git.run(["rev-parse", "HEAD"]),
          repo.git.run(["show-ref"]),
          repo.git.run(["ls-remote", "origin"]),
        ]);
      const before = await snapshot();
      const child = Bun.spawn([process.execPath, cli, ...args], {
        cwd: repo.path,
        stdin: "pipe", // Deliberately held open: rejection must not depend on EOF.
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const code = await Promise.race([child.exited, Bun.sleep(3000).then(() => "timeout")]);
        expect(code).toBe(1);
        expect(await new Response(child.stdout).text()).toBe("");
        expect(await new Response(child.stderr).text()).toContain(hint);
      } finally {
        child.kill();
        await child.exited;
      }
      expect(await snapshot()).toEqual(before);
    } finally {
      await repo.cleanup();
    }
  });
}

test("a PTY alone does not enable any selector", async () => {
  for (const { args, hint } of requests) {
    const terminal = await createTerminalDriver(process.execPath, [cli, ...args], { cols: 140 });
    try {
      expect(await terminal.waitForExit()).toBe(1);
      expect(terminal.capture().text).toContain(hint);
    } finally {
      await terminal.close();
    }
  }
});

test("opt-in requires both terminal streams and a usable TERM", async () => {
  for (const spelling of ["-i", "--interactive"]) {
    for (const args of [
      [spelling, "stack", "group"],
      ["stack", "group", spelling],
    ]) {
      const { result } = await runSp(process.cwd(), args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("requires terminal stdin and stdout");
    }
    const terminal = await createTerminalDriver(
      process.execPath,
      [cli, spelling, "stack", "group"],
      {
        env: { TERM: "dumb" },
        cols: 140,
      },
    );
    try {
      expect(await terminal.waitForExit()).toBe(1);
      expect(terminal.capture().text).toContain("usable TERM");
    } finally {
      await terminal.close();
    }
  }
});

test("the inherited lock and conflicting flags cannot be overridden", async () => {
  for (const spelling of ["-i", "--interactive"]) {
    for (const flags of [
      [spelling, "--non-interactive"],
      ["--non-interactive", spelling],
    ]) {
      const { result } = await runSp(process.cwd(), [...flags, "stack", "view"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cannot be combined");
    }
    const terminal = await createTerminalDriver(process.execPath, [cli, spelling, "ht", "co"], {
      env: { SPRY_NON_INTERACTIVE: "1" },
      cols: 140,
    });
    try {
      expect(await terminal.waitForExit()).toBe(1);
      expect(terminal.capture().text).toContain("SPRY_NON_INTERACTIVE=1");
    } finally {
      await terminal.close();
    }
  }
});

test("group --apply - rejects terminal input without reading", async () => {
  const terminal = await createTerminalDriver(
    process.execPath,
    [cli, "stack", "group", "--apply", "-"],
    {
      cols: 140,
    },
  );
  try {
    expect(await terminal.waitForExit()).toBe(1);
    expect(terminal.capture().text).toContain("< grouping.json");
  } finally {
    await terminal.close();
  }
});

test("both opt-in spellings open the real CLI editor across option placements", async () => {
  const repo = await createRepo();
  try {
    for (const [key, value] of [
      ["trunk", "main"],
      ["remote", "origin"],
      ["branchPrefix", "spry/test"],
      ["repo", "owner/repo"],
    ]) {
      await repo.git.run(["config", `spry.${key}`, value!]);
    }
    await repo.git.run(["checkout", "-b", "feature"]);
    await repo.git.run([
      "commit",
      "--allow-empty",
      "-m",
      "A real editor row\n\nSpry-Commit-Id: aaa11111",
    ]);
    // No live GitHub traffic: adoption lookup is best-effort and the editor runs normally.
    const cassette = join(repo.path, "empty-cassette.json");
    await Bun.write(cassette, JSON.stringify({ entries: [] }));
    for (const args of [
      ["-i", "stack", "group"],
      ["stack", "--interactive", "group"],
      ["stack", "group", "-i"],
    ]) {
      const terminal = await createTerminalDriver(process.execPath, [cli, ...args], {
        cwd: repo.path,
        env: { SPRY_GH_CASSETTE: cassette },
      });
      try {
        await terminal.waitForText("A real editor row");
        terminal.type("q");
        expect(await terminal.waitForExit()).toBe(0);
        expect(terminal.capture().text).toContain("Cancelled.");
      } finally {
        await terminal.close();
      }
    }
  } finally {
    await repo.cleanup();
  }
});

docTest("Piped grouping document", { section: "commands/group", order: 40 }, async (doc) => {
  const repo = await createRepo();
  try {
    doc.scrub(repo);
    for (const [key, value] of [
      ["trunk", "main"],
      ["remote", "origin"],
      ["branchPrefix", "spry/test"],
    ]) {
      await repo.git.run(["config", `spry.${key}`, value!]);
    }
    await repo.git.run(["checkout", "-b", "feature"]);
    await repo.git.run(["commit", "--allow-empty", "-m", "First\n\nSpry-Commit-Id: aaa11111"]);
    await repo.git.run(["commit", "--allow-empty", "-m", "Second\n\nSpry-Commit-Id: bbb22222"]);
    const input = {
      stack: [
        {
          type: "group",
          id: null,
          title: "Feature",
          commits: [
            { type: "commit", id: "aaa11111" },
            { type: "commit", id: "bbb22222" },
          ],
        },
      ],
    };
    doc.prose(
      "Start with `sp stack view --json`, edit its complete stack document, then supply JSON inline or from a file/pipe. The producer must close stdin at EOF. For example, grouping two commits:",
    );
    doc.output(JSON.stringify(input, null, 2));
    const child = Bun.spawn(
      [process.execPath, cli, "--non-interactive", "stack", "group", "--apply", "-"],
      {
        cwd: repo.path,
        env: { ...process.env, SPRY_NON_INTERACTIVE: "1" },
        stdin: Buffer.from(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    doc.command("sp --non-interactive stack group --apply - < grouping.json");
    doc.output(stdout);
    const view = await runSp(repo.path, ["stack", "view", "--json"]);
    expect(view.result.exitCode).toBe(0);
    const tree = JSON.parse(view.result.stdout);
    expect(tree.stack).toHaveLength(1);
    expect(tree.stack[0]).toMatchObject({
      type: "group",
      title: "Feature",
      commits: [{ id: "aaa11111" }, { id: "bbb22222" }],
    });
  } finally {
    await repo.cleanup();
  }
});
