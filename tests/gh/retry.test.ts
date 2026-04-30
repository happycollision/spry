import { describe, test, expect } from "bun:test";
import { withRetry, isTransientFailure } from "../../src/gh/retry.ts";
import type { CommandResult } from "../../src/lib/context.ts";

const ok: CommandResult = { stdout: "ok", stderr: "", exitCode: 0 };
const transient500: CommandResult = {
  stdout: "",
  stderr: "HTTP 503: Service Unavailable",
  exitCode: 1,
};
const networkErr: CommandResult = {
  stdout: "",
  stderr: "Could not resolve host: api.github.com",
  exitCode: 1,
};
const authErr: CommandResult = {
  stdout: "",
  stderr: "You are not logged into any GitHub hosts.",
  exitCode: 1,
};

describe("isTransientFailure", () => {
  test("false for success", () => {
    expect(isTransientFailure(ok)).toBe(false);
  });

  test("true for HTTP 5xx", () => {
    expect(isTransientFailure(transient500)).toBe(true);
    expect(
      isTransientFailure({
        stdout: "",
        stderr: "HTTP 502 Bad Gateway",
        exitCode: 1,
      }),
    ).toBe(true);
  });

  test("true for connection reset / DNS / timeout", () => {
    expect(isTransientFailure(networkErr)).toBe(true);
    expect(
      isTransientFailure({
        stdout: "",
        stderr: "connection reset by peer",
        exitCode: 1,
      }),
    ).toBe(true);
    expect(isTransientFailure({ stdout: "", stderr: "i/o timeout", exitCode: 1 })).toBe(true);
    expect(isTransientFailure({ stdout: "", stderr: "EAI_AGAIN", exitCode: 1 })).toBe(true);
  });

  test("false for auth errors", () => {
    expect(isTransientFailure(authErr)).toBe(false);
  });

  test("false for non-zero exit with unrelated stderr", () => {
    expect(isTransientFailure({ stdout: "", stderr: "no such PR", exitCode: 1 })).toBe(false);
  });
});

describe("withRetry", () => {
  test("returns first result when shouldRetry is false", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return ok;
      },
      () => false,
    );
    expect(result).toBe(ok);
    expect(calls).toBe(1);
  });

  test("retries until shouldRetry returns false", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return calls < 3 ? transient500 : ok;
      },
      (r) => r.exitCode !== 0,
      { initialDelayMs: 1, maxAttempts: 5 },
    );
    expect(result).toBe(ok);
    expect(calls).toBe(3);
  });

  test("returns last result after maxAttempts", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return transient500;
      },
      () => true,
      { initialDelayMs: 1, maxAttempts: 3 },
    );
    expect(result).toBe(transient500);
    expect(calls).toBe(3);
  });

  test("propagates thrown errors immediately", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("boom");
        },
        () => true,
        { initialDelayMs: 1, maxAttempts: 5 },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  test("backoff grows between attempts", async () => {
    const delays: number[] = [];
    let prev = Date.now();
    let calls = 0;
    await withRetry(
      async () => {
        const now = Date.now();
        if (calls > 0) delays.push(now - prev);
        prev = now;
        calls++;
        return transient500;
      },
      () => true,
      { initialDelayMs: 20, maxAttempts: 3, jitter: 0 },
    );
    expect(delays[0]!).toBeGreaterThanOrEqual(15);
    expect(delays[1]!).toBeGreaterThanOrEqual(35);
  });
});
