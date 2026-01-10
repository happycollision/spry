/**
 * Story-aware test wrapper for integration tests.
 *
 * Provides a cleaner API that automatically handles story lifecycle:
 * - Auto-begins with test name if title() not called
 * - Auto-ends when test completes
 * - Captures failures automatically
 * - Auto-registers afterAll to flush story output
 *
 * Usage:
 * ```ts
 * import { createStoryTest } from "./helpers/story-test.ts";
 *
 * const { test } = createStoryTest("my-feature.test.ts");
 *
 * describe("my feature", () => {
 *   test("does something", async (story) => {
 *     story.strip(testId); // Optional: set ID for sanitization
 *     story.title("Custom title"); // Optional: override test name as title
 *     story.narrate("Description of what's happening.");
 *
 *     const result = await runCommand();
 *     story.log(result);
 *
 *     expect(result.exitCode).toBe(0);
 *     // story.end() is automatic
 *   });
 * });
 * ```
 */

import { test as bunTest, afterAll as bunAfterAll, type TestOptions } from "bun:test";
import { createStory } from "./story.ts";
import type { CommandResult } from "../integration/helpers.ts";

/** Story context passed to each test */
export interface StoryContext {
  /** Set the test ID for sanitizing dynamic IDs from output */
  strip(testId: string): void;
  /** Override the section title (defaults to test name) */
  title(title: string): void;
  /** Add narrative text to the story */
  narrate(text: string): void;
  /** Log a command result */
  log(result: CommandResult): void;
  /** Mark as failed (usually automatic via exception capture) */
  fail(reason?: string): void;
}

type StoryTestFn = (story: StoryContext) => void | Promise<void>;

interface StoryTestOptions extends TestOptions {
  timeout?: number;
}

/**
 * Create a story-aware test suite for a test file.
 *
 * @param testFileName - Name of the test file (e.g., "sync.test.ts")
 */
export function createStoryTest(testFileName: string) {
  const baseStory = createStory(testFileName);

  // Auto-register afterAll to flush story output
  bunAfterAll(async () => {
    await baseStory.flush();
  });

  // Track state for the current test
  let currentTestId: string | undefined;
  let hasBegunSection = false;
  let currentTestName: string | undefined;

  const storyContext: StoryContext = {
    strip(testId: string) {
      currentTestId = testId;
    },

    title(title: string) {
      hasBegunSection = true;
      baseStory.begin(title, currentTestId);
    },

    narrate(text: string) {
      // Auto-begin with test name if not explicitly begun
      if (!hasBegunSection && currentTestName) {
        hasBegunSection = true;
        baseStory.begin(currentTestName, currentTestId);
      }
      baseStory.narrate(text);
    },

    log(result: CommandResult) {
      // Auto-begin with test name if not explicitly begun
      if (!hasBegunSection && currentTestName) {
        hasBegunSection = true;
        baseStory.begin(currentTestName, currentTestId);
      }
      baseStory.log(result);
    },

    fail(reason?: string) {
      baseStory.fail(reason);
    },
  };

  function test(name: string, fn: StoryTestFn, options?: StoryTestOptions): void;
  function test(name: string, options: StoryTestOptions, fn: StoryTestFn): void;
  function test(
    name: string,
    fnOrOptions: StoryTestFn | StoryTestOptions,
    optionsOrFn?: StoryTestOptions | StoryTestFn,
  ): void {
    const fn = typeof fnOrOptions === "function" ? fnOrOptions : (optionsOrFn as StoryTestFn);
    const options =
      typeof fnOrOptions === "object" ? fnOrOptions : (optionsOrFn as StoryTestOptions | undefined);

    const wrappedFn = async () => {
      // Reset state for this test
      currentTestId = undefined;
      hasBegunSection = false;
      currentTestName = name;

      try {
        await fn(storyContext);
      } catch (error) {
        // Auto-begin if we haven't yet (to capture the failure)
        if (!hasBegunSection) {
          hasBegunSection = true;
          baseStory.begin(name, currentTestId);
        }
        // Capture the failure
        baseStory.fail(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        // Auto-end if we began a section
        if (hasBegunSection) {
          baseStory.end();
        }
        // Reset state
        currentTestName = undefined;
        hasBegunSection = false;
        currentTestId = undefined;
      }
    };

    if (options) {
      bunTest(name, wrappedFn, options);
    } else {
      bunTest(name, wrappedFn);
    }
  }

  // Add skipIf support
  test.skipIf = (condition: boolean) => {
    return (name: string, fn: StoryTestFn, options?: StoryTestOptions) => {
      if (condition) {
        bunTest.skip(name, async () => {});
      } else {
        test(name, fn, options);
      }
    };
  };

  // Run a test without story tracking (passes through to bun:test directly)
  // Use test.noStory.skip for skipped tests without story
  test.noStory = bunTest;

  // Skip a story-aware test (still receives story context signature)
  test.skip = (name: string, _fn: StoryTestFn, _options?: StoryTestOptions) => {
    bunTest.skip(name, async () => {});
  };

  test.only = (name: string, fn: StoryTestFn, options?: StoryTestOptions) => {
    const wrappedFn = async () => {
      currentTestId = undefined;
      hasBegunSection = false;
      currentTestName = name;

      try {
        await fn(storyContext);
      } catch (error) {
        if (!hasBegunSection) {
          hasBegunSection = true;
          baseStory.begin(name, currentTestId);
        }
        baseStory.fail(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        if (hasBegunSection) {
          baseStory.end();
        }
        currentTestName = undefined;
        hasBegunSection = false;
        currentTestId = undefined;
      }
    };

    if (options) {
      bunTest.only(name, wrappedFn, options);
    } else {
      bunTest.only(name, wrappedFn);
    }
  };

  return { test };
}
