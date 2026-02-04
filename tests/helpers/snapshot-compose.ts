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

import { basename } from "node:path";
import { afterEach as bunAfterEach } from "bun:test";
import {
  setTestMetadata,
  clearSnapshotContext,
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
    const content = require("fs").readFileSync(path, "utf-8");
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

  // Register afterEach to clean up (only once per test file)
  let afterEachRegistered = false;

  function ensureAfterEach(): void {
    if (afterEachRegistered) return;
    afterEachRegistered = true;

    bunAfterEach(() => {
      clearSnapshotContext();
      resetGitHubService();
    });
  }

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
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function wrapTestFn(testName: string, fn: any): any {
    ensureAfterEach();

    // Return a function with the same signature
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (context?: any) => {
      // Set test metadata for snapshot context
      setTestMetadata(resolvedTestFile, testName);

      // Call original test function (snapshot errors will propagate)
      if (context !== undefined) {
        await fn(context);
      } else {
        await fn();
      }
    };
  }

  /**
   * The wrapped test function.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function wrappedTest(name: string, fnOrOptions: any, optionsOrFn?: any): void {
    const fn = typeof fnOrOptions === "function" ? fnOrOptions : optionsOrFn;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrappedTest.skip = (name: string, fn: any, options?: TestOptions): void => {
    if (originalTest.skip) {
      originalTest.skip(name, fn, options);
    }
  };

  // Add only support
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrappedTest.only = (name: string, fn: any, options?: TestOptions): void => {
    ensureAfterEach();
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (name: string, fn: any, options?: TestOptions): void => {
      if (condition) {
        wrappedTest.skip(name, fn, options);
      } else {
        wrappedTest(name, fn, options);
      }
    };
  };

  // Add noStory support (pass-through to original if available)
  wrappedTest.noStory = originalTest.noStory || originalTest;

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
