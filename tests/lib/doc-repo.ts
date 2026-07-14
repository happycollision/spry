import { createRepo } from "./repo.ts";
import { cassetteEnv } from "./cassette-harness.ts";
import type { TestRepo } from "./repo.ts";
import type { DocContext } from "./doc-types.ts";

export interface SetupDocRepoOptions {
  /** True under `SPRY_RECORD=1` (pass `isRecording()`). */
  recording: boolean;
  /** Doc section, e.g. "commands/sync" — also keys the cassette. */
  section: string;
  /** Doc order within the section — also keys the cassette. */
  order: number;
  /**
   * Test seam: override the repo factory so this helper can be unit-tested in
   * fake-record mode without cloning real GitHub. A per-call option (not a
   * module global like `__setFixtureFactoryForTest`) because in replay the doc
   * tests themselves go through this factory — a global override would race
   * them under `bun test --concurrent`.
   */
  createRepoFn?: typeof createRepo;
}

export interface DocRepoSetup {
  repo: TestRepo;
  /** The GitHub slug pinned into `spry.repo` (default happycollision/spry-check). */
  repoSlug: string;
  /** Env block for subprocesses so the gh seam records/replays this test's cassette. */
  env: Record<string, string>;
}

/**
 * The invariant setup prefix shared by every live-fixture (cassette-backed)
 * doc test: create the repo against the right origin, register the
 * determinism scrubs, and pin the spry config. Per-test additions (extra
 * scrubs, group records, tracked branches, commits) stay in the test body.
 *
 * Scrub registration order is LOAD-BEARING and is the reason this helper
 * exists. Substitutions apply in registration order, and in record mode
 * `repo.originPath` IS the fixture URL (https://github.com/<owner>/spry-check)
 * — so the github-host canonicalization MUST be registered before
 * `doc.scrub(repo)`. Reversed, the repo scrub rewrites that URL prefix to
 * /tmp/repo-origin, shadowing the host canonicalization and leaking a
 * divergent, non-deterministic PR URL into the generated docs. (In replay the
 * originPath is a /tmp path, so the order is moot — which is exactly how the
 * bug would hide until the next recording.)
 */
export async function setupDocRepo(
  doc: DocContext,
  options: SetupDocRepoOptions,
): Promise<DocRepoSetup> {
  // Record mode drives the real spry-check repo; replay (default) pushes to a
  // local bare origin and serves gh traffic from the committed cassette.
  const makeRepo = options.createRepoFn ?? createRepo;
  const repo = await makeRepo({ origin: options.recording ? "github" : "local" });

  // 1. github-host canonicalization — BEFORE doc.scrub(repo); see above.
  doc.scrub(/https:\/\/github\.com\/[^/]+\/spry-check/g, "https://github.com/owner/repo");
  // 2. Repo paths + uniqueId.
  doc.scrub(repo);
  // 3. PR numbers are GitHub-minted (non-deterministic); canonicalize every
  //    doc'd form so the generated docs stay stable across re-recordings.
  doc.scrub(/Created PR #\d+/g, "Created PR #42");
  doc.scrub(/pull\/\d+/g, "pull/42");
  doc.scrub(/parked PR #\d+/g, "parked PR #42");
  doc.scrub(/retargeted PR #\d+/g, "retargeted PR #42");

  await repo.git.run(["config", "spry.trunk", "main"]);
  await repo.git.run(["config", "spry.remote", "origin"]);
  await repo.git.run(["config", "spry.branchPrefix", "spry/dondenton"]);
  // gh needs explicit owner/repo for its GraphQL query. In replay the origin is
  // a local bare repo, so pin the slug to whatever the committed cassette was
  // recorded against (defaults to the maintainer's spry-check).
  const repoSlug = `${process.env.SPRY_TEST_REPO_OWNER ?? "happycollision"}/${process.env.SPRY_TEST_REPO_NAME ?? "spry-check"}`;
  await repo.git.run(["config", "spry.repo", repoSlug]);

  return {
    repo,
    repoSlug,
    env: cassetteEnv({ section: options.section, order: options.order }),
  };
}
