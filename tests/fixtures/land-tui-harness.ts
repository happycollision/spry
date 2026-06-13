#!/usr/bin/env bun
import { landCommand } from "../../src/commands/land.ts";
import { createRealGitRunner } from "../lib/index.ts";
import type { GhClient, CommandOptions, CommandResult, SpryContext } from "../lib/index.ts";

const cwd = process.argv[2];
if (!cwd) {
  console.error("Usage: land-tui-harness.ts <repo-cwd>");
  process.exit(1);
}

// Stub gh: every branch has an OPEN PR based on main with no checks/threads, and
// `pr edit` (retarget) succeeds. This is the readiness="land" shape.
const gh: GhClient = {
  async run(args: string[], _opts?: CommandOptions): Promise<CommandResult> {
    if (args[0] === "pr" && args[1] === "edit") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "pr" && args[1] === "create") {
      return { stdout: "https://github.com/owner/repo/pull/42\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      const branchArg = args.find((a) => a.startsWith("branch="));
      const branch = branchArg?.slice("branch=".length) ?? "";
      const prByBranch: Record<string, number> = {
        "spry/dondenton/aaa11111": 1,
        "spry/dondenton/bbb22222": 2,
      };
      const number = prByBranch[branch];
      if (number === undefined) {
        return {
          stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }),
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number,
                    url: `https://github.com/owner/repo/pull/${number}`,
                    state: "OPEN",
                    title: branch,
                    baseRefName: "main",
                    reviewDecision: null,
                    reviewThreads: { totalCount: 0, nodes: [] },
                    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                  },
                ],
              },
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, exitCode: 1 };
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

// No `through` — the real single-select picker runs.
await landCommand(ctx, { cwd });
