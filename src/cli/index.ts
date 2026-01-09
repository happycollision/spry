#!/usr/bin/env bun
import { Command, Option } from "commander";
import { viewCommand } from "./commands/view.ts";
import { syncCommand } from "./commands/sync.ts";
import { landCommand } from "./commands/land.ts";
import { cleanCommand } from "./commands/clean.ts";
import { groupCommand, dissolveCommand } from "./commands/group.ts";
import packageJson from "../../package.json";

const program = new Command();

program
  .name("taspr")
  .description("CLI tool for managing stacked PRs on GitHub")
  .version(packageJson.version);

program
  .command("view")
  .description("View the current stack of commits")
  .option("--all", "Show all PRs authored by the current user")
  .addOption(
    (() => {
      const opt = new Option("--mock", "Use mock PR data for testing display");
      return process.env.NODE_ENV === "development" ? opt : opt.hideHelp();
    })(),
  )
  .action((options) => viewCommand(options));

program
  .command("sync")
  .description("Sync stack with GitHub: add IDs, push branches, and optionally create PRs")
  .option("--open", "Create PRs for branches that don't have them")
  .option(
    "--apply <json>",
    "Only open PRs for specified commits/groups (JSON array of identifiers)",
  )
  .option("--up-to <id>", "Only open PRs for commits/groups up to and including this identifier")
  .option("-i, --interactive", "Interactively select which commits/groups to open PRs for")
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

// Group command with subcommands
const groupCmd = program.command("group").description("Manage commit groups");

// Default action (no subcommand) - launches the TUI or applies a spec
groupCmd
  .option("--apply <json>", "Apply a group spec (JSON format) non-interactively")
  .option(
    "--fix [mode]",
    "Repair invalid group trailers (interactive by default, 'dissolve' for non-interactive)",
  )
  .action((options) => groupCommand(options));

// Dissolve subcommand
groupCmd
  .command("dissolve")
  .description("Remove group trailers from commits")
  .argument("[group-id]", "ID of the group to dissolve (optional, lists groups if omitted)")
  .option(
    "--inherit <commit>",
    "Commit (hash or index 1-N) to inherit the group's PR when dissolving",
  )
  .option("--no-inherit", "Explicitly don't inherit the PR to any commit")
  .action((groupId: string | undefined, options: { inherit?: string | boolean }) =>
    dissolveCommand(groupId, options),
  );

program.parse();
