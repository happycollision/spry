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
   * Trunk strategy. `"per-test"` (default) pushes `trunk/<leaf>-<order>` from
   * the repo's baseline commit and pins `spry.trunk` to it, giving this test
   * its own namespace on the shared fixture repo so record-mode tests are
   * mutually independent and can run in parallel. `"default-branch"` keeps
   * `spry.trunk` on the repo's real default branch — reserved for the ONE
   * canonical land test, the standing validation that `sp land`'s ff-push
   * flips the trunk-based PR to MERGED on a real default branch exactly as in
   * a real repo (see docs/rebuild-roadmap.md and beads spry-tm2l).
   */
  trunk?: "per-test" | "default-branch";
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
  /**
   * The branch `spry.trunk` is pinned to. Per-test trunks are scrubbed to the
   * default branch in the generated docs, so the docs keep telling the `main`
   * story. Pinned PER TEST (not per run) — trunk names appear in recorded gh
   * args (`pr create --base <trunk>`), i.e. they are cassette keys.
   */
  trunkName: string;
  /**
   * The per-test `spry.branchPrefix` (scrubbed to `spry/dondenton` in the
   * generated docs). Like the trunk name, it is a cassette key: branch names
   * derived from it appear in recorded gh args.
   */
  branchPrefix: string;
}

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The invariant setup prefix shared by every live-fixture (cassette-backed)
 * doc test: create the repo against the right origin, register the
 * determinism scrubs, carve out this test's namespace (per-test trunk +
 * branch prefix), and pin the spry config. Per-test additions (extra scrubs,
 * group records, tracked branches, commits) stay in the test body.
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

  // gh needs explicit owner/repo for its GraphQL query. In replay the origin is
  // a local bare repo, so pin the slug to whatever the committed cassette was
  // recorded against (defaults to the maintainer's spry-check).
  const repoOwner = process.env.SPRY_TEST_REPO_OWNER ?? "happycollision";
  const repoName = process.env.SPRY_TEST_REPO_NAME ?? "spry-check";
  const repoSlug = `${repoOwner}/${repoName}`;

  // This test's namespace on the fixture repo, keyed by section leaf + order
  // exactly like the cassette file. Deterministic per test, never per run:
  // both names end up in recorded gh args, so they must be byte-identical
  // between record and replay.
  const sectionLeaf = options.section.split("/").pop() ?? options.section;
  const namespaceKey = `${sectionLeaf}-${String(options.order).padStart(3, "0")}`;
  const trunkName =
    options.trunk === "default-branch" ? repo.defaultBranch : `trunk/${namespaceKey}`;
  const branchPrefix = `spry/t-${namespaceKey}`;

  // 1. github-host canonicalization — BEFORE doc.scrub(repo); see above. Built
  //    from the env-derived repo name so a renamed fixture repo can't silently
  //    resurrect the ordering bug.
  doc.scrub(
    new RegExp(`https://github\\.com/[^/]+/${escapeRegExp(repoName)}`, "g"),
    "https://github.com/owner/repo",
  );
  // 2. Repo paths + uniqueId.
  doc.scrub(repo);
  // 3. PR numbers are GitHub-minted (non-deterministic); canonicalize every
  //    doc'd form so the generated docs stay stable across re-recordings.
  doc.scrub(/Created PR #\d+/g, "Created PR #42");
  doc.scrub(/pull\/\d+/g, "pull/42");
  doc.scrub(/parked PR #\d+/g, "parked PR #42");
  doc.scrub(/retargeted PR #\d+/g, "retargeted PR #42");
  // 4. Per-test namespace canonicalization: the generated docs keep telling
  //    the `main` + `spry/dondenton` story no matter which namespace the test
  //    actually ran in.
  if (trunkName !== repo.defaultBranch) {
    doc.scrub(trunkName, repo.defaultBranch);
  }
  doc.scrub(branchPrefix, "spry/dondenton");

  if (trunkName !== repo.defaultBranch) {
    // Establish this test's trunk at the fixture baseline. The baseline is the
    // repo's ROOT commit — invariant even if the canonical land test has
    // transiently advanced the default branch (it is the only actor that moves
    // it, and it restores it afterward) — and simply the default branch tip in
    // replay. Both repos have exactly one root (setup-spry-check.ts force-pushes
    // a single commit; createRepo seeds one initial commit).
    const baseline = (
      await repo.git.run(["rev-list", "--max-parents=0", `origin/${repo.defaultBranch}`])
    ).stdout.trim();
    // Guard the local side of the same race: if the clone caught the default
    // branch mid-advance, rebuild the working branch on the baseline so the
    // test's stack never contains another test's commits.
    await repo.git.run(["reset", "--hard", baseline]);
    await repo.git.run(["push", "origin", `${baseline}:refs/heads/${trunkName}`]);
    // Pin the remote-tracking ref explicitly (push updates it on modern git,
    // but sp resolves the stack against `origin/<trunk>`, so make it certain).
    await repo.git.run(["update-ref", `refs/remotes/origin/${trunkName}`, baseline]);
  }

  await repo.git.run(["config", "spry.trunk", trunkName]);
  await repo.git.run(["config", "spry.remote", "origin"]);
  await repo.git.run(["config", "spry.branchPrefix", branchPrefix]);
  await repo.git.run(["config", "spry.repo", repoSlug]);

  return {
    repo,
    repoSlug,
    // Derive the env from THIS call's recording option (not the global
    // isRecording()) so a caller can never get a self-contradictory setup
    // (github origin + replay env, or vice versa).
    env: {
      ...cassetteEnv({
        section: options.section,
        order: options.order,
        recording: options.recording,
      }),
      // Namespace the REMOTE side of spry's shared bookkeeping refs
      // (refs/spry/prs, refs/spry/groups) per test, mirroring the trunk/prefix
      // namespace: concurrent record-mode tests would otherwise contend on
      // those two repo-wide refs and leak nondeterministic `⚠ Could not
      // push/fetch ...` warnings into the docs. Identity when unset — see
      // src/lib/refs-seam.ts. Set in replay too, so record and replay run
      // byte-identical git commands.
      SPRY_REMOTE_REFS_PREFIX: `refs/spry/t-${namespaceKey}`,
    },
    trunkName,
    branchPrefix,
  };
}
