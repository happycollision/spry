#!/usr/bin/env bun
import { Command } from "commander";
import { syncCommand } from "../commands/sync.ts";
import { viewCommand } from "../commands/view.ts";
import { groupCommand } from "../commands/group.ts";
import { rebaseCommand } from "../commands/rebase.ts";
import { createRealGitRunner, createRealGhClient } from "../lib/context.ts";
import type { SpryContext } from "../lib/context.ts";

const program = new Command();

program.name("sp").description("Spry: Stacked PRs. Develop with alacrity.");

const ctx: SpryContext = {
  git: createRealGitRunner(),
  gh: createRealGhClient(),
};

program
  .command("view")
  .description("View the current stack of commits with PR status")
  .action(() => viewCommand(ctx));

program
  .command("sync")
  .description("Sync the current stack to GitHub")
  .option("--open [ids]", "Open PRs for selected units (no value = TUI selector)")
  .action((opts: { open?: string | true }) => {
    const open = opts.open === undefined ? undefined : opts.open === true ? null : opts.open;
    return syncCommand(ctx, { open });
  });

program
  .command("group")
  .description("Interactively group and reorder commits")
  .action(() => groupCommand(ctx));

program
  .command("rebase")
  .description("Fetch, check if behind trunk, and rebase the stack if clean")
  .action(() => rebaseCommand(ctx));

program.parse();
