import { describe, test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { createTerminalDriver } from "../lib/index.ts";
import type { TerminalDriver } from "../lib/index.ts";

const harness = join(import.meta.dir, "../../src/tui/select-cli.ts");

const drivers: TerminalDriver[] = [];
afterAll(async () => {
  for (const d of drivers) await d.close().catch(() => {});
});

async function spawn(optionsJson: string): Promise<TerminalDriver> {
  const driver = await createTerminalDriver("bun", [harness, optionsJson], {
    cols: 80,
    rows: 24,
  });
  drivers.push(driver);
  return driver;
}

async function readResult(
  driver: TerminalDriver,
): Promise<{ cancelled: boolean; selectedIds: string[] }> {
  await driver.waitForText("}", { timeout: 5000 });
  const snap = driver.capture();
  const text = snap.text;
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(text.slice(start, end + 1));
}

describe("selectUnits", () => {
  test("Esc cancels", async () => {
    const driver = await spawn(
      JSON.stringify([
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ]),
    );
    await driver.waitForText("Alpha");
    driver.press("Escape");
    const result = await readResult(driver);
    expect(result.cancelled).toBe(true);
    expect(result.selectedIds).toEqual([]);
  });

  test("Space then Enter selects the highlighted item", async () => {
    const driver = await spawn(
      JSON.stringify([
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ]),
    );
    await driver.waitForText("Alpha");
    driver.press("Space");
    driver.press("Enter");
    const result = await readResult(driver);
    expect(result.cancelled).toBe(false);
    expect(result.selectedIds).toEqual(["a"]);
  });

  test("ArrowDown moves cursor; selects second item", async () => {
    const driver = await spawn(
      JSON.stringify([
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
        { id: "c", label: "Charlie" },
      ]),
    );
    await driver.waitForText("Charlie");
    driver.press("ArrowDown");
    driver.press("Space");
    driver.press("Enter");
    const result = await readResult(driver);
    expect(result.selectedIds).toEqual(["b"]);
  });

  test("'a' toggles all", async () => {
    const driver = await spawn(
      JSON.stringify([
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ]),
    );
    await driver.waitForText("Alpha");
    driver.type("a");
    driver.press("Enter");
    const result = await readResult(driver);
    expect(result.selectedIds).toEqual(["a", "b"]);
  });

  test("empty options → cancelled, no waiting", async () => {
    const driver = await spawn("[]");
    const result = await readResult(driver);
    expect(result.cancelled).toBe(true);
    expect(result.selectedIds).toEqual([]);
  });

  test("Ctrl+C cancels", async () => {
    const driver = await spawn(JSON.stringify([{ id: "a", label: "Alpha" }]));
    await driver.waitForText("Alpha");
    driver.press("Ctrl+c");
    const result = await readResult(driver);
    expect(result.cancelled).toBe(true);
  });
});
