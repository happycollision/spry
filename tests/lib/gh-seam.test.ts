import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createSeamedGhClient } from "./gh-seam.ts";
import { readCassette, writeCassette } from "./cassette.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/gh-seam");

// Wipe the shared tmp dir once per file (not per test): per-test hooks race
// under --concurrent. Each test uses a unique cassette filename within it.
beforeAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("replay mode: serves recorded responses, flush is a no-op", async () => {
  const cassettePath = join(tmpDir, "replay.json");
  await writeCassette(cassettePath, {
    entries: [{ args: ["pr", "view"], result: { stdout: "recorded", stderr: "", exitCode: 0 } }],
  });
  const { gh, flush } = await createSeamedGhClient({ SPRY_GH_CASSETTE: cassettePath });
  const result = await gh.run(["pr", "view"]);
  expect(result.stdout).toBe("recorded");
  await flush(); // must not throw
});

test("record mode: wraps an inner client and flush persists the cassette", async () => {
  const cassettePath = join(tmpDir, "record.json");
  let calls = 0;
  const inner = {
    async run() {
      calls++;
      return { stdout: "live", stderr: "", exitCode: 0 };
    },
  };
  const { gh, flush } = await createSeamedGhClient(
    { SPRY_GH_CASSETTE_RECORD: cassettePath },
    inner,
  );
  await gh.run(["pr", "create"]);
  await flush();
  expect(calls).toBe(1);
  const cassette = await readCassette(cassettePath);
  expect(cassette.entries).toHaveLength(1);
  expect(cassette.entries[0]?.args).toEqual(["pr", "create"]);
});

test("real mode: no cassette env returns a usable client and no-op flush", async () => {
  const inner = {
    async run() {
      return { stdout: "real", stderr: "", exitCode: 0 };
    },
  };
  const { gh, flush } = await createSeamedGhClient({}, inner);
  expect((await gh.run(["--version"])).stdout).toBe("real");
  await flush(); // must not throw
});
