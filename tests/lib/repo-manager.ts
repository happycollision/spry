import { afterAll } from "bun:test";
import { createRepo } from "./repo.ts";
import type { TestRepo, CreateRepoOptions } from "./repo.ts";

export interface RepoManager {
  create(options?: CreateRepoOptions): Promise<TestRepo>;
}

/**
 * Tracks every repo created through it and cleans them all up in `afterAll`.
 *
 * Cleanup is deliberately afterAll, not afterEach: under `bun test
 * --concurrent`, an afterEach hook fires when ANY test in the file finishes
 * and would delete temp repos out from under still-running sibling tests
 * (git then fails with "cannot change to /tmp/spry-test-...")). Deferring to
 * afterAll means repos accumulate on disk until the file's tests finish,
 * which is cheap and safe.
 */
export function repoManager(): RepoManager {
  const activeRepos: TestRepo[] = [];

  afterAll(async () => {
    for (const repo of activeRepos) {
      await repo.cleanup();
    }
    activeRepos.length = 0;
  });

  return {
    async create(options?: CreateRepoOptions): Promise<TestRepo> {
      const repo = await createRepo(options);
      activeRepos.push(repo);
      return repo;
    },
  };
}
