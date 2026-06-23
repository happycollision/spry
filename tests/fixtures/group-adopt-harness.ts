#!/usr/bin/env bun
// Drives `sp group` through the gh cassette seam so the PR-adoption lookup
// (findPRsForBranches) records/replays real `gh` traffic. The default
// group-tui-harness stubs gh with empty PR nodes and never reaches adoption;
// this one wires the seam exactly like sync-tui-harness.ts.
import { groupCommand } from "../../src/commands/group.ts";
import { createRealGitRunner, createSeamedGhClient } from "../lib/index.ts";
import type { SpryContext } from "../lib/index.ts";

const cwd = process.argv[2];
if (!cwd) {
  console.error("Usage: group-adopt-harness.ts <repo-cwd>");
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
  await groupCommand(ctx, { cwd });
} finally {
  await flush();
}
