import { test, expect } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealGitRunner, createRealGhClient, toStdinBuffer } from "../../src/lib/context.ts";

// The well-known git SHA of an empty blob — `git hash-object --stdin` of "".
const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

test("toStdinBuffer redirects an empty string (does not inherit parent stdin)", () => {
  const buf = toStdinBuffer("");
  expect(buf).toBeInstanceOf(Buffer);
  expect(buf?.length).toBe(0);
});

test("toStdinBuffer returns a buffer with the content for non-empty stdin", () => {
  expect(toStdinBuffer("hello")?.toString()).toBe("hello");
});

test("toStdinBuffer returns undefined when no input was supplied", () => {
  expect(toStdinBuffer(undefined)).toBeUndefined();
});

// Regression for the `sp sync --open` hang: a command run with EMPTY stdin must
// receive a real EOF, not inherit the parent's stdin. We run the git runner with
// `stdin: ""` against a stdin-reading command (`git hash-object --stdin`) inside
// a child whose own stdin is an open pipe that never reaches EOF. If empty stdin
// were inherited instead of fed as bytes, the child would block forever. (This
// is exactly what `gh ... --body-file -` did when the PR body was empty.)
for (const input of [undefined, "", "first line\nλ last line"]) {
  test(`subprocess input ${JSON.stringify(input)} is exact and never inherited`, async () => {
    const contextPath = new URL("../../src/lib/context.ts", import.meta.url).pathname;
    const program =
      `import { createRealGitRunner } from ${JSON.stringify(contextPath)};` +
      `const r = await createRealGitRunner().run(["hash-object", "--stdin"], { stdin: ${JSON.stringify(input)} });` +
      `process.stdout.write("OUT:" + r.stdout.trim());`;

    // stdin: "pipe" gives the child an open stdin we deliberately never write to or
    // close, so it never reaches EOF.
    const child = Bun.spawn(["bun", "-e", program], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const out = await Promise.race([
      new Response(child.stdout).text(),
      Bun.sleep(10000).then(() => "TIMEOUT"),
    ]);
    child.kill();
    await child.exited;

    const bytes = Buffer.from(input ?? "");
    const expected =
      bytes.length === 0
        ? EMPTY_BLOB_SHA
        : new Bun.CryptoHasher("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    expect(out).toBe(`OUT:${expected}`);
  });
}

test("gh receives closed input and supported prompt suppression", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spry-gh-input-"));
  try {
    const executable = join(dir, "gh");
    await Bun.write(
      executable,
      '#!/bin/sh\nprintf "%s\\n" "$GH_PROMPT_DISABLED" "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "$GH_PAGER"\ncat\n',
    );
    await chmod(executable, 0o755);
    const gh = createRealGhClient();
    const env = { PATH: `${dir}:${process.env.PATH}` };
    const absent = await gh.run(["api"], { env });
    expect(absent.exitCode).toBe(0);
    expect(absent.stdout).toBe("1\n0\nfalse\ncat\n");
    const supplied = await gh.run(["api"], { env, stdin: "body\nwith λ" });
    expect(supplied.stdout).toBe("1\n0\nfalse\ncat\nbody\nwith λ");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default SSH uses batch authentication without replacing configured commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spry-ssh-input-"));
  try {
    const log = join(dir, "ssh-args");
    const executable = join(dir, "ssh");
    const config = join(dir, "gitconfig");
    await Bun.write(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SPRY_SSH_ARGS"\nexit 1\n');
    await chmod(executable, 0o755);
    await Bun.write(config, "");
    const env = {
      PATH: `${dir}:${process.env.PATH}`,
      SPRY_SSH_ARGS: log,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = createRealGitRunner();
    await git.run(["ls-remote", "ssh://example.invalid/repo"], { cwd: dir, env });
    expect(await Bun.file(log).text()).toContain("-oBatchMode=yes\n");
    await Bun.write(config, "[core]\nsshCommand = ssh -oIdentityFile=custom-key\n");
    await git.run(["ls-remote", "ssh://example.invalid/repo"], { cwd: dir, env });
    const configured = await Bun.file(log).text();
    expect(configured).toContain("-oIdentityFile=custom-key\n");
    expect(configured).not.toContain("-oBatchMode=yes\n");
    await git.run(["ls-remote", "ssh://example.invalid/repo"], {
      cwd: dir,
      env: { ...env, GIT_SSH_COMMAND: "ssh -oIdentityFile=env-key" },
    });
    expect(await Bun.file(log).text()).toContain("-oIdentityFile=env-key\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
