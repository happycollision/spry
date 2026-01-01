import { test, expect, describe } from "bun:test";
import { repoManager } from "../../../tests/helpers/local-repo.ts";
import { runLand } from "../../../tests/integration/helpers.ts";

const repos = repoManager();

describe("cli/commands/land", () => {
  test("reports when stack is empty", async () => {
    const repo = await repos.create();
    // No commits beyond merge-base

    const result = await runLand(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits in stack");
  });

  test("reports when there are commits but no open PRs", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    // Create commits with IDs (so they're valid PR units)
    await repo.commit("First commit", { trailers: { "Taspr-Commit-Id": "id111111" } });
    await repo.commit("Second commit", { trailers: { "Taspr-Commit-Id": "id222222" } });

    const result = await runLand(repo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No open PRs in stack");
  });

  test("handles validation error for unclosed group", async () => {
    const repo = await repos.create();
    await repo.branch("feature");

    // Create a group start without a corresponding end
    await repo.commit("Start group", {
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

  // TODO: Add tests for actual landing once VCR-style testing is implemented
  // See: taspr-xtq (VCR-style testing for GitHub API calls)
  //
  // Tests needed:
  // - Land ready PR → success, branch deleted
  // - Land non-ready PR (not fast-forwardable) → error with reason
  // - PR not found → appropriate error message
});
