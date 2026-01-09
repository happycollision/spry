/**
 * Interactive scenario runner.
 *
 * Presents a menu of scenarios, creates the selected repo,
 * spawns a shell in the repo directory with sp (spry) in PATH,
 * and cleans up on exit.
 *
 * Usage:
 *   bun run scenario              # Interactive menu
 *   bun run scenario <name>       # Direct selection (e.g., "multi-commit-stack")
 */

import { scenarioList, type ScenarioDefinition } from "./definitions.ts";
import { createLocalRepo, type LocalRepo } from "./core.ts";
import { generateUniqueId } from "../../tests/helpers/unique-id.ts";
import { dirname, join } from "node:path";

/**
 * Find a scenario by name (exact or partial match).
 */
function findScenarioByName(name: string): ScenarioDefinition | null {
  // Try exact match first
  const exact = scenarioList.find((s) => s.name === name);
  if (exact) return exact;

  // Try partial match
  const partial = scenarioList.find((s) => s.name.includes(name));
  return partial ?? null;
}

/**
 * Display the scenario menu and get user selection.
 */
async function selectScenario(): Promise<ScenarioDefinition | null> {
  console.log("Select a scenario:\n");

  scenarioList.forEach((scenario, index) => {
    console.log(`  ${index + 1}. ${scenario.name}`);
    console.log(`     ${scenario.description}\n`);
  });

  console.log("  q. Quit\n");

  process.stdout.write("Enter selection: ");

  for await (const line of console) {
    const input = line.trim().toLowerCase();

    if (input === "q") return null;

    const num = parseInt(input, 10);
    if (num >= 1 && num <= scenarioList.length) {
      return scenarioList[num - 1] ?? null;
    }

    process.stdout.write("Invalid selection. Enter selection: ");
  }

  return null;
}

/**
 * Get the path to the spry dist directory.
 */
function getSpryPath(): string {
  // This file is at src/scenario/runner.ts
  // Project root is two directories up
  const projectRoot = dirname(dirname(dirname(import.meta.path)));
  return join(projectRoot, "dist");
}

/**
 * Spawn a shell in the scenario directory with sp (spry) in PATH.
 */
async function spawnShell(repo: LocalRepo, scenarioName: string): Promise<void> {
  const spryPath = getSpryPath();

  console.log("\n" + "=".repeat(60));
  console.log(`Scenario: ${scenarioName}`);
  console.log(`Repo path: ${repo.path}`);
  console.log(`Origin path: ${repo.originPath}`);
  console.log(`Unique ID: ${repo.uniqueId}`);
  console.log("=".repeat(60));
  console.log("\nEntering shell. Type 'exit' to clean up and quit.\n");

  // Get the user's preferred shell
  const shell = process.env.SHELL || "/bin/bash";

  // Use exec to replace the current process with the shell
  // This properly transfers TTY control to the new shell
  const { spawnSync } = await import("node:child_process");
  spawnSync(shell, ["-i"], {
    cwd: repo.path,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${spryPath}:${process.env.PATH}`,
    },
  });
}

/**
 * Print help/usage information.
 */
function printHelp(): void {
  console.log(`Usage: bun run scenario [<name>]

Spin up a temporary git repo with a pre-configured scenario for testing.
Spawns a shell in the repo with 'sp' in PATH. Cleans up on exit.

Arguments:
  <name>    Scenario name (optional - shows interactive menu if omitted)

Available scenarios:`);
  for (const s of scenarioList) {
    console.log(`  ${s.name.padEnd(20)} ${s.description}`);
  }
  console.log(`
See src/scenario/definitions.ts for scenario details and test usage.`);
}

/**
 * Main entry point for the scenario runner.
 */
export async function runScenarioRunner(): Promise<void> {
  // Check for CLI argument
  const arg = process.argv[2];
  let scenario: ScenarioDefinition | null = null;

  if (arg === "--help" || arg === "-h") {
    printHelp();
    return;
  }

  if (arg) {
    scenario = findScenarioByName(arg);
    if (!scenario) {
      console.error(`Unknown scenario: ${arg}\n`);
      printHelp();
      process.exit(1);
    }
  } else {
    scenario = await selectScenario();
  }

  if (!scenario) {
    console.log("\nNo scenario selected. Exiting.");
    return;
  }

  console.log(`\nSetting up scenario: ${scenario.name}...`);

  const ctx = {
    uniqueId: generateUniqueId(),
    scenarioName: scenario.name,
  };

  const repo = await createLocalRepo(ctx, { scenarioName: scenario.name });

  // Set up cleanup handlers
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    console.log("\nCleaning up scenario...");
    await repo.cleanup();
    console.log("Done.");
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  try {
    // Run scenario setup
    await scenario.setup(repo);

    // Spawn shell
    await spawnShell(repo, scenario.name);
  } finally {
    await cleanup();
  }
}
