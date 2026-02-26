import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createRecordingClient } from "./recording-client.ts";
import { readCassette } from "./cassette.ts";
import type { GitRunner } from "./context.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/cassettes");

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
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
