import { describe, test, expect, afterEach } from "bun:test";
import { analyzeStack } from "../../src/commands/stack-analysis.ts";
import type { StackAnalysis } from "../../src/commands/stack-analysis.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";
import type { SpryConfig } from "../../src/git/index.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import type { PRCache } from "../../src/gh/pr-cache.ts";
import type { GitRunner } from "../../src/lib/context.ts";

const repos: TestRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) {
    const r = repos.pop();
    if (r) await r.cleanup();
  }
});

function cfg(): SpryConfig {
  return {
    trunk: "main",
    remote: "origin",
    branchPrefix: "spry/test",
    repo: undefined,
    owner: undefined,
    autoDeleteOnLand: false,
  } as SpryConfig;
}

async function makeRepo(): Promise<TestRepo> {
  const repo = await createRepo();
  repos.push(repo);
  return repo;
}

describe("analyzeStack", () => {
  test("empty stack → empty analysis", async () => {
    const repo = await makeRepo();
    const git = createRealGitRunner();
    const ctx: { git: GitRunner } = {
      git: { run: (args, opts) => git.run(args, { ...opts, cwd: repo.path }) },
    };
    const analysis: StackAnalysis = await analyzeStack(ctx, {
      units: [] as PRUnit[],
      commits: [],
      prCache: {} as PRCache,
      config: cfg(),
    });
    expect(analysis.units).toEqual([]);
  });
});
