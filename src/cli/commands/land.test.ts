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
    await scenarios.withSpryIds.setup(repo);

    const result = await runLand(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No open PRs in stack");
  });

  test("handles validation error for split group", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    // Create a split group (non-contiguous commits with same Spry-Group)
    await repo.commit({
      message: "Group commit 1",
      trailers: {
        "Spry-Commit-Id": "id111111",
        "Spry-Group": "grp1",
        "Spry-Group-Title": "My Group",
      },
    });
    await repo.commit({
      message: "Interrupting commit",
      trailers: {
        "Spry-Commit-Id": "id222222",
      },
    });
    await repo.commit({
      message: "Group commit 2",
      trailers: {
        "Spry-Commit-Id": "id333333",
        "Spry-Group": "grp1",
        "Spry-Group-Title": "My Group",
      },
    });

    const result = await runLand(repo.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Split group");
  });

  // GitHub integration tests for landing are in tests/integration/land.test.ts
});
