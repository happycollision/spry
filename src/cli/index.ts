#!/usr/bin/env bun
import { Command } from "commander";
import { syncCommand } from "../commands/sync.ts";
import { viewCommand } from "../commands/view.ts";
import { groupCommand } from "../commands/group.ts";
import { rebaseCommand } from "../commands/rebase.ts";
import { landCommand } from "../commands/land.ts";
import { cleanCommand } from "../commands/clean.ts";
import { createRealGitRunner } from "../lib/context.ts";
import type { SpryContext } from "../lib/context.ts";
import { createSeamedGhClient } from "../lib/gh-seam.ts";

const program = new Command();

program.name("sp").description("Spry: Stacked PRs. Develop with alacrity.");

const { gh, flush } = await createSeamedGhClient();

const ctx: SpryContext = {
  git: createRealGitRunner(),
  gh,
};

program
  .command("view")
  .description("View the current stack of commits with PR status")
  .action(() => viewCommand(ctx));

program
  .command("sync")
  .description("Sync the current stack to GitHub")
  .option("--open [ids]", "Open PRs for selected units (no value = TUI selector)")
  .option("--all", "Push every tracked stack (push-only; cannot combine with --open)")
  .action((opts: { open?: string | true; all?: boolean }) => {
    const open = opts.open === undefined ? undefined : opts.open === true ? null : opts.open;
    return syncCommand(ctx, { open, all: opts.all });
  });

program
  .command("group")
  .description("Interactively group and reorder commits")
  .action(() => groupCommand(ctx));

program
  .command("rebase")
  .description("Fetch, check if behind trunk, and rebase the stack if clean")
  .option("--all", "Rebase all tracked branches")
  .action((opts: { all?: boolean }) => rebaseCommand(ctx, { all: opts.all }));

program
  .command("land")
  .description("Land the stack into trunk by fast-forwarding through a chosen commit")
  .option("--through <id>", "Land from the bottom through this group/commit id")
  .action((opts: { through?: string }) => landCommand(ctx, { through: opts.through }));

program
  .command("clean")
  .description("Delete remote spry branches whose commits have landed on trunk")
  .option("--dry-run", "List what would be deleted without deleting anything")
  .action((opts: { dryRun?: boolean }) => cleanCommand(ctx, { dryRun: opts.dryRun }));

try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✗ ${message}`);
  process.exitCode = 1;
} finally {
  await flush();
}
