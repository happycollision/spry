import { $ } from "bun";
import { join } from "node:path";

// Skip these tests unless explicitly enabled
export const SKIP_GITHUB_TESTS = !process.env.GITHUB_INTEGRATION_TESTS;

// Skip CI-dependent tests unless explicitly enabled
export const SKIP_CI_TESTS = !process.env.GITHUB_CI_TESTS;

// Helper to run taspr commands in a directory
export async function runTaspr(
  cwd: string,
  command: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result =
    await $`bun run ${join(import.meta.dir, "../../src/cli/index.ts")} ${command} ${args}`
      .cwd(cwd)
      .nothrow()
      .quiet();
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

// Helper to run taspr sync in a directory
export async function runSync(
  cwd: string,
  options: { open?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = options.open ? ["--open"] : [];
  return runTaspr(cwd, "sync", args);
}

// Helper to run taspr land in a directory
export async function runLand(
  cwd: string,
  options: { all?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = options.all ? ["--all"] : [];
  return runTaspr(cwd, "land", args);
}

// Helper to run taspr clean in a directory
export async function runClean(
  cwd: string,
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args: string[] = [];
  if (options.dryRun) args.push("--dry-run");
  if (options.force) args.push("--force");
  return runTaspr(cwd, "clean", args);
}
