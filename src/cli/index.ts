#!/usr/bin/env bun
import { Command } from "commander";
import { syncCommand } from "../commands/sync.ts";
import { viewCommand } from "../commands/view.ts";
import { groupCommand } from "../commands/group.ts";
import { rebaseCommand } from "../commands/rebase.ts";
import { landCommand } from "../commands/land.ts";
import { createRealGitRunner, createRealGhClient } from "../lib/context.ts";
import type { GhClient, SpryContext } from "../lib/context.ts";
import { createReplayingClient } from "../lib/replaying-client.ts";
import { createRecordingClient } from "../lib/recording-client.ts";
import type { RecordingClient } from "../lib/recording-client.ts";

const program = new Command();

program.name("sp").description("Spry: Stacked PRs. Develop with alacrity.");

let recorder: RecordingClient | undefined;
let gh: GhClient = createRealGhClient();
if (process.env.SPRY_GH_CASSETTE_RECORD) {
  recorder = createRecordingClient(gh, process.env.SPRY_GH_CASSETTE_RECORD);
  gh = recorder;
} else if (process.env.SPRY_GH_CASSETTE) {
  gh = await createReplayingClient(process.env.SPRY_GH_CASSETTE, { match: "args" });
}

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

try {
  await program.parseAsync();
} finally {
  if (recorder) await recorder.flush();
}
