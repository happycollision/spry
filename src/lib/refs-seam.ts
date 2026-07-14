/**
 * Test seam for the REMOTE names of spry's shared bookkeeping refs.
 *
 * `refs/spry/prs` (PR cache) and `refs/spry/groups` (group records) are
 * repo-wide refs on the remote: every collaborator's `sp sync`/`sp group`/
 * `sp land` fetches and best-effort pushes the same two refs. For humans the
 * occasional non-fast-forward rejection is a benign `⚠` warning; for the
 * record-mode doc tests — which run concurrently against ONE shared fixture
 * repo, each in its own trunk/branch namespace (see tests/lib/doc-repo.ts) —
 * those nondeterministic warnings leak into captured output and churn the
 * generated docs.
 *
 * `SPRY_REMOTE_REFS_PREFIX` remaps the REMOTE side of those refs (e.g.
 * `refs/spry/t-sync-020`, giving `refs/spry/t-sync-020/prs`), so each test's
 * subprocesses share bookkeeping only with themselves. Local ref names are
 * deliberately untouched: tests and helpers that read/write the local refs
 * in-process keep working, and production behavior is byte-identical when the
 * variable is unset (the default is the local name itself).
 *
 * Read at call time (not module load) so it always reflects the subprocess
 * env the test harness handed to `sp`. Same pattern as the gh cassette seam
 * (`src/lib/gh-seam.ts`, `SPRY_GH_CASSETTE*`).
 */
export function remoteSpryRef(
  localRef: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const prefix = env.SPRY_REMOTE_REFS_PREFIX;
  if (!prefix) return localRef;
  // Lookahead keeps the match anchored to the "refs/spry" path SEGMENT, so a
  // hypothetical "refs/spryware/x" is never remapped.
  return localRef.replace(/^refs\/spry(?=\/)/, prefix);
}
