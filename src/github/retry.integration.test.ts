import { describe, test, expect } from "bun:test";
import { ghExec, RateLimitError, type CommandExecutor } from "./retry.ts";

/**
 * Create a mock executor that returns predefined results in sequence.
 * Useful for testing retry behavior.
 */
function createMockExecutor(
  results: Array<{ exitCode: number; stdout: string; stderr: string }>,
): { executor: CommandExecutor; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;

  const executor: CommandExecutor = async (args) => {
    calls.push([...args]);
    const result = results[index] ?? results[results.length - 1]!;
    index++;

    return {
      exitCode: result.exitCode,
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
      text: () => Promise.resolve(result.stdout),
      json: () => Promise.resolve(JSON.parse(result.stdout || "{}")),
      blob: () => Promise.resolve(new Blob([result.stdout])),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(result.stdout).buffer),
      bytes: () => Promise.resolve(new Uint8Array(new TextEncoder().encode(result.stdout))),
    } as Awaited<ReturnType<CommandExecutor>>;
  };

  return { executor, calls };
}

describe("retry integration", () => {
  describe("retry behavior with transient errors", () => {
    test("succeeds on first try when no errors", async () => {
      const { executor, calls } = createMockExecutor([
        { exitCode: 0, stdout: "success", stderr: "" },
      ]);

      const result = await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("success");
      expect(calls).toHaveLength(1);
    });

    test("retries on timeout error and succeeds", async () => {
      const { executor, calls } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "connection timeout" },
        { exitCode: 1, stdout: "", stderr: "ETIMEDOUT" },
        { exitCode: 0, stdout: "success", stderr: "" },
      ]);

      const retries: number[] = [];
      const result = await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
        baseWaitMs: 1, // Fast for testing
        onRetry: (attempt) => retries.push(attempt),
      });

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(3);
      expect(retries).toEqual([1, 2]);
    });

    test("retries on connection reset and succeeds", async () => {
      const { executor, calls } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "ECONNRESET" },
        { exitCode: 0, stdout: "success", stderr: "" },
      ]);

      const result = await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
        baseWaitMs: 1,
      });

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(2);
    });

    test("retries on 502/503/504 errors", async () => {
      const { executor, calls } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "502 Bad Gateway" },
        { exitCode: 1, stdout: "", stderr: "503 Service Unavailable" },
        { exitCode: 0, stdout: "success", stderr: "" },
      ]);

      const result = await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
        baseWaitMs: 1,
      });

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(3);
    });

    test("does not retry on non-retryable errors", async () => {
      const { executor, calls } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "not found" },
        { exitCode: 0, stdout: "should not reach", stderr: "" },
      ]);

      const result = await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
        baseWaitMs: 1,
      });

      expect(result.exitCode).toBe(1);
      expect(calls).toHaveLength(1); // No retries
    });

    test("gives up after maxAttempts", async () => {
      const { executor, calls } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "ETIMEDOUT" },
        { exitCode: 1, stdout: "", stderr: "ETIMEDOUT" },
        { exitCode: 1, stdout: "", stderr: "ETIMEDOUT" },
        { exitCode: 1, stdout: "", stderr: "ETIMEDOUT" }, // Final attempt
      ]);

      const result = await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
        baseWaitMs: 1,
      });

      expect(result.exitCode).toBe(1);
      // 3 attempts in loop + 1 final attempt = 4 total calls
      expect(calls).toHaveLength(4);
    });
  });

  describe("rate limit handling", () => {
    test("waits and retries on rate limit", async () => {
      const { executor, calls } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "API rate limit exceeded" },
        { exitCode: 0, stdout: "success", stderr: "" },
      ]);

      let rateLimitCalled = false;
      const result = await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
        baseWaitMs: 1,
        maxWaitMs: 10, // Cap wait time for testing
        onRateLimit: () => {
          rateLimitCalled = true;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(2);
      expect(rateLimitCalled).toBe(true);
    });

    test("handles secondary rate limit", async () => {
      const { executor, calls } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "secondary rate limit triggered" },
        { exitCode: 0, stdout: "success", stderr: "" },
      ]);

      const result = await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
        baseWaitMs: 1,
        maxWaitMs: 10,
      });

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(2);
    });

    test("throws RateLimitError when rate limited and retries exhausted", async () => {
      const { executor } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "API rate limit exceeded" },
        { exitCode: 1, stdout: "", stderr: "API rate limit exceeded" },
        { exitCode: 1, stdout: "", stderr: "API rate limit exceeded" },
      ]);

      await expect(
        ghExec(["gh", "api", "test"], {
          executor,
          maxAttempts: 3,
          baseWaitMs: 1,
          maxWaitMs: 10,
        }),
      ).rejects.toThrow(RateLimitError);
    });

    test("extracts retry-after time from error message", async () => {
      const { executor } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "rate limit exceeded, retry after 120 seconds" },
        { exitCode: 0, stdout: "success", stderr: "" },
      ]);

      let reportedWaitMs = 0;
      await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
        baseWaitMs: 1,
        maxWaitMs: 50, // Lower than 120s * 1000ms
        onRetry: (_attempt, waitMs) => {
          reportedWaitMs = waitMs;
        },
      });

      // Should be capped at maxWaitMs (50ms), not 120 * 1000
      expect(reportedWaitMs).toBe(50);
    });
  });

  describe("callback invocation", () => {
    test("calls onRetry with correct attempt number and wait time", async () => {
      const { executor } = createMockExecutor([
        { exitCode: 1, stdout: "", stderr: "ETIMEDOUT" },
        { exitCode: 1, stdout: "", stderr: "ETIMEDOUT" },
        { exitCode: 0, stdout: "success", stderr: "" },
      ]);

      const retryInfo: Array<{ attempt: number; waitMs: number; error: string }> = [];
      await ghExec(["gh", "api", "test"], {
        executor,
        maxAttempts: 3,
        baseWaitMs: 10,
        jitter: 0, // Disable jitter for predictable wait times
        onRetry: (attempt, waitMs, error) => {
          retryInfo.push({ attempt, waitMs, error });
        },
      });

      expect(retryInfo).toHaveLength(2);
      expect(retryInfo[0]?.attempt).toBe(1);
      expect(retryInfo[0]?.waitMs).toBe(10); // baseWait * 2^0
      expect(retryInfo[1]?.attempt).toBe(2);
      expect(retryInfo[1]?.waitMs).toBe(20); // baseWait * 2^1
    });

    test("passes correct args to executor", async () => {
      const { executor, calls } = createMockExecutor([
        { exitCode: 0, stdout: "success", stderr: "" },
      ]);

      await ghExec(["gh", "pr", "view", "123", "--json", "state"], { executor });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["gh", "pr", "view", "123", "--json", "state"]);
    });
  });

  describe("real shell execution", () => {
    test("works with actual shell commands", async () => {
      // Use echo as a simple test - no gh CLI needed
      const result = await ghExec(["echo", "hello world"], {
        maxAttempts: 1,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe("hello world");
    });

    test("handles failing commands correctly", async () => {
      const result = await ghExec(["false"], {
        maxAttempts: 1,
      });

      expect(result.exitCode).toBe(1);
    });
  });
});
