#!/usr/bin/env bun
import { htCommand } from "../commands/ht.ts";
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
import pkg from "../../package.json" with { type: "json" };

/**
 * Parse `--interval <sec>` to a positive number of seconds. Rejects non-numeric,
 * NaN, zero, and negative values — a bad interval would otherwise reach the poll
 * loop as `setTimeout(…, NaN|<=0)` and hot-loop the GitHub API. Throws (caught by
 * the top-level handler, which prints `✗ <message>` and exits 1); returns
 * undefined when the flag is absent so the loop's 30s default applies.
 */
function parseInterval(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--interval must be a positive number of seconds (got "${raw}")`);
  }
  return seconds;
}

const program = new Command();
let requestedInteractive = false;
let requestedNonInteractive = false;

program
  .name("sp")
  .description("Spry: Stacked PRs. Develop with alacrity.")
  .version(pkg.version, "-v, --version", "Output the version number")
  .option("-i, --interactive", "Permit pickers and confirmations (requires a usable terminal)")
  .option("--non-interactive", "Never prompt (default; conflicts with --interactive)")
  .on("option:interactive", () => {
    requestedInteractive = true;
  })
  .on("option:non-interactive", () => {
    requestedNonInteractive = true;
  })
  .configureHelp({ showGlobalOptions: true })
  .addHelpText(
    "after",
    "\nInteraction is opt-in, even in a terminal. SPRY_NON_INTERACTIVE=1 locks it off.",
  )
  .action(() => program.outputHelp());

// Reject retired root commands before parsing their options or creating clients.
// In particular, legacy --help/--version and arbitrary arguments must never
// bypass the migration hint or reach a stack operation.
const legacyCommand = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
if (legacyCommand && ["view", "sync", "group", "rebase", "land", "clean"].includes(legacyCommand)) {
  process.stderr.write(`Use sp stack ${legacyCommand}\n`);
  process.exit(1);
}

const stack = program
  .command("stack")
  .description("Manage stacked pull requests")
  .action(() => stack.outputHelp());

const { gh, flush } = await createSeamedGhClient();

const ctx: SpryContext = {
  git: createRealGitRunner(),
  gh,
};

program.hook("preAction", () => {
  // Track both spellings explicitly: Commander represents a positive flag and
  // its --no counterpart using the same attribute, which otherwise makes the
  // last flag win instead of reporting the conflict.
  if (requestedInteractive && requestedNonInteractive) {
    throw new Error("--interactive and --non-interactive cannot be combined.");
  }
  if (requestedInteractive && process.env.SPRY_NON_INTERACTIVE === "1") {
    throw new Error("--interactive is disabled by SPRY_NON_INTERACTIVE=1.");
  }
  ctx.interactive = requestedInteractive;
});

stack
  .command("view")
  .description("View the current stack of commits with PR status")
  .option("--json", "Emit the stack as machine-readable JSON")
  .action((opts: { json?: boolean }) => viewCommand(ctx, { json: opts.json }));

stack
  .command("sync")
  .description("Sync the current stack to GitHub")
  .option("--open [ids]", "Open PRs for comma-separated IDs; omit IDs only with -i")
  .option("--all", "Push every tracked stack (push-only; cannot combine with --open)")
  .action((opts: { open?: string | true; all?: boolean }) => {
    const open = opts.open === undefined ? undefined : opts.open === true ? null : opts.open;
    return syncCommand(ctx, { open, all: opts.all });
  });

stack
  .command("group")
  .description("Group and reorder commits (--apply for automation; -i for editor)")
  .option(
    "--apply <json>",
    'Apply a grouping doc without prompting ("-" reads piped/redirected JSON)',
  )
  .addHelpText(
    "after",
    '\nRead IDs/schema: sp stack view --json\nExample: sp stack group --apply \'{"stack":[{"type":"commit","id":"<commit-id>"}]}\'\nEditor: sp -i stack group',
  )
  .action((opts: { apply?: string }) => groupCommand(ctx, { apply: opts.apply }));

stack
  .command("rebase")
  .description("Fetch, check if behind trunk, and rebase the stack if clean")
  .option("--all", "Rebase all tracked branches")
  .action((opts: { all?: boolean }) => rebaseCommand(ctx, { all: opts.all }));

stack
  .command("land")
  .description("Land the stack into trunk by fast-forwarding through a chosen commit")
  .option(
    "--through <id>",
    "Land through this group/commit id without prompting (required unless -i)",
  )
  .option(
    "--allow-unresolved-threads",
    "Acknowledge unresolved review threads only; retain other readiness gates",
  )
  .option(
    "--poll",
    "Watch CI and auto-land when the scope goes green (fail fast on a hard blocker)",
  )
  .option("--interval <sec>", "Poll cadence in seconds when --poll is set (default 30)")
  .action(
    (opts: {
      through?: string;
      poll?: boolean;
      interval?: string;
      allowUnresolvedThreads?: boolean;
    }) =>
      landCommand(ctx, {
        through: opts.through,
        poll: opts.poll,
        allowUnresolvedThreads: opts.allowUnresolvedThreads,
        interval: parseInterval(opts.interval),
      }),
  );

stack
  .command("clean")
  .description("Delete remote spry branches whose commits have landed on trunk")
  .option("--dry-run", "List what would be deleted without deleting anything")
  .action((opts: { dryRun?: boolean }) => cleanCommand(ctx, { dryRun: opts.dryRun }));

program
  .command("ht")
  .description("Happy Trees worktree gardening")
  .helpOption(false)
  .allowUnknownOption()
  .argument("[args...]")
  .action((args: string[]) => htCommand(ctx.git, args, ctx.interactive));

try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`✗ ${message}\n`);
  process.exitCode = 1;
} finally {
  await flush();
}
