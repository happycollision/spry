import { describe, test, expect } from "bun:test";
import {
  calculateBackoff,
  parseRateLimitError,
  isRetryableError,
  Semaphore,
  RateLimitError,
  formatRateLimitMessage,
  formatRetryMessage,
  ghExec,
} from "./retry.ts";

describe("github/retry", () => {
  describe("calculateBackoff", () => {
    test("returns base wait on first attempt (attempt 0)", () => {
      // With jitter=0, should return exactly baseWait * 2^0 = 1000
      const result = calculateBackoff(0, 1000, 30000, 0);
      expect(result).toBe(1000);
    });

    test("doubles wait time with each attempt", () => {
      // With jitter=0 for predictable results
      expect(calculateBackoff(0, 1000, 30000, 0)).toBe(1000);
      expect(calculateBackoff(1, 1000, 30000, 0)).toBe(2000);
      expect(calculateBackoff(2, 1000, 30000, 0)).toBe(4000);
      expect(calculateBackoff(3, 1000, 30000, 0)).toBe(8000);
    });

    test("respects maxWaitMs cap", () => {
      // attempt 5 would be 1000 * 32 = 32000, but max is 30000
      const result = calculateBackoff(5, 1000, 30000, 0);
      expect(result).toBe(30000);
    });

    test("adds jitter within expected range", () => {
      // With jitter=0.2, result should be between base and base * 1.2
      const baseWait = 1000;
      const jitter = 0.2;

      // Run multiple times to verify jitter is applied
      for (let i = 0; i < 10; i++) {
        const result = calculateBackoff(0, baseWait, 30000, jitter);
        expect(result).toBeGreaterThanOrEqual(baseWait);
        expect(result).toBeLessThanOrEqual(baseWait * (1 + jitter));
      }
    });

    test("jitter is randomized (not always the same)", () => {
      const results = new Set<number>();
      for (let i = 0; i < 20; i++) {
        results.add(calculateBackoff(0, 1000, 30000, 0.5));
      }
      // With 50% jitter range, we should see some variation
      expect(results.size).toBeGreaterThan(1);
    });
  });

  describe("parseRateLimitError", () => {
    test("returns null for non-rate-limit errors", () => {
      expect(parseRateLimitError("fatal: not found")).toBeNull();
      expect(parseRateLimitError("authentication failed")).toBeNull();
      expect(parseRateLimitError("")).toBeNull();
    });

    test("detects 'rate limit' message", () => {
      const result = parseRateLimitError("error: rate limit exceeded");
      expect(result).toBe(60); // default fallback
    });

    test("detects 'API rate limit exceeded' message", () => {
      const result = parseRateLimitError("API rate limit exceeded for user");
      expect(result).toBe(60);
    });

    test("detects 'secondary rate limit' message", () => {
      const result = parseRateLimitError("secondary rate limit triggered");
      expect(result).toBe(60);
    });

    test("extracts retry-after time when present", () => {
      const result = parseRateLimitError("rate limit exceeded, retry after 120 seconds");
      expect(result).toBe(120);
    });

    test("extracts retry-after time (case insensitive)", () => {
      const result = parseRateLimitError("Rate limit exceeded. Retry After 45");
      expect(result).toBe(45);
    });

    test("returns default 60s when no retry-after specified", () => {
      const result = parseRateLimitError("You have exceeded a secondary rate limit");
      expect(result).toBe(60);
    });
  });

  describe("isRetryableError", () => {
    test("returns false for non-retryable errors", () => {
      expect(isRetryableError("not found")).toBe(false);
      expect(isRetryableError("permission denied")).toBe(false);
      expect(isRetryableError("invalid argument")).toBe(false);
      expect(isRetryableError("authentication failed")).toBe(false);
    });

    test("returns true for rate limit errors", () => {
      expect(isRetryableError("rate limit exceeded")).toBe(true);
      expect(isRetryableError("secondary rate limit")).toBe(true);
      expect(isRetryableError("API rate limit exceeded")).toBe(true);
    });

    test("returns true for timeout errors", () => {
      expect(isRetryableError("connection timeout")).toBe(true);
      expect(isRetryableError("ETIMEDOUT")).toBe(true);
    });

    test("returns true for connection errors", () => {
      expect(isRetryableError("ECONNRESET")).toBe(true);
      expect(isRetryableError("ECONNREFUSED")).toBe(true);
      expect(isRetryableError("socket hang up")).toBe(true);
    });

    test("returns true for server errors", () => {
      expect(isRetryableError("502 Bad Gateway")).toBe(true);
      expect(isRetryableError("503 Service Unavailable")).toBe(true);
      expect(isRetryableError("504 Gateway Timeout")).toBe(true);
    });

    test("is case insensitive", () => {
      expect(isRetryableError("RATE LIMIT")).toBe(true);
      expect(isRetryableError("Socket Hang Up")).toBe(true);
    });
  });

  describe("Semaphore", () => {
    test("allows up to N concurrent operations", async () => {
      const sem = new Semaphore(3);
      let concurrent = 0;
      let maxConcurrent = 0;

      const tasks = Array.from({ length: 10 }, async () => {
        await sem.acquire();
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        sem.release();
      });

      await Promise.all(tasks);

      expect(maxConcurrent).toBe(3);
    });

    test("run() acquires and releases correctly", async () => {
      const sem = new Semaphore(2);
      let concurrent = 0;
      let maxConcurrent = 0;

      const tasks = Array.from({ length: 5 }, () =>
        sem.run(async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 10));
          concurrent--;
          return "done";
        }),
      );

      const results = await Promise.all(tasks);

      expect(maxConcurrent).toBe(2);
      expect(results).toEqual(["done", "done", "done", "done", "done"]);
    });

    test("run() releases on error", async () => {
      const sem = new Semaphore(1);

      // First call throws
      await expect(
        sem.run(async () => {
          throw new Error("test error");
        }),
      ).rejects.toThrow("test error");

      // Second call should still be able to acquire
      const result = await sem.run(async () => "success");
      expect(result).toBe("success");
    });

    test("maintains FIFO order for waiting tasks", async () => {
      const sem = new Semaphore(1);
      const order: number[] = [];

      // Acquire first
      await sem.acquire();

      // Queue up tasks
      const t1 = sem.run(async () => {
        order.push(1);
      });
      const t2 = sem.run(async () => {
        order.push(2);
      });
      const t3 = sem.run(async () => {
        order.push(3);
      });

      // Release to let them run
      sem.release();

      await Promise.all([t1, t2, t3]);

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("RateLimitError", () => {
    test("includes retry-after seconds", () => {
      const error = new RateLimitError(120);
      expect(error.retryAfterSeconds).toBe(120);
      expect(error.message).toBe("GitHub API rate limit exceeded");
      expect(error.name).toBe("RateLimitError");
    });

    test("accepts custom message", () => {
      const error = new RateLimitError(60, "Custom rate limit message");
      expect(error.message).toBe("Custom rate limit message");
      expect(error.retryAfterSeconds).toBe(60);
    });

    test("works without retry-after", () => {
      const error = new RateLimitError();
      expect(error.retryAfterSeconds).toBeUndefined();
      expect(error.message).toBe("GitHub API rate limit exceeded");
    });
  });

  describe("formatRateLimitMessage", () => {
    test("formats seconds under 60", () => {
      expect(formatRateLimitMessage(5000)).toBe("Rate limited. Waiting 5s...");
      expect(formatRateLimitMessage(30000)).toBe("Rate limited. Waiting 30s...");
      expect(formatRateLimitMessage(59000)).toBe("Rate limited. Waiting 59s...");
    });

    test("formats minutes for 60s or more", () => {
      expect(formatRateLimitMessage(60000)).toBe("Rate limited. Waiting 1m...");
      expect(formatRateLimitMessage(90000)).toBe("Rate limited. Waiting 2m...");
      expect(formatRateLimitMessage(300000)).toBe("Rate limited. Waiting 5m...");
    });

    test("rounds up seconds", () => {
      expect(formatRateLimitMessage(1500)).toBe("Rate limited. Waiting 2s...");
    });
  });

  describe("formatRetryMessage", () => {
    test("formats retry message correctly", () => {
      expect(formatRetryMessage(1, 3, 1000)).toBe("Retry 1/2 in 1s...");
      expect(formatRetryMessage(2, 3, 2000)).toBe("Retry 2/2 in 2s...");
      expect(formatRetryMessage(1, 5, 4500)).toBe("Retry 1/4 in 5s...");
    });
  });

  describe("ghExec", () => {
    test("executes successful command", async () => {
      const result = await ghExec(["echo", "hello"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe("hello");
    });

    test("returns result for non-retryable failures", async () => {
      const result = await ghExec(["false"]); // always exits 1
      expect(result.exitCode).toBe(1);
    });

    test("calls onRetry callback during retries", async () => {
      const retryCalls: Array<{ attempt: number; waitMs: number }> = [];

      // This command fails with a retryable-looking error
      // We'll use a script that outputs a retryable error message
      const result = await ghExec(
        ["sh", "-c", "echo 'connection timeout' >&2; exit 1"],
        {
          maxAttempts: 2,
          baseWaitMs: 10, // short for testing
          onRetry: (attempt, waitMs) => {
            retryCalls.push({ attempt, waitMs });
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(retryCalls.length).toBe(1);
      expect(retryCalls[0]?.attempt).toBe(1);
    });

    test("respects maxAttempts", async () => {
      let attempts = 0;

      // Use a wrapper to count actual executions
      const originalArgs = ["sh", "-c", "echo 'ETIMEDOUT' >&2; exit 1"];

      // We can't easily count internal attempts, but we can verify
      // the function returns after maxAttempts by timing it
      const start = Date.now();
      await ghExec(originalArgs, {
        maxAttempts: 2,
        baseWaitMs: 50,
      });
      const elapsed = Date.now() - start;

      // With 2 attempts and 50ms base wait, should take roughly 50-100ms
      // (one retry wait between attempts)
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(500);
    });
  });
});
