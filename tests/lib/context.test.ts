import { test, expect } from "bun:test";
import { toStdinBuffer } from "../../src/lib/context.ts";

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

test("toStdinBuffer returns undefined when stdin is undefined (inherit)", () => {
  expect(toStdinBuffer(undefined)).toBeUndefined();
});

// Regression for the `sp sync --open` hang: a command run with EMPTY stdin must
// receive a real EOF, not inherit the parent's stdin. We run the git runner with
// `stdin: ""` against a stdin-reading command (`git hash-object --stdin`) inside
// a child whose own stdin is an open pipe that never reaches EOF. If empty stdin
// were inherited instead of fed as bytes, the child would block forever. (This
// is exactly what `gh ... --body-file -` did when the PR body was empty.)
test("empty stdin is fed as EOF, not inherited from a non-EOF parent", async () => {
  const contextPath = new URL("../../src/lib/context.ts", import.meta.url).pathname;
  const program =
    `import { createRealGitRunner } from ${JSON.stringify(contextPath)};` +
    `const r = await createRealGitRunner().run(["hash-object", "--stdin"], { stdin: "" });` +
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

  expect(out).toBe(`OUT:${EMPTY_BLOB_SHA}`);
});
