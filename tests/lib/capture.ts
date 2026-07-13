/**
 * Console/exit capture for command tests, safe under `bun test --concurrent`.
 *
 * Commands write through the process-global `console.log`/`console.error` and
 * bail via `process.exit`, so tests observe them by monkeypatching those
 * globals. Two concurrent tests patching the same globals would steal each
 * other's output (and mis-attribute exit codes), so `captureLogs` holds an
 * in-process mutex from patch until `restore()`: capturing tests serialize
 * with each other while every non-capturing test still runs concurrently.
 *
 * Usage (restore() MUST run in a finally, or later capturing tests deadlock):
 *
 *   const logs = await captureLogs();
 *   const trap = trapExit(); // sync; only valid inside a captureLogs section
 *   try { ... } finally { trap.restore(); logs.restore(); }
 */

let tail: Promise<void> = Promise.resolve();

/**
 * Acquire the process-global output mutex directly. For test helpers that
 * patch console/process.exit themselves (e.g. view.test.ts's captureView)
 * instead of going through `captureLogs`. Release in a finally.
 *
 * NOTE: tests that queue on this lock count the wait against their own
 * timeout, so concurrent runs need a raised test timeout — use the
 * `test:concurrent` script (bun test --concurrent --timeout 120000) rather
 * than a bare `bun test --concurrent`.
 */
export function acquireOutputLock(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = tail;
  tail = prev.then(() => held);
  return prev.then(() => release);
}

export interface LogCapture {
  restore: () => void;
  out: string[];
  err: string[];
}

export async function captureLogs(): Promise<LogCapture> {
  const releaseLock = await acquireOutputLock();
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  return {
    restore: () => {
      console.log = origLog;
      console.error = origErr;
      releaseLock();
    },
    out,
    err,
  };
}

export interface ExitTrap {
  exitCode: number | undefined;
  restore: () => void;
}

export function trapExit(): ExitTrap {
  const state: { exitCode: number | undefined } = { exitCode: undefined };
  const origExit = process.exit;
  // @ts-ignore
  process.exit = (code: number) => {
    state.exitCode = code;
    throw new Error("process.exit");
  };
  return {
    get exitCode() {
      return state.exitCode;
    },
    restore: () => {
      // @ts-ignore
      process.exit = origExit;
    },
  };
}
