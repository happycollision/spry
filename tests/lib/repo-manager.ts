import { afterEach } from "bun:test";
import { createRepo } from "./repo.ts";
import type { TestRepo, CreateRepoOptions } from "./repo.ts";

export interface RepoManager {
  create(options?: CreateRepoOptions): Promise<TestRepo>;
}

export function repoManager(): RepoManager {
  const activeRepos: TestRepo[] = [];

  afterEach(async () => {
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
