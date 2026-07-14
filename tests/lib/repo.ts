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
  /**
   * Random source for the generated uniqueId (default: Math.random). Pass a
   * seeded rng (`createSeededRng`) when a test needs deterministic ids —
   * per-call, so seeding never mutates shared state across concurrent tests.
   */
  uniqueIdRng?: () => number;
}

// Pinned author/committer identity so commit objects never depend on local
// git config. Dates are deliberately NOT pinned to a constant: each commit
// gets a per-run seeded date (see globalDateCounter below).
//
// Byte-stable SHAs are not needed anywhere — no cassette contains a SHA, no
// doc test asserts a literal SHA, and the doc scrubber maps SHAs to a pool by
// discovery order, not value. What IS load-bearing is a stable ORDER + COUNT
// from the scrubber's `git log --all --reflog` walk, and distinct
// monotonically increasing dates give that walk a total order over
// independently created commits (stronger than the previous all-identical
// pinned date); rewrite-inherited dates (e.g. `sp group`'s rewrite path copies
// committer dates from the originals) can still tie, resolved deterministically
// by git's commit-queue order. Per-run uniqueness is the point:
// GitHub accumulates check runs on a SHA reused across recording sessions,
// which trips `sp land`'s readiness gate with stale pending rollups.
export const DETERMINISTIC_GIT_ENV = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
} as const;

// Per-run base for seeded commit dates, derived once at process start so every
// run's SHAs are unique. Shifted ~11 years into the past so commits made
// WITHOUT this env (e.g. TUI-harness bookkeeping writes to refs/spry/*, which
// use wall-clock dates) always sort strictly newer than every seeded commit —
// keeping the scrubber's date-ordered walk deterministic. Headroom: seeded
// dates would only cross wall clock after ~100k ticks in one process; ticks
// accrue per git-runner call (including reads), and a full suite burns a few
// thousand.
const RUN_BASE_SECONDS = Math.floor(Date.now() / 1000) - 100_000 * 3600;

// PROCESS-GLOBAL date counter, shared by every repo. Global (not per-repo) on
// purpose: two repos in one run that replay the same setup sequence against
// the same clone baseline would otherwise mint IDENTICAL SHAs (same tree,
// parent, message, identity, and per-repo tick) — re-creating the in-run half
// of the GitHub check-run accumulation trap (observed: the two land doc tests
// collided, and the second one's readiness gate tripped on the first one's
// check runs). A shared counter makes every seeded date unique process-wide
// while keeping each repo's dates strictly monotonic. Increments are
// synchronous on the JS thread, so concurrent tests cannot race a tick.
let globalDateCounter = 0;

// Disk-path uniqueness counter. The on-disk temp paths must always be unique
// (even when two repos share a seeded, deterministic uniqueId), but this
// counter never leaks into commit identity, so it does not affect SHAs.
let pathCounter = 0;

export async function createRepo(options?: CreateRepoOptions): Promise<TestRepo> {
  const uniqueId = generateUniqueId(options?.uniqueIdRng);
  const defaultBranch = options?.defaultBranch ?? "main";
  const origin = options?.origin ?? "local";
  // Path suffix is independent of uniqueId so seeded (identical-uniqueId)
  // repos still land in distinct temp directories.
  const pathSuffix = `${process.pid}-${pathCounter++}`;
  const workPath = `/tmp/spry-test-${pathSuffix}`;

  // Per-repo commit counter so a fresh repo always starts at the same
  // sequence (first commit -> file-1.txt, second -> file-2.txt, ...).
  let counter = 0;

  // Every git invocation that might create a commit advances the seeded clock
  // by one hour from the per-run base (via the process-global counter above),
  // so commit dates are unique process-wide and monotonically increasing
  // within this repo.
  function nextDateEnv(): { GIT_AUTHOR_DATE: string; GIT_COMMITTER_DATE: string } {
    globalDateCounter++;
    // Git's internal "<epoch> <offset>" date format — unambiguous, no parsing.
    const date = `${RUN_BASE_SECONDS + globalDateCounter * 3600} +0000`;
    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  }
  function commitEnv(): Record<string, string> {
    return { ...process.env, ...DETERMINISTIC_GIT_ENV, ...nextDateEnv() };
  }

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
    await $`git -C ${workPath} commit -m "Initial commit"`.env(commitEnv()).quiet();
    await $`git -C ${workPath} push origin ${defaultBranch}`.quiet();
  }

  async function commit(message?: string): Promise<string> {
    counter++;
    const filename = `file-${counter}.txt`;
    const msg = message ?? `Commit ${counter}`;
    await Bun.write(join(workPath, filename), `Content: ${msg}\n`);
    await $`git -C ${workPath} add .`.quiet();
    await $`git -C ${workPath} commit -m ${msg}`.env(commitEnv()).quiet();
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
    await $`git -C ${workPath} commit -m ${msg}`.env(commitEnv()).quiet();
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

  // Seeded git runner bound to this repo. Defaults cwd to the working tree and
  // injects the pinned identity plus the advancing per-run date env, so
  // test-authored commits (created via raw git, not repo.commit) also get
  // distinct monotonic dates. Every run() call ticks the date counter — a tick
  // without a commit is harmless (dates stay monotonic and unique). Caveat: a
  // single git invocation that creates MULTIPLE commits (rebase, cherry-pick
  // range) would stamp them all with one date; no current test does this.
  // Callers can still override cwd or individual env vars explicitly.
  const realGit = createRealGitRunner();
  const git: GitRunner = {
    run(args, options) {
      return realGit.run(args, {
        ...options,
        cwd: options?.cwd ?? workPath,
        env: { ...commitEnv(), ...options?.env },
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
