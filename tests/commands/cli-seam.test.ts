import { test, expect } from "bun:test";
import { join } from "node:path";
import { createRunner } from "../lib/index.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const runSp = createRunner(cliPath);

test("unset cassette env: --help works unchanged", async () => {
  const { result } = await runSp(process.cwd(), "--help");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Spry");
});
