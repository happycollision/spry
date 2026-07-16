import { createRepo } from "./repo.ts";
import { cassetteEnv, cassetteKey } from "./cassette-harness.ts";
import type { TestRepo } from "./repo.ts";
import type { DocContext } from "./doc-types.ts";

/**
 * The GitHub slug the committed cassettes were recorded against. Replay MUST
 * pin this exact constant: recorded `gh` args embed it verbatim (e.g. `--repo
 * happycollision/spry-check`), and replay matches on args, so any other slug
 * would desync every replayed call from its cassette entry. Record mode never
 * uses this constant — it derives the slug from the fixture it actually
 * cloned (see `fixtureOwner`/`fixtureRepo` below), which is a different value
 * whenever a contributor records without `SPRY_TEST_REPO_OWNER` set (gh falls
 * back to their own authenticated account).
 */
const REPLAY_REPO_SLUG = "happycollision/spry-check";

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
  /**
   * Record mode ONLY: the owner/repo the fixture actually cloned (the
   * `GitHubFixture` callback parameter `withGitHubFixture` hands the caller —
   * see `tests/lib/github-fixture.ts`). REQUIRED when `recording: true`.
   *
   * This is the fix for a real footgun: `createRepo({origin: "github"})`
   * internally resolves its own owner via `SPRY_TEST_REPO_OWNER`, falling back
   * to the AUTHENTICATED gh user (`gh api user`) when unset. A contributor
   * recording without that env var set would clone/push to THEIR OWN
   * spry-check fork while `spry.repo` — if re-derived independently from env
   * — silently pinned "happycollision", pointing every `gh` query at the
   * wrong owner. Passing the fixture's already-resolved owner/repo through
   * makes the slug agree with the clone by construction: one resolution, one
   * source of truth, instead of two independent env reads that can diverge.
   * Ignored in replay (see `REPLAY_REPO_SLUG`).
   */
  fixtureOwner?: string;
  fixtureRepo?: string;
}

export interface DocRepoSetup {
  repo: TestRepo;
  /**
   * The GitHub slug pinned into `spry.repo`. In replay this is always the
   * deterministic `REPLAY_REPO_SLUG` constant (happycollision/spry-check,
   * matching the committed cassettes); in record mode it is exactly
   * `fixtureOwner/fixtureRepo` — the fixture the test actually cloned.
   */
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

  // gh needs explicit owner/repo for its GraphQL query.
  //
  // Replay's origin is a local bare repo — there is no real fixture to derive
  // a slug from — so it pins the deterministic constant the committed
  // cassettes were recorded against.
  //
  // Record mode MUST NOT re-derive the slug from env: `createRepo({origin:
  // "github"})` clones a fixture whose owner resolution (SPRY_TEST_REPO_OWNER,
  // else the AUTHENTICATED gh user) this helper cannot see from here, so a
  // second, independent env read (e.g. defaulting to "happycollision") can
  // silently diverge from the repo actually cloned — pinning `spry.repo` at a
  // different owner than the one `gh` traffic will actually hit. The caller
  // must instead pass the fixture's own resolved identity through
  // `fixtureOwner`/`fixtureRepo` (the `GitHubFixture` `withGitHubFixture` hands
  // it), making the slug agree with the clone by construction.
  let repoSlug: string;
  // The repo name used for the github-host scrub below: the fixture's own name
  // in record mode, and the name baked into REPLAY_REPO_SLUG in replay (both
  // "spry-check" today, but this keeps the scrub keyed off the same source of
  // truth as repoSlug rather than a third, independent env read).
  let scrubRepoName: string;
  if (options.recording) {
    if (!options.fixtureOwner || !options.fixtureRepo) {
      throw new Error(
        "setupDocRepo: recording mode requires fixtureOwner + fixtureRepo (the " +
          "GitHubFixture's resolved owner/repo) so spry.repo cannot diverge from " +
          "the fixture actually cloned.",
      );
    }
    repoSlug = `${options.fixtureOwner}/${options.fixtureRepo}`;
    scrubRepoName = options.fixtureRepo;
  } else {
    repoSlug = REPLAY_REPO_SLUG;
    scrubRepoName = REPLAY_REPO_SLUG.split("/", 2)[1] ?? REPLAY_REPO_SLUG;
  }

  // This test's namespace on the fixture repo, keyed by the FULL sanitized
  // section + order — the SAME key `cassetteKey` (tests/lib/cassette-harness.ts)
  // uses for the cassette filename, e.g. "commands/sync" + 20 ->
  // "commands__sync--020". Deterministic per test, never per run: both names
  // end up in recorded gh args, so they must be byte-identical between record
  // and replay. Sharing `cassetteKey` (rather than re-deriving a similar key
  // here) is what makes namespace and cassette keying provably agree: two
  // sections can never collide in one without also colliding in the other,
  // because both come from one function. The key is embedded in git ref names
  // (`trunk/<key>`, `spry/t-<key>/...`) — `cassetteKey`'s sanitization (`/` ->
  // `__`, zero-padded order, otherwise alphanumeric) produces a valid git ref
  // path component (no `..`, no leading/trailing `/`, no `~^:?*[\`, no `@{`, no
  // `//`).
  const namespaceKey = cassetteKey({ section: options.section, order: options.order });
  const trunkName =
    options.trunk === "default-branch" ? repo.defaultBranch : `trunk/${namespaceKey}`;
  const branchPrefix = `spry/t-${namespaceKey}`;

  // 1. github-host canonicalization — BEFORE doc.scrub(repo); see above. Built
  //    from the same repo-name source as repoSlug so a renamed fixture repo
  //    can't silently resurrect the ordering bug.
  doc.scrub(
    new RegExp(`https://github\\.com/[^/]+/${escapeRegExp(scrubRepoName)}`, "g"),
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
