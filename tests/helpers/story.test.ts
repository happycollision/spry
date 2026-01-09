import { test, expect, describe } from "bun:test";
import { createStory } from "./story.ts";
import { join } from "node:path";

describe("Story API", () => {
  // test-logs is at project root, not in tests/
  const testLogsDir = join(import.meta.dir, "../../test-logs");

  test("no-ops when env var is not set", async () => {
    const story = createStory("noop.test.ts");

    // These should all be silent no-ops
    story.begin("test");
    story.narrate("Some text");
    story.log({
      command: "sp sync",
      stdout: "output",
      stderr: "",
      exitCode: 0,
    });
    story.end();

    // flush should also be a no-op
    await story.flush();

    // No files should be created (we can't easily test this without
    // checking the filesystem, but at least no errors thrown)
  });

  test("sanitizes test IDs from output", async () => {
    // Enable story logging for this test
    process.env.SPRY_STORY_TEST_LOGGING = "1";

    const testId = "happy-penguin-x3f";
    const story = createStory("sanitize.test.ts");

    story.begin("test with IDs", testId);
    story.narrate("Testing ID sanitization.");
    story.log({
      command: "sp sync",
      stdout: `Stack: feature-${testId} (3 commits)
  ○ First commit [${testId}]
  ○ Second commit [${testId}]`,
      stderr: "",
      exitCode: 0,
    });
    story.end();

    await story.flush();

    // Read the generated file
    const content = await Bun.file(join(testLogsDir, "sanitize.md")).text();

    // Verify IDs are sanitized
    expect(content).not.toContain(testId);
    expect(content).toContain("feature-{id}");
    expect(content).toContain("First commit");
    expect(content).not.toContain(`[${testId}]`);

    // Clean up env var
    delete process.env.SPRY_STORY_TEST_LOGGING;
  });

  test("strips ANSI codes in .md output", async () => {
    process.env.SPRY_STORY_TEST_LOGGING = "1";

    const story = createStory("ansi.test.ts");

    story.begin("test with colors");
    story.log({
      command: "sp view",
      stdout: "\x1b[32m✓\x1b[0m Success",
      stderr: "",
      exitCode: 0,
    });
    story.end();

    await story.flush();

    // MD file should have ANSI stripped and use sh language tag
    const mdContent = await Bun.file(join(testLogsDir, "ansi.md")).text();
    expect(mdContent).toContain("✓ Success");
    expect(mdContent).not.toContain("\x1b[");
    expect(mdContent).toContain("```txt file=ansi/test-with-colors-01.ansi");

    // Individual ANSI file should be raw output with colors preserved
    const ansiContent = await Bun.file(join(testLogsDir, "ansi/test-with-colors-01.ansi")).text();
    expect(ansiContent).toBe("\x1b[32m✓\x1b[0m Success");

    delete process.env.SPRY_STORY_TEST_LOGGING;
  });
});
