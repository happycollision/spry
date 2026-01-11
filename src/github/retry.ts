import { $ } from "bun";

/** Shell command result type */
type ShellOutput = Awaited<ReturnType<typeof $>>;

/** Command executor function type - for dependency injection in tests */
export type CommandExecutor = (args: string[]) => Promise<ShellOutput>;

/** Default executor using Bun shell */
const defaultExecutor: CommandExecutor = (args) => $`${args}`.quiet().nothrow();

/**
 * Error thrown when rate limit is exceeded and all retries exhausted.
 */
export class RateLimitError extends Error {
  constructor(
    public retryAfterSeconds?: number,
    message?: string,
  ) {
    super(message || "GitHub API rate limit exceeded");
    this.name = "RateLimitError";
  }
}

/**
 * Options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Base wait time in ms before first retry (default: 1000) */
  baseWaitMs?: number;
  /** Maximum wait time in ms between retries (default: 30000) */
  maxWaitMs?: number;
  /** Jitter factor 0-1 to randomize wait times (default: 0.2) */
  jitter?: number;
  /** Callback when retrying, receives attempt number and wait time */
  onRetry?: (attempt: number, waitMs: number, error: string) => void;
  /** Callback when rate limited */
  onRateLimit?: (retryAfterSeconds: number) => void;
  /** Custom command executor (for testing) */
  executor?: CommandExecutor;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "onRetry" | "onRateLimit" | "executor">> & {
  executor: CommandExecutor;
} = {
  maxAttempts: 3,
  baseWaitMs: 1000,
  maxWaitMs: 30000,
  jitter: 0.2,
  executor: defaultExecutor,
};

/**
 * Calculate wait time with exponential backoff and jitter.
 * Formula: baseWait * 2^attempt * (1 + random * jitter)
 */
export function calculateBackoff(
  attempt: number,
  baseWaitMs: number,
  maxWaitMs: number,
  jitter: number,
): number {
  const exponentialWait = baseWaitMs * Math.pow(2, attempt);
  const jitterMultiplier = 1 + Math.random() * jitter;
  const waitWithJitter = exponentialWait * jitterMultiplier;
  return Math.min(waitWithJitter, maxWaitMs);
}

/**
 * Parse GitHub rate limit info from error output.
 * Returns retry-after seconds if rate limited, null otherwise.
 */
export function parseRateLimitError(stderr: string): number | null {
  const lowerStderr = stderr.toLowerCase();

  // GitHub API rate limit messages
  if (
    lowerStderr.includes("rate limit") ||
    lowerStderr.includes("api rate limit exceeded") ||
    lowerStderr.includes("secondary rate limit")
  ) {
    // Try to extract retry-after time (handles "retry after 120" or "Retry After 45")
    const retryMatch = stderr.match(/retry\s*after\s*(\d+)/i);
    if (retryMatch?.[1]) {
      return parseInt(retryMatch[1], 10);
    }
    // Default to 60 seconds if no specific time given
    return 60;
  }
  return null;
}

/**
 * Check if an error is retryable (transient failures).
 */
export function isRetryableError(stderr: string): boolean {
  const retryablePatterns = [
    "rate limit",
    "secondary rate limit",
    "API rate limit exceeded",
    "timeout",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "socket hang up",
    "502",
    "503",
    "504",
  ];

  const lowerStderr = stderr.toLowerCase();
  return retryablePatterns.some((pattern) => lowerStderr.includes(pattern.toLowerCase()));
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a gh CLI command with retry logic.
 *
 * Handles:
 * - Exponential backoff with jitter
 * - Rate limit detection and appropriate wait times
 * - User messaging during waits
 *
 * @param args - Array of command arguments (e.g., ["gh", "pr", "view", "123"])
 * @param options - Retry configuration options
 * @returns Shell output from successful execution
 * @throws RateLimitError if rate limited and all retries exhausted
 * @throws Error if command fails with non-retryable error
 */
export async function ghExec(
  args: string[],
  options: RetryOptions = {},
): Promise<ShellOutput> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const exec = opts.executor;
  let lastError: string = "";

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    const result = await exec(args);

    if (result.exitCode === 0) {
      return result;
    }

    const stderr = result.stderr.toString();
    lastError = stderr;

    // Check for rate limiting
    const rateLimitSeconds = parseRateLimitError(stderr);
    if (rateLimitSeconds !== null) {
      opts.onRateLimit?.(rateLimitSeconds);

      if (attempt < opts.maxAttempts - 1) {
        const waitMs = Math.min(rateLimitSeconds * 1000, opts.maxWaitMs);
        opts.onRetry?.(attempt + 1, waitMs, "Rate limited");
        await sleep(waitMs);
        continue;
      }
      throw new RateLimitError(rateLimitSeconds);
    }

    // Check if error is retryable
    if (!isRetryableError(stderr)) {
      // Non-retryable error, return immediately
      return result;
    }

    // Retryable error - apply backoff
    if (attempt < opts.maxAttempts - 1) {
      const waitMs = calculateBackoff(attempt, opts.baseWaitMs, opts.maxWaitMs, opts.jitter);
      opts.onRetry?.(attempt + 1, waitMs, stderr.trim());
      await sleep(waitMs);
    }
  }

  // All retries exhausted
  const result = await exec(args);
  return result;
}

/**
 * Simple semaphore for limiting concurrent operations.
 */
export class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  /**
   * Run a function with semaphore protection.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Global concurrency limiter for GitHub API calls */
const ghSemaphore = new Semaphore(5);

/**
 * Execute a gh CLI command with retry logic and concurrency limiting.
 *
 * This is the main entry point for all GitHub API calls. It combines:
 * - Concurrency limiting (max 5 concurrent calls)
 * - Exponential backoff with jitter
 * - Rate limit detection
 *
 * @param args - Array of command arguments (e.g., ["gh", "pr", "view", "123"])
 * @param options - Retry configuration options
 * @returns Shell output from successful execution
 */
export async function ghExecWithLimit(
  args: string[],
  options: RetryOptions = {},
): Promise<ShellOutput> {
  return ghSemaphore.run(() => ghExec(args, options));
}

/**
 * Format a user-friendly message for rate limit waits.
 */
export function formatRateLimitMessage(waitMs: number): string {
  const seconds = Math.ceil(waitMs / 1000);
  if (seconds < 60) {
    return `Rate limited. Waiting ${seconds}s...`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `Rate limited. Waiting ${minutes}m...`;
}

/**
 * Format a user-friendly message for retry waits.
 */
export function formatRetryMessage(attempt: number, maxAttempts: number, waitMs: number): string {
  const seconds = Math.round(waitMs / 1000);
  return `Retry ${attempt}/${maxAttempts - 1} in ${seconds}s...`;
}
