import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createRecordingClient } from "./recording-client.ts";
import { createReplayingClient } from "./replaying-client.ts";
import { readCassette } from "./cassette.ts";
import type { GitRunner, CommandResult } from "./context.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/cassettes");

// Wipe the shared tmp dir once per file (not per test): per-test hooks race
// under --concurrent. Each test uses a unique cassette filename within it.
beforeAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("records calls and writes cassette file", async () => {
  const inner: GitRunner = {
    async run(args) {
      return { stdout: `ran: ${args.join(" ")}`, stderr: "", exitCode: 0 };
    },
  };

  const cassettePath = join(tmpDir, "test-recording.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["status"]);
  await recording.run(["log", "--oneline"]);
  await recording.flush();

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries).toHaveLength(2);
  expect(cassette.entries[0]!.args).toEqual(["status"]);
  expect(cassette.entries[0]!.result.stdout).toBe("ran: status");
  expect(cassette.entries[1]!.args).toEqual(["log", "--oneline"]);
});

test("persists after each call (survives missing flush / process.exit)", async () => {
  const inner: GitRunner = {
    async run(args) {
      return { stdout: `ran: ${args.join(" ")}`, stderr: "", exitCode: 0 };
    },
  };

  const cassettePath = join(tmpDir, "incremental.json");
  const recording = createRecordingClient(inner, cassettePath);

  // Deliberately do NOT call flush() — simulate a command that process.exit()s.
  await recording.run(["status"]);

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries).toHaveLength(1);
  expect(cassette.entries[0]!.args).toEqual(["status"]);
});

/** Inner client that returns a canned result per call, in order. */
function scriptedInner(results: CommandResult[]): GitRunner {
  let i = 0;
  return {
    async run() {
      const result = results[i];
      if (result === undefined) throw new Error(`scriptedInner: unexpected call ${i}`);
      i++;
      return result;
    },
  };
}

const ok = (stdout: string, stderr = ""): CommandResult => ({ stdout, stderr, exitCode: 0 });

test("persists only stdin from options (drops cwd, env, everything else)", async () => {
  const inner = scriptedInner([ok("a"), ok("b")]);
  const cassettePath = join(tmpDir, "options-stdin-only.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["pr", "create"], {
    cwd: "/tmp/spry-test-123-0",
    env: { A: "1" },
    stdin: "body",
  });
  await recording.run(["status"], { cwd: "/tmp/spry-test-123-0" });
  await recording.flush();

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries[0]!.options).toEqual({ stdin: "body" });
  // No stdin -> no options at all (cwd alone is pure churn, never a match key).
  expect(cassette.entries[1]!.options).toBeUndefined();
  const raw = await Bun.file(cassettePath).text();
  expect(raw).not.toContain("cwd");
  expect(raw).not.toContain("spry-test");
});

test("normalizes a shared PR number to the same value across entries", async () => {
  const inner = scriptedInner([
    ok("https://github.com/happycollision/spry-check/pull/4242\n"),
    ok(
      '{"data":{"repository":{"pullRequests":{"nodes":[{"number":4242,' +
        '"url":"https://github.com/happycollision/spry-check/pull/4242",' +
        '"reviewThreads":{"totalCount":4242}}]}}}}',
    ),
  ]);
  const cassettePath = join(tmpDir, "normalize-shared.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["pr", "create", "--title", "x"]);
  await recording.run(["api", "graphql"]);
  await recording.flush();

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries[0]!.result.stdout).toBe(
    "https://github.com/happycollision/spry-check/pull/1001\n",
  );
  const stdout1 = cassette.entries[1]!.result.stdout;
  expect(stdout1).toContain('"number":1001');
  expect(stdout1).toContain("pull/1001");
  // Anchored patterns only: a bare number in an unrelated field must survive.
  expect(stdout1).toContain('"totalCount":4242');
});

test("seeds the normalization map from stderr", async () => {
  // gh writes some URLs to stderr; a number seen ONLY there must still be
  // discovered, normalized in place, and applied to later stdout mentions.
  const inner = scriptedInner([
    ok("", "Creating PR... https://github.com/o/r/pull/4242\n"),
    ok("https://github.com/o/r/pull/4242\n"),
  ]);
  const cassettePath = join(tmpDir, "normalize-stderr.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["pr", "create", "--title", "x"]);
  await recording.run(["pr", "view", "--json", "url"]);
  await recording.flush();

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries[0]!.result.stderr).toBe(
    "Creating PR... https://github.com/o/r/pull/1001\n",
  );
  expect(cassette.entries[1]!.result.stdout).toBe("https://github.com/o/r/pull/1001\n");
});

