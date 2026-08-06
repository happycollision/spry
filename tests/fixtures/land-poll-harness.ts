#!/usr/bin/env bun
import { landCommand } from "../../src/commands/land.ts";
import { createRealGitRunner, createSeamedGhClient, isRecording } from "../lib/index.ts";
import type { SpryContext } from "../lib/index.ts";

const cwd = process.argv[2];
const through = process.argv[3];
if (!cwd || !through) {
  console.error("Usage: land-poll-harness.ts <repo-cwd> <through-id>");
  process.exit(1);
}

// gh is wired to the cassette seam (record/replay selected by env), exactly
// like land-tui-harness.ts. Here the loop is non-interactive `--poll`, not the
// TUI picker.
const { gh, flush } = await createSeamedGhClient();

const runner = createRealGitRunner();
const ctx: SpryContext = {
  git: {
    run: (args: string[], opts?: { cwd?: string }) =>
      runner.run(args, { ...opts, cwd: opts?.cwd ?? cwd }),
  },
  gh,
};

// The doc test passes the SAME interval in both record and replay, so the
// banner text ("polling every Ns…") captured into the doc is identical either
// way. In record mode this number also spaces the real polls apart (so CI moves
// between them); in replay it is banner-only, because what actually makes replay
// instant is `sleep` below — gated on record vs. replay, NOT on this number.
const intervalSeconds = Number(process.env.SPRY_POLL_INTERVAL ?? "0");

// Record: really wait out the interval between polls, so each poll is a
// distinct real `gh` call spaced far enough apart for CI to move. Replay:
// no-op — the recorded sequence of responses is served instantly, so offline
// playback of a multi-poll loop costs no wall-clock.
const recording = isRecording();
const sleep = recording
  ? (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000))
  : async (_seconds: number) => {};

try {
  await landCommand(ctx, {
    cwd,
    through,
    poll: true,
    interval: intervalSeconds,
    sleep,
  });
} finally {
  await flush();
}
