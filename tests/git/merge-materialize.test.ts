import { describe, expect, test } from "bun:test";
import { createRealGitRunner, repoManager } from "../lib/index.ts";
import type { TestRepo } from "../lib/index.ts";
import {
  buildMaterializePlan,
  materialize,
  finalizeRewrite,
  getExpandedStackCommits,
  getStackCommits,
  getMergeBase,
  injectMissingIds,
  rewriteCommitChain,
  saveAllMergeGroupRecords,
  loadMergeGroupRecords,
  buildCommitMergeGroupMap,
} from "../../src/git/index.ts";
import { parseCommitTrailers } from "../../src/parse/index.ts";
import { createInitialState, applyEvent, extractResult } from "../../src/tui/group-state.ts";

// End-to-end tests for materialized merge groups against real git.
//
// Two things are covered here that unit tests on the pure state machine cannot
// reach: (1) that the TUI's `enter` output drives the SAME materialization as
// the equivalent `sp group --apply` document — `--apply` is the oracle — and
// (2) that a materialized merge SURVIVES the shared plumbing that every spry
// command runs (injectMissingIds / rewriteCommitChain), which it previously
// did not.

const git = createRealGitRunner();
const repos = repoManager();

interface Stack {
  repo: TestRepo;
  ref: string;
  /** The real branch name — `repo.branch()` suffixes a unique id. */
  branch: string;
}

/** A repo whose branch has `count` commits above trunk, each with a stamped id. */
async function stackedRepo(count: number): Promise<Stack> {
  const repo = await repos.create();
  const ref = `origin/${repo.defaultBranch}`;
  const branch = await repo.branch("feature");
  for (let i = 1; i <= count; i++) {
    await repo.commitFiles({ [`f${i}.txt`]: `change ${i}\n` }, `Commit ${i}`);
  }
  const injected = await injectMissingIds(git, ref, { cwd: repo.path });
  expect(injected.ok).toBe(true);
  return { repo, ref, branch };
}

/** Ordered ids + id→sha for the (expanded) stack. */
async function stackIds(
  repo: TestRepo,
  ref: string,
): Promise<{ ids: string[]; hashById: Record<string, string> }> {
  const commits = await getExpandedStackCommits(git, ref, { cwd: repo.path });
  const withTrailers = parseCommitTrailers(commits, git, { cwd: repo.path });
  const ids: string[] = [];
  const hashById: Record<string, string> = {};
  for (const c of withTrailers) {
    const id = c.trailers["Spry-Commit-Id"];
    if (!id) continue;
    ids.push(id);
    hashById[id] = c.hash;
  }
  return { ids, hashById };
}

/** "<sha> <parentCount>" per first-parent commit, newest last. */
async function firstParentShape(repo: TestRepo, ref: string): Promise<string[]> {
  const commits = await getStackCommits(git, ref, { cwd: repo.path });
  return commits.map((c) => `${c.subject}:${c.parents?.length ?? 0}`);
}

/** Materialize `specs` and move the branch, exactly as the commands do. */
async function materializeGroups(
  stack: Stack,
  specs: { memberIds: string[]; message: string }[],
): Promise<void> {
  const { repo, ref, branch } = stack;
  const { ids, hashById } = await stackIds(repo, ref);
  const built = buildMaterializePlan(ids, hashById, specs, {});
  if (!built.ok) throw new Error(`buildMaterializePlan: ${built.error}`);

  const firstParent = await getStackCommits(git, ref, { cwd: repo.path });
  const oldTip = firstParent.at(-1)?.hash;
  if (!oldTip) throw new Error("empty stack");
  const mergeBase = await getMergeBase(git, ref, { cwd: repo.path });

  const result = await materialize(git, mergeBase, built.plan, { cwd: repo.path });
  if (!result.ok) throw new Error(`materialize conflict at ${result.conflictSha}`);
  await finalizeRewrite(git, branch, oldTip, result.newTip, { cwd: repo.path });

  const records: Record<string, { members: string[] }> = {};
  specs.forEach((s, i) => (records[`mg${i + 1}`] = { members: s.memberIds }));
  await saveAllMergeGroupRecords(git, records, { cwd: repo.path });
}

