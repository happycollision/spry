#!/usr/bin/env bun
import { Command } from "commander";
import { viewCommand } from "../commands/view.ts";
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
  .option("--no-fetch", "Skip GitHub enrichment (local view only)")
  .action((opts: { fetch: boolean }) => viewCommand(ctx, { noFetch: !opts.fetch }));

program.parse();
