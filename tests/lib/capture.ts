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
 *
 * If a holder's test hangs, Bun's per-test timeout fails that test but never
 * unwinds its pending body, so the lock is never released and every later
 * capturing test times out with no clue why. There is deliberately no
 * force-release or acquire-rejection here — a legitimately long queue must
 * still work, since the whole chain can legally exceed any fixed bound.
 * Instead, a waiter stuck past `lockWaitWarnMs` gets exactly one diagnostic
 * naming the current holder, through the real (pre-patch) `console.error`
 * captured below at module load — so the diagnostic itself is never
 * swallowed by another test's capture.
 */

let realConsoleError: (...args: unknown[]) => void = console.error.bind(console);

const DEFAULT_LOCK_WAIT_WARN_MS = 30_000;

/**
 * Test-only escape hatch: Bun's console.error doesn't route through a
 * patchable stream (it bypasses `process.stderr.write`), so tests can't spy
 * on the module-load-captured `realConsoleError` any other way. Restore the
 * original in a finally.
 */
export function setRealConsoleErrorForTest(fn: (...args: unknown[]) => void): () => void {
  const prev = realConsoleError;
  realConsoleError = fn;
  return () => {
    realConsoleError = prev;
  };
}

interface Holder {
  label: string;
  acquiredAt: number;
}

let currentHolder: Holder | undefined;

let tail: Promise<void> = Promise.resolve();

/**
 * Acquire the process-global output mutex directly. For test helpers that
 * patch console/process.exit themselves (e.g. view.test.ts's captureView)
 * instead of going through `captureLogs`. Release in a finally.
 *
 * `holder` is a label recorded for the wait diagnostic (defaults to
 * "unlabeled" — existing call sites don't need to change).
 * `lockWaitWarnMs` overrides the default wait-diagnostic threshold for this
 * acquisition (test-only; production callers should not pass it).
 *
 * NOTE: tests that queue on this lock count the wait against their own
 * timeout, so concurrent runs need a raised test timeout — use the
 * `test:concurrent` script (bun test --concurrent --timeout 120000) rather
 * than a bare `bun test --concurrent`.
 */
export function acquireOutputLock(
  holder = "unlabeled",
  lockWaitWarnMs = DEFAULT_LOCK_WAIT_WARN_MS,
): Promise<() => void> {
  const warnTimer = setTimeout(() => {
    const held = currentHolder;
    const heldFor = held ? Math.round((Date.now() - held.acquiredAt) / 1000) : 0;
    realConsoleError(
      `[capture] still waiting for the output lock after ${Math.round(lockWaitWarnMs / 1000)}s; ` +
        `current holder: "${held?.label ?? "unknown"}" (held for ${heldFor}s)`,
    );
  }, lockWaitWarnMs);
  // Don't let this diagnostic timer keep the process (or a test's fake
  // timers / teardown) alive if it's still pending when everything else
  // is done.
  warnTimer.unref?.();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = tail;
  tail = prev.then(() => held);
  return prev.then(() => {
    clearTimeout(warnTimer);
    currentHolder = { label: holder, acquiredAt: Date.now() };
    return () => {
      currentHolder = undefined;
      release();
    };
  });
}

export interface LogCapture {
  restore: () => void;
  out: string[];
  err: string[];
}

export async function captureLogs(
  holder = "unlabeled",
  lockWaitWarnMs = DEFAULT_LOCK_WAIT_WARN_MS,
): Promise<LogCapture> {
  const releaseLock = await acquireOutputLock(holder, lockWaitWarnMs);
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
