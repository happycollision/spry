import { $ } from "bun";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { generateUniqueId } from "./unique-id.ts";
import { createRealGitRunner } from "../../src/lib/context.ts";
import { createGitHubFixture } from "./github-fixture.ts";
import type { GitRunner } from "./context.ts";

export interface TestRepo {
  path: string;
  originPath: string;
  uniqueId: string;
  defaultBranch: string;
  git: GitRunner;

  commit(message?: string): Promise<string>;
  commitFiles(files: Record<string, string>, message?: string): Promise<string>;
  branch(name: string): Promise<string>;
  checkout(name: string): Promise<void>;
  fetch(): Promise<void>;
  currentBranch(): Promise<string>;
  cleanup(): Promise<void>;
}

export interface CreateRepoOptions {
  defaultBranch?: string;
  /**
   * Where `git push` targets. "local" (default) creates a bare origin on disk
   * — fully offline, today's behavior. "github" clones the verified spry-check
   * repo so pushes hit real GitHub (record mode; needs auth).
   */
  origin?: "local" | "github";
}

// Pinned author/committer identity + dates so that, given the same tree,
// parents, and message, git produces a byte-stable commit SHA. Without this,
// floating commit timestamps make every recorded SHA non-reproducible.
export const DETERMINISTIC_GIT_ENV = {
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
} as const;

const commitEnv = { ...process.env, ...DETERMINISTIC_GIT_ENV };

// Disk-path uniqueness counter. The on-disk temp paths must always be unique
// (even when two repos share a seeded, deterministic uniqueId), but this
// counter never leaks into commit identity, so it does not affect SHAs.
let pathCounter = 0;

export async function createRepo(options?: CreateRepoOptions): Promise<TestRepo> {
  const uniqueId = generateUniqueId();
  const defaultBranch = options?.defaultBranch ?? "main";
  const origin = options?.origin ?? "local";
  // Path suffix is independent of uniqueId so seeded (identical-uniqueId)
  // repos still land in distinct temp directories.
  const pathSuffix = `${process.pid}-${pathCounter++}`;
  const workPath = `/tmp/spry-test-${pathSuffix}`;

  // Per-repo commit counter so a fresh repo always starts at the same
  // sequence (first commit -> file-1.txt, second -> file-2.txt, ...).
  let counter = 0;

  let originPath: string;
  if (origin === "github") {
    // Push targets real GitHub: clone the verified spry-check repo (the fixture
    // resolves + safety-checks the URL). originPath records the remote URL.
    const fixture = await createGitHubFixture();
    originPath = fixture.repoUrl;
    await $`git clone ${fixture.repoUrl} ${workPath}`.quiet();
  } else {
    originPath = `/tmp/spry-test-origin-${pathSuffix}`;
    // Create bare origin
    await $`git init --bare ${originPath} --initial-branch=${defaultBranch}`.quiet();
    // Create working clone
    await $`git clone ${originPath} ${workPath}`.quiet();
  }
  await $`git -C ${workPath} config user.email "test@example.com"`.quiet();
  await $`git -C ${workPath} config user.name "Test User"`.quiet();

  // A "github" clone already has the real repo's history (its default branch),
  // so we must NOT fabricate an initial commit or push to the remote's main —
  // that would mutate the real test repo. Only a fresh local bare origin needs
  // seeding with an initial commit.
  if (origin === "local") {
    const initFile = join(workPath, "README.md");
    await Bun.write(initFile, "# Test repo\n");
    await $`git -C ${workPath} add .`.quiet();
    await $`git -C ${workPath} commit -m "Initial commit"`.env(commitEnv).quiet();
    await $`git -C ${workPath} push origin ${defaultBranch}`.quiet();
  }

  async function commit(message?: string): Promise<string> {
    counter++;
    const filename = `file-${counter}.txt`;
    const msg = message ?? `Commit ${counter}`;
    await Bun.write(join(workPath, filename), `Content: ${msg}\n`);
    await $`git -C ${workPath} add .`.quiet();
    await $`git -C ${workPath} commit -m ${msg}`.env(commitEnv).quiet();
    return (await $`git -C ${workPath} rev-parse HEAD`.quiet().text()).trim();
  }

  async function commitFiles(files: Record<string, string>, message?: string): Promise<string> {
    counter++;
    const msg = message ?? `Commit ${counter}`;
    for (const [name, content] of Object.entries(files)) {
      const filePath = join(workPath, name);
      const dir = join(filePath, "..");
      await mkdir(dir, { recursive: true });
      await Bun.write(filePath, content);
    }
    await $`git -C ${workPath} add .`.quiet();
    await $`git -C ${workPath} commit -m ${msg}`.env(commitEnv).quiet();
    return (await $`git -C ${workPath} rev-parse HEAD`.quiet().text()).trim();
  }

  async function branch(name: string): Promise<string> {
    const branchName = `${name}-${uniqueId}`;
    await $`git -C ${workPath} checkout -b ${branchName}`.quiet();
    return branchName;
  }

  async function checkout(name: string): Promise<void> {
    await $`git -C ${workPath} checkout ${name}`.quiet();
  }

  async function fetch(): Promise<void> {
    await $`git -C ${workPath} fetch origin`.quiet();
  }

  async function currentBranch(): Promise<string> {
    return (await $`git -C ${workPath} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
  }

  // Deterministic git runner bound to this repo. Defaults cwd to the working
  // tree and injects the pinned identity/date env so test-authored commits
  // (created via raw git, not repo.commit) are also byte-stable. Callers can
  // still override cwd or individual env vars explicitly.
  const realGit = createRealGitRunner();
  const git: GitRunner = {
    run(args, options) {
      return realGit.run(args, {
        ...options,
        cwd: options?.cwd ?? workPath,
        env: { ...process.env, ...DETERMINISTIC_GIT_ENV, ...options?.env },
      });
    },
  };

  async function cleanup(): Promise<void> {
    await rm(workPath, { recursive: true, force: true });
    // For a "github" origin, originPath is a remote URL, not a local path —
    // nothing on disk to remove.
    if (origin === "local") {
      await rm(originPath, { recursive: true, force: true });
    }
  }

  return {
    path: workPath,
    originPath,
    uniqueId,
    defaultBranch,
    git,
    commit,
    commitFiles,
    branch,
    checkout,
    fetch,
    currentBranch,
    cleanup,
  };
}
