/**
 * Composition function to add GitHub snapshot support to test suites.
 *
 * This module provides `withGitHubSnapshots()` which wraps any test suite
 * to add automatic snapshot recording/replay for GitHub API calls.
 *
 * Usage with story tests:
 * ```typescript
 * const base = createStoryTest(import.meta.file);
 * const { test } = withGitHubSnapshots(base);
 *
 * test("creates PR", async (story) => {
 *   // GitHub calls are automatically snapshot'd
 *   const result = await getGitHubService().createPR({...});
 * });
 * ```
 *
 * Usage with plain bun:test:
 * ```typescript
 * import { test as bunTest } from "bun:test";
 * const { test } = withGitHubSnapshots({ test: bunTest });
 * ```
 *
 * The wrapper:
 * - Automatically detects test file from Bun.main
 * - Sets test metadata before each test
 * - Skips tests without snapshots in replay mode (using native Bun skip)
 * - Clears context in afterEach
 * - Preserves test.skip, test.only, test.skipIf
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { afterEach as bunAfterEach } from "bun:test";
import {
  setTestMetadata,
  clearSnapshotContext,
  resetSubprocessCounter,
  getSnapshotPath,
} from "../../src/github/snapshot-context.ts";
import { isGitHubIntegrationEnabled, resetGitHubService } from "../../src/github/service.ts";

/** Memoized snapshot file cache */
const snapshotFileCache = new Map<string, { entries: Array<{ testContext: string }> } | null>();

/**
 * Load a snapshot file synchronously (memoized).
 * Returns null if the file doesn't exist or is invalid.
 */
function loadSnapshotFileSync(
  testFile: string,
): { entries: Array<{ testContext: string }> } | null {
  const path = getSnapshotPath(testFile);

  if (snapshotFileCache.has(path)) {
    return snapshotFileCache.get(path) ?? null;
  }

  try {
    // Use readFileSync for synchronous loading at test registration time
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    snapshotFileCache.set(path, parsed);
    return parsed;
  } catch {
    snapshotFileCache.set(path, null);
    return null;
  }
}

/**
 * Check if a test has any recorded snapshots.
 * Used at registration time to decide whether to skip.
 */
function hasSnapshotForTest(testFile: string, testName: string): boolean {
  const file = loadSnapshotFileSync(testFile);
  if (!file || !file.entries) return false;
  return file.entries.some((e) => e.testContext === testName);
}

/** Test options */
interface TestOptions {
  timeout?: number;
}

