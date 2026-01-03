import { test, expect, describe } from "bun:test";
import { repoManager } from "../../../tests/helpers/local-repo.ts";
import { runLand } from "../../../tests/integration/helpers.ts";
import { scenarios } from "../../scenario/definitions.ts";

const repos = repoManager();

describe("cli/commands/land", () => {
  test("reports when stack is empty", async () => {
    const repo = await repos.create();
    await scenarios.emptyStack.setup(repo);

    const result = await runLand(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("reports when there are commits but no open PRs", async () => {
    const repo = await repos.create();
    await scenarios.withTasprIds.setup(repo);

    const result = await runLand(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No open PRs in stack");
  });

  test("handles validation error for unclosed group", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    // Create a group start without a corresponding end
    await repo.commit({
      trailers: {
        "Taspr-Commit-Id": "id333333",
        "Taspr-Group-Start": "grp1",
        "Taspr-Group-Title": "My Group",
      },
    });

    const result = await runLand(repo.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unclosed group");
  });

  // GitHub integration tests for landing are in tests/integration/land.test.ts
});
