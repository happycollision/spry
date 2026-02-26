import { test, expect } from "bun:test";
import { createTerminalDriver } from "./terminal-driver.ts";

test("captures output from a simple command", async () => {
  const term = await createTerminalDriver("echo", ["Hello from PTY"], {
    cols: 80,
    rows: 24,
  });

  await term.waitForText("Hello from PTY", { timeout: 2000 });
  const screen = term.capture();
  expect(screen.text).toContain("Hello from PTY");

  await term.close();
});

test("type sends keystrokes to the process", async () => {
  // Use cat which echoes input back
  const term = await createTerminalDriver("cat", [], {
    cols: 80,
    rows: 24,
  });

  await Bun.sleep(100); // let cat start
  term.type("hello");
  await term.waitForText("hello", { timeout: 2000 });

  const screen = term.capture();
  expect(screen.text).toContain("hello");

  // Send Ctrl+D to close cat
  term.type("\x04");
  await term.close();
});

test("press sends named keys", async () => {
  const term = await createTerminalDriver("cat", [], {
    cols: 80,
    rows: 24,
  });

  await Bun.sleep(100);
  term.press("a");
  term.press("b");
  term.press("c");
  await term.waitForText("abc", { timeout: 2000 });

  term.type("\x04");
  await term.close();
});

test("waitForText times out if text never appears", async () => {
  const term = await createTerminalDriver("echo", ["something else"], {
    cols: 80,
    rows: 24,
  });

  await expect(
    term.waitForText("this will never appear", { timeout: 500 }),
  ).rejects.toThrow(/timeout/i);

  await term.close();
});
