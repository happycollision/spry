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

  // May throw "Timeout" (process still running) or "Process exited" (exited early)
  await expect(term.waitForText("this will never appear", { timeout: 500 })).rejects.toThrow(
    /timeout|process exited/i,
  );

  await term.close();
});

test("waitForExit resolves with the exit code once the process exits on its own", async () => {
  const term = await createTerminalDriver("echo", ["Hello from PTY"], {
    cols: 80,
    rows: 24,
  });

  const code = await term.waitForExit();
  expect(code).toBe(0);
});

test("waitForExit still allows capture() to read the rendered screen after exit", async () => {
  const term = await createTerminalDriver("echo", ["Hello from PTY"], {
    cols: 80,
    rows: 24,
  });

  await term.waitForExit();
  const screen = term.capture();
  expect(screen.text).toContain("Hello from PTY");
});

test("waitForExit throws with a screen dump on timeout", async () => {
  // cat with no input never exits on its own.
  const term = await createTerminalDriver("cat", [], {
    cols: 80,
    rows: 24,
  });

  await Bun.sleep(100);
  term.type("still running");
  await term.waitForText("still running", { timeout: 2000 });

  await expect(term.waitForExit({ timeout: 300 })).rejects.toThrow(/timeout/i);

  // Clean up the still-running process.
  await term.close();
});
