import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createReplayingClient } from "./replaying-client.ts";
import { writeCassette } from "./cassette.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/cassettes");

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("replays recorded responses in order", async () => {
  const cassettePath = join(tmpDir, "replay.json");
  await writeCassette(cassettePath, {
    entries: [
      { args: ["status"], result: { stdout: "clean", stderr: "", exitCode: 0 } },
      { args: ["log"], result: { stdout: "abc123 Initial", stderr: "", exitCode: 0 } },
    ],
  });

  const client = await createReplayingClient(cassettePath);

  const r1 = await client.run(["status"]);
  expect(r1.stdout).toBe("clean");

  const r2 = await client.run(["log"]);
  expect(r2.stdout).toBe("abc123 Initial");
});

test("throws if more calls than recorded entries", async () => {
  const cassettePath = join(tmpDir, "short.json");
  await writeCassette(cassettePath, {
    entries: [
      { args: ["status"], result: { stdout: "clean", stderr: "", exitCode: 0 } },
    ],
  });

  const client = await createReplayingClient(cassettePath);
  await client.run(["status"]); // consumes the one entry

  expect(client.run(["log"])).rejects.toThrow(/no more recorded entries/i);
});

test("throws if cassette file does not exist", async () => {
  expect(createReplayingClient(join(tmpDir, "nonexistent.json"))).rejects.toThrow();
});

test("throws if args don't match recorded entry", async () => {
  const cassettePath = join(tmpDir, "mismatch.json");
  await writeCassette(cassettePath, {
    entries: [
      { args: ["status"], result: { stdout: "clean", stderr: "", exitCode: 0 } },
    ],
  });

  const client = await createReplayingClient(cassettePath);
  expect(client.run(["log"])).rejects.toThrow(/mismatch/i);
});
