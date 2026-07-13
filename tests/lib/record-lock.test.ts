import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { rm, mkdir, writeFile, stat } from "node:fs/promises";
import { withRecordLock, __lockDirFor } from "./record-lock.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/record-lock");

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("runs the body and returns its result", async () => {
  const result = await withRecordLock("alpha", { dir: tmpDir }, async () => "done");
  expect(result).toBe("done");
});

test("releases the lock after the body resolves", async () => {
  await withRecordLock("alpha", { dir: tmpDir }, async () => {});
  const lockDir = __lockDirFor(tmpDir, "alpha");
  const exists = await stat(lockDir).then(
    () => true,
    () => false,
  );
  expect(exists).toBe(false);
});

test("releases the lock even when the body throws", async () => {
  const boom = new Error("boom");
  await expect(
    withRecordLock("alpha", { dir: tmpDir }, async () => {
      throw boom;
    }),
  ).rejects.toThrow("boom");
  const lockDir = __lockDirFor(tmpDir, "alpha");
  const exists = await stat(lockDir).then(
    () => true,
    () => false,
  );
  expect(exists).toBe(false);
});

test("serializes concurrent holders of the same key", async () => {
  const events: string[] = [];
  const hold = (label: string, ms: number) =>
    withRecordLock("shared", { dir: tmpDir, pollMs: 5 }, async () => {
      events.push(`enter:${label}`);
      await Bun.sleep(ms);
      events.push(`exit:${label}`);
    });

  await Promise.all([hold("A", 30), hold("B", 30)]);

  // Whichever entered first must fully exit before the other enters — no
  // interleaving of enter/exit pairs.
  const firstEnter = events[0] ?? "";
  const firstLabel = firstEnter.split(":")[1];
  expect(events[1]).toBe(`exit:${firstLabel}`);
});

test("different keys do not block each other", async () => {
  let bothInside = false;
  const a = withRecordLock("k1", { dir: tmpDir, pollMs: 5 }, async () => {
    await Bun.sleep(20);
    bothInside = true;
  });
  const b = withRecordLock("k2", { dir: tmpDir, pollMs: 5 }, async () => {
    await Bun.sleep(20);
  });
  await Promise.all([a, b]);
  expect(bothInside).toBe(true);
});

test("breaks a stale lock left by a dead holder", async () => {
  const lockDir = __lockDirFor(tmpDir, "stale");
  await mkdir(lockDir, { recursive: true });
  // A meta file naming a PID that cannot be alive.
  await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: 2147483646, ts: 1 }));

  // Should reclaim the stale lock rather than hang.
  const result = await withRecordLock(
    "stale",
    { dir: tmpDir, pollMs: 5, staleMs: 10 },
    async () => "reclaimed",
  );
  expect(result).toBe("reclaimed");
});
