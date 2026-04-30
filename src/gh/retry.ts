import type { CommandResult } from "../lib/context.ts";

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  jitter?: number;
}

const TRANSIENT_PATTERNS = [
  /HTTP\s+5\d\d/i,
  /connection reset/i,
  /could not resolve host/i,
  /EAI_AGAIN/,
  /i\/o timeout/i,
  /network is unreachable/i,
];

export function isTransientFailure(result: CommandResult): boolean {
  if (result.exitCode === 0) return false;
  return TRANSIENT_PATTERNS.some((pat) => pat.test(result.stderr));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const initialDelayMs = options?.initialDelayMs ?? 250;
  const jitter = options?.jitter ?? 0.2;

  let lastResult: T | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    lastResult = result;
    if (!shouldRetry(result) || attempt === maxAttempts) {
      return result;
    }
    const base = initialDelayMs * 2 ** (attempt - 1);
    const jitterAmount = base * jitter * (Math.random() * 2 - 1);
    const delay = Math.max(0, base + jitterAmount);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return lastResult as T;
}
