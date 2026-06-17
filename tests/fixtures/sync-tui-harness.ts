#!/usr/bin/env bun
import { syncCommand } from "../../src/commands/sync.ts";
import { createRealGitRunner, createSeamedGhClient } from "../lib/index.ts";
import type { SpryContext } from "../lib/index.ts";

const cwd = process.argv[2];
if (!cwd) {
  console.error("Usage: sync-tui-harness.ts <repo-cwd>");
  process.exit(1);
}

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
  await syncCommand(ctx, { cwd, open: null });
} finally {
  await flush();
}
