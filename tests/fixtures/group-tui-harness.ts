#!/usr/bin/env bun
import { groupCommand } from "../../src/commands/group.ts";
import { createRealGitRunner } from "../lib/index.ts";
import type { GhClient, CommandOptions, CommandResult, SpryContext } from "../lib/index.ts";

const cwd = process.argv[2];
if (!cwd) {
  console.error("Usage: group-tui-harness.ts <repo-cwd>");
  process.exit(1);
}

const gh: GhClient = {
  async run(_args: string[], _opts?: CommandOptions): Promise<CommandResult> {
    return {
      stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
      stderr: "",
      exitCode: 0,
    };
  },
};

const runner = createRealGitRunner();
const ctx: SpryContext = {
  git: {
    run: (args: string[], opts?: { cwd?: string }) =>
      runner.run(args, { ...opts, cwd: opts?.cwd ?? cwd }),
  },
  gh,
};

await groupCommand(ctx, { cwd });
