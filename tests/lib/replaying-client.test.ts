import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createReplayingClient } from "./replaying-client.ts";
import { writeCassette } from "./cassette.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/cassettes");

// Wipe the shared tmp dir once per file (not per test): per-test hooks race
// under --concurrent. Each test uses a unique cassette filename within it.
beforeAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
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
    entries: [{ args: ["status"], result: { stdout: "clean", stderr: "", exitCode: 0 } }],
  });

  const client = await createReplayingClient(cassettePath);
  await client.run(["status"]); // consumes the one entry

  await expect(client.run(["log"])).rejects.toThrow(/no more recorded entries/i);
});

test("throws if cassette file does not exist", async () => {
  await expect(createReplayingClient(join(tmpDir, "nonexistent.json"))).rejects.toThrow();
});

test("throws if args don't match recorded entry", async () => {
  const cassettePath = join(tmpDir, "mismatch.json");
  await writeCassette(cassettePath, {
    entries: [{ args: ["status"], result: { stdout: "clean", stderr: "", exitCode: 0 } }],
  });

  const client = await createReplayingClient(cassettePath);
  await expect(client.run(["log"])).rejects.toThrow(/mismatch/i);
});

test("match:args consumes the entry whose args+stdin match, order-independent", async () => {
  const cassettePath = join(tmpDir, "args.json");
  await writeCassette(cassettePath, {
    entries: [
      { args: ["pr", "list"], result: { stdout: "L", stderr: "", exitCode: 0 } },
      {
        args: ["pr", "create"],
        options: { stdin: "body-A" },
        result: { stdout: "A", stderr: "", exitCode: 0 },
      },
      {
        args: ["pr", "create"],
        options: { stdin: "body-B" },
        result: { stdout: "B", stderr: "", exitCode: 0 },
      },
    ],
  });
  const client = await createReplayingClient(cassettePath, { match: "args" });
  expect((await client.run(["pr", "create"], { stdin: "body-B" })).stdout).toBe("B");
  expect((await client.run(["pr", "create"], { stdin: "body-A" })).stdout).toBe("A");
  expect((await client.run(["pr", "list"])).stdout).toBe("L");
});

test("match:args throws when no unconsumed entry matches", async () => {
  const cassettePath = join(tmpDir, "nomatch.json");
  await writeCassette(cassettePath, {
    entries: [{ args: ["pr", "list"], result: { stdout: "", stderr: "", exitCode: 0 } }],
  });
  const client = await createReplayingClient(cassettePath, { match: "args" });
  await expect(client.run(["pr", "view"])).rejects.toThrow(/no matching/i);
});
