import { test, expect } from "bun:test";
import { acquireOutputLock, captureLogs, setRealConsoleErrorForTest } from "./capture.ts";
import { serialChain } from "./serial.ts";

// Tests 1 and 2 substitute the module's real-console.error reference to
// observe the wait diagnostic — process-global state, same as
// console.log/console.error. `setRealConsoleErrorForTest` is test-only and
// only ever touched by these two tests, so they serialize against EACH
// OTHER via serialChain() rather than the production output lock: nesting
// acquisitions of the *same* lock these tests already use to build their
// artificial waiter scenario would self-deadlock.
//
// In both tests the spy is installed only AFTER holder-a has acquired:
// holder-a's own warn timer arms at its acquire CALL, and under a full
// concurrent suite holder-a can queue behind a sibling test long enough for
// that timer to fire — a spurious diagnostic that must go to the real
// console.error, not into the test's spy.

const serial = serialChain();

test(
  "a waiter past the threshold emits one diagnostic naming the holder",
  serial(async () => {
    const releaseA = await acquireOutputLock("holder-a", 20);

    // capture.ts binds the real console.error at module load and calls
    // through that binding, not whatever `console.error` currently points
    // to — so a test-local `console.error` patch (below) must never
    // observe the diagnostic. Bun's console.error also doesn't route
    // through a patchable stream (bypasses process.stderr.write), so
    // observing the diagnostic requires the test-only substitution hook.
    const seenViaRealError: unknown[][] = [];
    const restoreReal = setRealConsoleErrorForTest((...args: unknown[]) => {
      seenViaRealError.push(args);
    });

    const seenViaPatchedConsole: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      seenViaPatchedConsole.push(args);
    };

    try {
      // This acquisition queues behind "holder-a"; its threshold (20ms)
      // elapses well before we release, so it must fire the diagnostic.
      const waiterB = acquireOutputLock("waiter-b", 20);
      await new Promise((resolve) => setTimeout(resolve, 80));
      releaseA();
      const releaseB = await waiterB;
      releaseB();
    } finally {
      console.error = origError;
      restoreReal();
    }

    // Fired exactly once, naming the holder that was blocking the waiter.
    expect(seenViaRealError).toHaveLength(1);
    expect(seenViaRealError[0]!.join(" ")).toContain('current holder: "holder-a"');

    // The test's own console.error patch must never see it — it went
    // through the real, pre-patch console.error captured at module load.
    expect(seenViaPatchedConsole).toHaveLength(0);
  }),
);

test(
  "a waiter that acquires before the threshold emits nothing",
  serial(async () => {
    const releaseA = await acquireOutputLock("holder-a", 200);

    const seen: unknown[][] = [];
    const restoreReal = setRealConsoleErrorForTest((...args: unknown[]) => {
      seen.push(args);
    });
    try {
      // Threshold is comfortably longer than the tiny artificial delay
      // below, so — if the timer is cleared correctly on acquisition — it
      // must never fire.
      const waiterB = acquireOutputLock("waiter-b", 200);
      await new Promise((resolve) => setTimeout(resolve, 5));
      releaseA();
      const releaseB = await waiterB;
      releaseB();
      // Give the (cleared) timer a chance to fire if it were still armed.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      restoreReal();
    }
    expect(seen).toHaveLength(0);
  }),
);

test("two captureLogs sections never interleave their console patches", async () => {
  const events: string[] = [];

  async function section(label: string, delayMs: number) {
    const logs = await captureLogs(label);
    try {
      events.push(`${label}:start`);
      console.log(`${label}-line`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push(`${label}:end`);
    } finally {
      logs.restore();
    }
    return logs;
  }

  const [logsA, logsB] = await Promise.all([section("A", 30), section("B", 0)]);

  // Whichever section ran first must fully start AND end before the other
  // starts — no interleaving of start/end pairs.
  const firstLabel = events[0]!.split(":")[0];
  const secondLabel = firstLabel === "A" ? "B" : "A";
  expect(events).toEqual([
    `${firstLabel}:start`,
    `${firstLabel}:end`,
    `${secondLabel}:start`,
    `${secondLabel}:end`,
  ]);

  expect(logsA.out).toEqual(["A-line"]);
  expect(logsB.out).toEqual(["B-line"]);
});
