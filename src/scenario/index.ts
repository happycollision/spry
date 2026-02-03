#!/usr/bin/env bun
/**
 * Interactive scenario runner entry point.
 *
 * Usage: bun run scenario
 */

import { runScenarioRunner } from "./runner.ts";

runScenarioRunner().catch((err) => {
  console.error("Scenario runner failed:", err);
  process.exit(1);
});