test("assigns normalized numbers first-seen without cascading collisions", async () => {
  // Real numbers overlap the normalized range (1001+): the rewrite must be a
  // single simultaneous pass, not sequential replacements that cascade.
  const inner = scriptedInner([
    ok("https://github.com/o/r/pull/1002\n"),
    ok("https://github.com/o/r/pull/1001\n"),
  ]);
  const cassettePath = join(tmpDir, "normalize-collision.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["pr", "create", "--title", "first"]);
  await recording.run(["pr", "create", "--title", "second"]);
  await recording.flush();

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries[0]!.result.stdout).toBe("https://github.com/o/r/pull/1001\n");
  expect(cassette.entries[1]!.result.stdout).toBe("https://github.com/o/r/pull/1002\n");
});

test("normalizes PR numbers appearing as bare args (replay match keys)", async () => {
  // `sp sync` derives `pr edit <n>` args by parsing an earlier entry's stdout,
  // so a recorded bare-numeric arg must be rewritten consistently with stdout —
  // otherwise the args-keyed replayer can never match it.
  const inner = scriptedInner([
    ok("https://github.com/o/r/pull/4242\n"),
    ok("https://github.com/o/r/pull/4242\n"),
  ]);
  const cassettePath = join(tmpDir, "normalize-args.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["pr", "create", "--title", "x"]);
  await recording.run(["pr", "edit", "4242", "--base", "main"]);
  await recording.flush();

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries[1]!.args).toEqual(["pr", "edit", "1001", "--base", "main"]);
});

test("leaves bare numeric args alone when the number was never seen in output", async () => {
  const inner = scriptedInner([ok("no pr numbers here\n")]);
  const cassettePath = join(tmpDir, "normalize-args-unknown.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["pr", "list", "--limit", "100"]);
  await recording.flush();

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries[0]!.args).toEqual(["pr", "list", "--limit", "100"]);
});

test("normalizes PR numbers in recorded stdin", async () => {
  // stdin is a replay match key too; if replay-time code embeds a PR number it
  // parsed from normalized stdout, the recorded stdin must agree.
  const inner = scriptedInner([ok("https://github.com/o/r/pull/4242\n"), ok("updated\n")]);
  const cassettePath = join(tmpDir, "normalize-stdin.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["pr", "create", "--title", "x"]);
  await recording.run(["api", "some/endpoint", "--input", "-"], {
    stdin: '{"number":4242,"body":"see pull/4242"}',
  });
  await recording.flush();

  const cassette = await readCassette(cassettePath);
  expect(cassette.entries[1]!.options).toEqual({
    stdin: '{"number":1001,"body":"see pull/1001"}',
  });
});

test("replay of a normalized cassette matches replay-time derived args", async () => {
  const inner = scriptedInner([
    ok("https://github.com/o/r/pull/4242\n"),
    ok("https://github.com/o/r/pull/4242\n"),
  ]);
  const cassettePath = join(tmpDir, "normalize-replay.json");
  const recording = createRecordingClient(inner, cassettePath);

  await recording.run(["pr", "create", "--title", "x"], { cwd: "/tmp/spry-test-9-9" });
  await recording.run(["pr", "edit", "4242", "--base", "main"]);
  await recording.flush();

  // Replay the way the CLI does: parse the PR number out of the (normalized)
  // create output, then use it to build the next call's args.
  const replay = await createReplayingClient(cassettePath, { match: "args" });
  const created = await replay.run(["pr", "create", "--title", "x"], {
    cwd: "/somewhere/else",
  });
  const number = /pull\/(\d+)/.exec(created.stdout)![1]!;
  expect(number).toBe("1001");
  const edited = await replay.run(["pr", "edit", number, "--base", "main"]);
  expect(edited.stdout).toBe("https://github.com/o/r/pull/1001\n");
});

test("passes through results from inner client", async () => {
  const inner: GitRunner = {
    async run() {
      return { stdout: "hello", stderr: "warn", exitCode: 1 };
    },
  };

  const cassettePath = join(tmpDir, "passthrough.json");
  const recording = createRecordingClient(inner, cassettePath);

  const result = await recording.run(["anything"]);
  expect(result.stdout).toBe("hello");
  expect(result.stderr).toBe("warn");
  expect(result.exitCode).toBe(1);
});