describe("materialize", () => {
  test("builds a real two-parent merge whose members are on the side branch", async () => {
    const stack = await stackedRepo(3);
    const { repo, ref } = stack;
    const { ids } = await stackIds(repo, ref);

    await materializeGroups(stack, [{ memberIds: [ids[1]!, ids[2]!], message: "Merge: Commit 2" }]);

    // Trunk line is now: Commit 1, then the merge (2 parents).
    expect(await firstParentShape(repo, ref)).toEqual(["Commit 1:1", "Merge: Commit 2:2"]);
    // …and the members still exist, on the merge's second-parent side branch.
    const expanded = await getExpandedStackCommits(git, ref, { cwd: repo.path });
    expect(expanded.map((c) => c.subject)).toEqual(["Commit 1", "Commit 2", "Commit 3"]);
  });

  test("a single-commit merge group is allowed", async () => {
    const stack = await stackedRepo(2);
    const { repo, ref } = stack;
    const { ids } = await stackIds(repo, ref);

    await materializeGroups(stack, [{ memberIds: [ids[1]!], message: "Merge: Commit 2" }]);

    expect(await firstParentShape(repo, ref)).toEqual(["Commit 1:1", "Merge: Commit 2:2"]);
  });

  test("rejects a non-contiguous group before touching history", async () => {
    const stack = await stackedRepo(3);
    const { repo, ref } = stack;
    const { ids, hashById } = await stackIds(repo, ref);

    const built = buildMaterializePlan(
      ids,
      hashById,
      [{ memberIds: [ids[0]!, ids[2]!], message: "nope" }],
      {},
    );

    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("not contiguous");
  });

  test("rejects a group straddling two PR groups", async () => {
    const stack = await stackedRepo(2);
    const { repo, ref } = stack;
    const { ids, hashById } = await stackIds(repo, ref);

    const built = buildMaterializePlan(
      ids,
      hashById,
      [{ memberIds: [ids[0]!, ids[1]!], message: "nope" }],
      { [ids[0]!]: "groupA", [ids[1]!]: "groupB" },
    );

    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("more than one PR group");
  });
});

describe("merge groups survive the shared plumbing", () => {
  test("injectMissingIds does NOT stamp (and thereby flatten) a merge commit", async () => {
    // Regression: a merge commit carries no Spry-Commit-Id by design. Stamping
    // one sent it through the linear rewriteCommitChain, which rebuilt it with
    // a single parent — silently deleting the entire side branch.
    const stack = await stackedRepo(3);
    const { repo, ref } = stack;
    const { ids } = await stackIds(repo, ref);
    await materializeGroups(stack, [{ memberIds: [ids[1]!, ids[2]!], message: "Merge: Commit 2" }]);
    const before = await firstParentShape(repo, ref);

    const result = await injectMissingIds(git, ref, { cwd: repo.path });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.modifiedCount).toBe(0); // nothing needed an id
    expect(await firstParentShape(repo, ref)).toEqual(before);
  });

  test("a merge survives repeated command runs unchanged (stable SHA)", async () => {
    const stack = await stackedRepo(4);
    const { repo, ref } = stack;
    const { ids } = await stackIds(repo, ref);
    await materializeGroups(stack, [{ memberIds: [ids[1]!, ids[2]!], message: "Merge: Commit 2" }]);
    const tipAfterMaterialize = (await getStackCommits(git, ref, { cwd: repo.path })).at(-1)?.hash;

    for (let i = 0; i < 3; i++) await injectMissingIds(git, ref, { cwd: repo.path });

    const tipNow = (await getStackCommits(git, ref, { cwd: repo.path })).at(-1)?.hash;
    expect(tipNow).toBe(tipAfterMaterialize);
  });

  test("rewriteCommitChain preserves a merge commit's second parent", async () => {
    // Regression: the chain rewriter only ever emitted one parent, so any merge
    // it walked over was flattened. It must carry extra parents through.
    const stack = await stackedRepo(3);
    const { repo, ref } = stack;
    const { ids } = await stackIds(repo, ref);
    await materializeGroups(stack, [{ memberIds: [ids[1]!, ids[2]!], message: "Merge: Commit 2" }]);

    const chain = await getStackCommits(git, ref, { cwd: repo.path });
    const mergeBase = await getMergeBase(git, ref, { cwd: repo.path });
    const rewritten = await rewriteCommitChain(
      git,
      chain.map((c) => c.hash),
      new Map(), // no message changes — a pure re-link
      { cwd: repo.path, base: mergeBase },
    );
    await finalizeRewrite(git, stack.branch, chain.at(-1)!.hash, rewritten.newTip, {
      cwd: repo.path,
    });

    expect(await firstParentShape(repo, ref)).toEqual(["Commit 1:1", "Merge: Commit 2:2"]);
    const expanded = await getExpandedStackCommits(git, ref, { cwd: repo.path });
    expect(expanded.map((c) => c.subject)).toEqual(["Commit 1", "Commit 2", "Commit 3"]);
  });

  test("an existing merge round-trips back into the editor model", async () => {
    const stack = await stackedRepo(4);
    const { repo, ref } = stack;
    const { ids } = await stackIds(repo, ref);
    await materializeGroups(stack, [{ memberIds: [ids[1]!, ids[2]!], message: "Merge: Commit 2" }]);

    // Reopen, exactly as `sp group` does.
    await injectMissingIds(git, ref, { cwd: repo.path });
    const commits = await getExpandedStackCommits(git, ref, { cwd: repo.path });
    const withTrailers = parseCommitTrailers(commits, git, { cwd: repo.path });
    const records = await loadMergeGroupRecords(git, { cwd: repo.path });
    const state = createInitialState(
      withTrailers,
      {},
      {
        mergeGroups: buildCommitMergeGroupMap(records),
      },
    );

    expect(state.rows.map((r) => r.subject)).toEqual([
      "Commit 1",
      "Commit 2",
      "Commit 3",
      "Commit 4",
    ]);
    expect(state.rows.map((r) => r.mergeLetter)).toEqual([null, "a", "a", null]);
  });
});