/**
 * Loose function type for test callbacks and overloaded test() arguments.
 * bun:test's test function accepts (name, fn), (name, options, fn), or
 * (name, fn, options) — all with varying callback signatures. Using a
 * single `any`-based alias keeps the eslint-disable in one place.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTestFn = (...args: any[]) => any;

/**
 * Wrap a test suite with GitHub snapshot support.
 *
 * @param suite - The test suite to wrap (e.g., from createStoryTest or { test: bunTest })
 * @param testFile - Optional test file name. Auto-detected from Bun.main if not provided.
 * @returns Wrapped test suite with snapshot support
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withGitHubSnapshots<T extends { test: any }>(suite: T, testFile?: string): T {
  // Auto-detect test file from Bun.main if not provided
  const resolvedTestFile = testFile ?? basename(Bun.main);
  const originalTest = suite.test;

  // Register afterEach at the file's top scope (not inside a describe block)
  // so it applies to ALL tests in the file, preventing snapshot context from
  // leaking between describe blocks or between test files in the same bun process.
  //
  // Note: We intentionally do NOT clear the snapshot file on recording.
  // Entries are replaced individually by recordSnapshot(), which preserves
  // entries from tests that aren't running (e.g., CI-dependent tests when
  // running test:github instead of test:ci).
  bunAfterEach(() => {
    clearSnapshotContext();
    resetSubprocessCounter();
    resetGitHubService();
  });

  /**
   * Check if a test should be skipped (no snapshots in replay mode).
   */
  function shouldSkipTest(testName: string): boolean {
    if (isGitHubIntegrationEnabled()) {
      // Record mode - never skip, we're recording new snapshots
      return false;
    }
    // Replay mode - skip if no snapshots exist for this test
    return !hasSnapshotForTest(resolvedTestFile, testName);
  }

  /**
   * Wrap a test function to set metadata and handle snapshot errors.
   *
   * Important: The returned function must match the original's arity (fn.length).
   * bun:test treats functions with parameters as done-callback-style tests,
   * which would cause hangs if the wrapper has a parameter the original doesn't.
   */
  function wrapTestFn(testName: string, fn: AnyTestFn): AnyTestFn {
    // If the original function takes no arguments (e.g., noStory tests),
    // return a 0-arity wrapper so bun:test doesn't inject a done callback.
    if (fn.length === 0) {
      return async () => {
        setTestMetadata(resolvedTestFile, testName);
        await fn();
      };
    }

    // Otherwise, pass through the context (e.g., story context)
    return async (context: unknown) => {
      setTestMetadata(resolvedTestFile, testName);
      await fn(context);
    };
  }

  /**
   * The wrapped test function.
   */
  function wrappedTest(
    name: string,
    fnOrOptions: AnyTestFn | TestOptions,
    optionsOrFn?: AnyTestFn | TestOptions,
  ): void {
    const fn = (typeof fnOrOptions === "function" ? fnOrOptions : optionsOrFn) as AnyTestFn;
    const options =
      typeof fnOrOptions === "object"
        ? fnOrOptions
        : typeof optionsOrFn === "object"
          ? optionsOrFn
          : undefined;

    // Skip at registration time if no snapshots in replay mode
    if (shouldSkipTest(name)) {
      if (originalTest.skip) {
        originalTest.skip(name, fn, options);
      }
      return;
    }

    const wrapped = wrapTestFn(name, fn);

    if (options && typeof fnOrOptions === "object") {
      originalTest(name, options, wrapped);
    } else if (options) {
      originalTest(name, wrapped, options);
    } else {
      originalTest(name, wrapped);
    }
  }

  // Add skip support
  wrappedTest.skip = (name: string, fn: AnyTestFn, options?: TestOptions): void => {
    if (originalTest.skip) {
      originalTest.skip(name, fn, options);
    }
  };

  // Add only support
  wrappedTest.only = (name: string, fn: AnyTestFn, options?: TestOptions): void => {
    const wrapped = wrapTestFn(name, fn);

    if (originalTest.only) {
      if (options) {
        originalTest.only(name, wrapped, options);
      } else {
        originalTest.only(name, wrapped);
      }
    }
  };

  // Add skipIf support
  wrappedTest.skipIf = (condition: boolean) => {
    return (name: string, fn: AnyTestFn, options?: TestOptions): void => {
      if (condition) {
        wrappedTest.skip(name, fn, options);
      } else {
        wrappedTest(name, fn, options);
      }
    };
  };

  // Wrap noStory with snapshot support too (sets test metadata for recording)
  const originalNoStory = originalTest.noStory || originalTest;

  function wrappedNoStory(
    name: string,
    fnOrOptions: AnyTestFn | TestOptions,
    optionsOrFn?: AnyTestFn | TestOptions,
  ): void {
    const fn = (typeof fnOrOptions === "function" ? fnOrOptions : optionsOrFn) as AnyTestFn;
    const options =
      typeof fnOrOptions === "object"
        ? fnOrOptions
        : typeof optionsOrFn === "object"
          ? optionsOrFn
          : undefined;

    if (shouldSkipTest(name)) {
      if (originalNoStory.skip) {
        originalNoStory.skip(name, fn, options);
      }
      return;
    }

    const wrapped = wrapTestFn(name, fn);

    if (options && typeof fnOrOptions === "object") {
      originalNoStory(name, options, wrapped);
    } else if (options) {
      originalNoStory(name, wrapped, options);
    } else {
      originalNoStory(name, wrapped);
    }
  }

  wrappedNoStory.skip = (name: string, fn: AnyTestFn, options?: TestOptions): void => {
    if (originalNoStory.skip) {
      originalNoStory.skip(name, fn, options);
    }
  };

  wrappedNoStory.skipIf = (condition: boolean) => {
    return (name: string, fn: AnyTestFn, options?: TestOptions): void => {
      if (condition) {
        wrappedNoStory.skip(name, fn, options);
      } else {
        wrappedNoStory(name, fn, options);
      }
    };
  };

  wrappedNoStory.only = (name: string, fn: AnyTestFn, options?: TestOptions): void => {
    const wrapped = wrapTestFn(name, fn);

    if (originalNoStory.only) {
      if (options) {
        originalNoStory.only(name, wrapped, options);
      } else {
        originalNoStory.only(name, wrapped);
      }
    }
  };

  wrappedTest.noStory = wrappedNoStory;

  return {
    ...suite,
    test: wrappedTest,
  };
}

/**
 * Check if GitHub integration tests are enabled.
 * Convenience re-export for test files.
 */
export { isGitHubIntegrationEnabled } from "../../src/github/service.ts";
