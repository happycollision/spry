import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createRealGitRunner } from "./git-runner.ts";
import { createRecordingClient } from "./recording-client.ts";
import { createReplayingClient } from "./replaying-client.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/integration");

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("record then replay produces identical results", async () => {
  const cassettePath = join(tmpDir, "git-version.json");

  // Phase 1: Record
  const realGit = createRealGitRunner();
  const recorder = createRecordingClient(realGit, cassettePath);

  const recordedResult = await recorder.run(["--version"]);
  await recorder.flush();

  // Phase 2: Replay
  const replayer = await createReplayingClient(cassettePath);
  const replayedResult = await replayer.run(["--version"]);

  // Results should be identical
  expect(replayedResult.stdout).toBe(recordedResult.stdout);
  expect(replayedResult.stderr).toBe(recordedResult.stderr);
  expect(replayedResult.exitCode).toBe(recordedResult.exitCode);
});
