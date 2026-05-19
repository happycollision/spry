#!/usr/bin/env bun
import { syncCommand } from "../../src/commands/sync.ts";
import { createRealGitRunner } from "../lib/index.ts";
import type { GhClient, CommandOptions, CommandResult, SpryContext } from "../lib/index.ts";

const cwd = process.argv[2];
if (!cwd) {
  console.error("Usage: sync-tui-harness.ts <repo-cwd>");
  process.exit(1);
}

const gh: GhClient = {
  async run(args: string[], _opts?: CommandOptions): Promise<CommandResult> {
    if (args[0] === "pr" && args[1] === "create") {
      return { stdout: "https://github.com/owner/repo/pull/42\n", stderr: "", exitCode: 0 };
    }
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

await syncCommand(ctx, { cwd, open: null });
