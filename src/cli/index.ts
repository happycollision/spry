#!/usr/bin/env bun
import { Command } from "commander";
import { viewCommand } from "../commands/view.ts";
import { createRealGitRunner } from "../lib/context.ts";
import type { SpryContext } from "../lib/context.ts";

const program = new Command();

program.name("sp").description("Spry: Stacked PRs. Develop with alacrity.");

const ctx: SpryContext = {
  git: createRealGitRunner(),
  gh: { run: async () => ({ stdout: "", stderr: "", exitCode: 1 }) },
};

program
  .command("view")
  .description("View the current stack of commits")
  .action(() => viewCommand(ctx));

program.parse();
