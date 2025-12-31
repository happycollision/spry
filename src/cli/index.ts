#!/usr/bin/env bun
import { Command } from "commander";
import { viewCommand } from "./commands/view.ts";
import { syncCommand } from "./commands/sync.ts";
import { landCommand } from "./commands/land.ts";
import { cleanCommand } from "./commands/clean.ts";

const program = new Command();

program.name("taspr").description("CLI tool for managing stacked PRs on GitHub").version("0.1.0");

program.command("view").description("View the current stack of commits").action(viewCommand);

program
  .command("sync")
  .description("Sync stack with GitHub: add IDs, push branches, and optionally create PRs")
  .option("--open", "Create PRs for branches that don't have them")
  .action((options) => syncCommand(options));

program
  .command("land")
  .description("Merge the bottom ready PR to main")
  .option("--all", "Merge all consecutive ready PRs from the bottom of the stack")
  .action((options) => landCommand(options));

program
  .command("clean")
  .description("Find and remove orphaned branches")
  .option("--dry-run", "Show what would be cleaned without actually deleting")
  .option("--force", "Also delete branches detected by commit-id only (may lose original content)")
  .action((options) => cleanCommand(options));

program
  .command("group")
  .description("Group management commands")
  .argument("<action>", "Action: create, edit, dissolve")
  .action(() => {
    console.log("group command not yet implemented");
  });

program.parse();
