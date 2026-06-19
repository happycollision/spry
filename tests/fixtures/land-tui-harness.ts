#!/usr/bin/env bun
import { landCommand } from "../../src/commands/land.ts";
import { createRealGitRunner, createSeamedGhClient } from "../lib/index.ts";
import type { SpryContext } from "../lib/index.ts";

const cwd = process.argv[2];
if (!cwd) {
  console.error("Usage: land-tui-harness.ts <repo-cwd>");
  process.exit(1);
}

// gh is wired to the cassette seam (record/replay selected by env). The TUI
// picker runs for real; the gh traffic is recorded against spry-check and
// replayed offline. Mirrors tests/fixtures/sync-tui-harness.ts.
const { gh, flush } = await createSeamedGhClient();

const runner = createRealGitRunner();
const ctx: SpryContext = {
  git: {
    run: (args: string[], opts?: { cwd?: string }) =>
      runner.run(args, { ...opts, cwd: opts?.cwd ?? cwd }),
  },
  gh,
};

try {
  // No `through` — the real single-select picker runs.
  await landCommand(ctx, { cwd });
} finally {
  await flush();
}
