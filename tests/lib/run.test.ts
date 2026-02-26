import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { createRunner } from "./run.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/runner");
const fakeCliPath = join(tmpDir, "fake-cli.ts");

beforeAll(async () => {
  await mkdir(tmpDir, { recursive: true });
  await Bun.write(
    fakeCliPath,
    `
    const args = process.argv.slice(2);
    if (args[0] === "echo") {
      console.log("output: " + args.slice(1).join(" "));
    } else if (args[0] === "fail") {
      console.error("something went wrong");
      process.exit(1);
    } else {
      console.log("unknown command");
    }
    `,
  );
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("returns command string and result", async () => {
  const run = createRunner(fakeCliPath);
  const { command, result } = await run("/tmp", "echo", ["hello", "world"]);

  expect(command).toBe("sp echo hello world");
  expect(result.stdout).toContain("output: hello world");
  expect(result.exitCode).toBe(0);
});

test("captures stderr and non-zero exit code", async () => {
  const run = createRunner(fakeCliPath);
  const { command, result } = await run("/tmp", "fail");

  expect(command).toBe("sp fail");
  expect(result.stderr).toContain("something went wrong");
  expect(result.exitCode).toBe(1);
});

test("command string reflects actual args", async () => {
  const run = createRunner(fakeCliPath);
  const { command } = await run("/tmp", "sync", ["--open", "--all"]);

  expect(command).toBe("sp sync --open --all");
});