describe("the TUI's enter output matches the equivalent --apply doc", () => {
  test("same members and same materialized history", async () => {
    // Build the SAME merge two ways and compare the resulting git history.
    //
    // Path A: drive the editor state machine and use extractResult's output.
    // Path B: the specs an --apply doc's `merge` node produces directly.
    const viaTui = await stackedRepo(4);
    const viaApply = await stackedRepo(4);

    // --- Path A: the TUI ---
    const a = await stackIds(viaTui.repo, viaTui.ref);
    const commits = parseCommitTrailers(
      await getExpandedStackCommits(git, viaTui.ref, { cwd: viaTui.repo.path }),
      git,
      { cwd: viaTui.repo.path },
    );
    let state = createInitialState(commits, {});
    state = applyEvent({ ...state, cursor: 1 }, { type: "shift-arrow-right" }); // group on Commit 2
    state = applyEvent({ ...state, cursor: 2 }, { type: "space" }); // grab Commit 3
    state = applyEvent(state, { type: "arrow-up" }); // …into the group
    state = applyEvent(state, { type: "space" }); // drop
    const result = extractResult(state);

    expect(result.mergeChanged).toBe(true);
    expect(result.mergeGroups).toHaveLength(1);
    expect(result.mergeGroups[0]?.memberIds).toEqual([a.ids[1]!, a.ids[2]!]);

    await materializeGroups(
      viaTui,
      result.mergeGroups.map((mg) => ({
        memberIds: mg.memberIds,
        // What the command layer synthesizes when no message was written —
        // identical to --apply's placeholder.
        message: `Merge: ${mg.firstSubject}`,
      })),
    );

    // --- Path B: the equivalent --apply doc ---
    const b = await stackIds(viaApply.repo, viaApply.ref);
    await materializeGroups(viaApply, [
      { memberIds: [b.ids[1]!, b.ids[2]!], message: "Merge: Commit 2" },
    ]);

    // Same shape, same subjects, same member ordering.
    expect(await firstParentShape(viaTui.repo, viaTui.ref)).toEqual(
      await firstParentShape(viaApply.repo, viaApply.ref),
    );
    const tuiExpanded = await getExpandedStackCommits(git, viaTui.ref, { cwd: viaTui.repo.path });
    const applyExpanded = await getExpandedStackCommits(git, viaApply.ref, {
      cwd: viaApply.repo.path,
    });
    expect(tuiExpanded.map((c) => c.subject)).toEqual(applyExpanded.map((c) => c.subject));

    // And both recorded the same members — compared by stack POSITION, since
    // Spry-Commit-Ids are minted per repo and never match across the two.
    const tuiRecords = await loadMergeGroupRecords(git, { cwd: viaTui.repo.path });
    const applyRecords = await loadMergeGroupRecords(git, { cwd: viaApply.repo.path });
    const positions = (records: Record<string, { members: string[] }>, ids: string[]) =>
      Object.values(records).map((r) => r.members.map((m) => ids.indexOf(m)));
    expect(positions(tuiRecords, a.ids)).toEqual([[1, 2]]);
    expect(positions(applyRecords, b.ids)).toEqual(positions(tuiRecords, a.ids));
  });
});
