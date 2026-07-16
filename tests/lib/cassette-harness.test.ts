import { test, expect } from "bun:test";
import { join } from "node:path";
import { cassettePath, cassetteEnv, cassetteKey, isRecording } from "./cassette-harness.ts";

const CASSETTES_DIR = join(import.meta.dir, "../fixtures/cassettes");

test("cassetteKey sanitizes section + zero-pads order", () => {
  expect(cassetteKey({ section: "commands/sync", order: 20 })).toBe("commands__sync--020");
});

test("cassetteKey is the single source cassettePath derives from", () => {
  // setupDocRepo (tests/lib/doc-repo.ts) also calls cassetteKey directly to
  // derive its per-test namespace, so this equality is what keeps the
  // namespace and the cassette filename provably in sync.
  const key = cassetteKey({ section: "commands/sync", order: 20 });
  expect(cassettePath({ section: "commands/sync", order: 20 })).toBe(
    join(CASSETTES_DIR, `${key}.json`),
  );
});

test("cassetteKey never collides for different sections sharing a leaf", () => {
  expect(cassetteKey({ section: "commands/sync", order: 20 })).not.toBe(
    cassetteKey({ section: "tui/sync", order: 20 }),
  );
});

test("cassettePath keys section + zero-padded order under fixtures/cassettes", () => {
  expect(cassettePath({ section: "commands/sync", order: 20 })).toBe(
    join(CASSETTES_DIR, "commands__sync--020.json"),
  );
});

test("cassettePath returns an absolute path", () => {
  const p = cassettePath({ section: "commands/sync", order: 20 });
  expect(p.startsWith("/")).toBe(true);
});

test("cassetteEnv defaults to replay (SPRY_GH_CASSETTE)", () => {
  const saved = process.env.SPRY_RECORD;
  delete process.env.SPRY_RECORD;
  try {
    const env = cassetteEnv({ section: "commands/sync", order: 20 });
    expect(env).toEqual({
      SPRY_GH_CASSETTE: cassettePath({ section: "commands/sync", order: 20 }),
    });
  } finally {
    if (saved === undefined) delete process.env.SPRY_RECORD;
    else process.env.SPRY_RECORD = saved;
  }
});

test("cassetteEnv records (SPRY_GH_CASSETTE_RECORD) when SPRY_RECORD=1", () => {
  const saved = process.env.SPRY_RECORD;
  process.env.SPRY_RECORD = "1";
  try {
    const env = cassetteEnv({ section: "commands/sync", order: 20 });
    expect(env).toEqual({
      SPRY_GH_CASSETTE_RECORD: cassettePath({ section: "commands/sync", order: 20 }),
    });
  } finally {
    if (saved === undefined) delete process.env.SPRY_RECORD;
    else process.env.SPRY_RECORD = saved;
  }
});

test("isRecording reflects SPRY_RECORD env", () => {
  const saved = process.env.SPRY_RECORD;
  try {
    process.env.SPRY_RECORD = "1";
    expect(isRecording()).toBe(true);
    delete process.env.SPRY_RECORD;
    expect(isRecording()).toBe(false);
    process.env.SPRY_RECORD = "0";
    expect(isRecording()).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.SPRY_RECORD;
    else process.env.SPRY_RECORD = saved;
  }
});
