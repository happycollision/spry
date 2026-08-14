# Merge-aware PR units Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sp land` and `sp sync` treat a materialized merge group as a first-class PR unit, so `sp land --merges` works end-to-end and `sp sync` writes the PR-body merge-note.

**Architecture:** One shared modeling fix in `detectPRUnits` (`src/parse/stack.ts`) builds a proper PR unit for a merge commit — id from the stored merge-group record (stable), members from git topology (`getMergeMembers`), tip = the merge SHA. `checkSync` reads the merge-group state (as `sp view`/`sp group` already do) and enriches merge commits with their members before unit detection. Land's readiness check is made merge-aware, and `sp sync` passes `generateMergeNote(...)` when a unit is a merge.

**Tech Stack:** Bun, TypeScript, `bun test`. Design spec: `docs/superpowers/specs/2026-08-13-merge-aware-pr-units-design.md`.

**Conventions:**

- No `!` non-null assertions in `src/` (oxlint forbids; tests allow).
- Run tests with `bun test <path>` serially while iterating; `bun run test:concurrent` for the full suite.
- Don't use `git -C`; be in the repo dir.
- Verify with `bunx tsc --noEmit` and `bunx oxlint --type-aware src/` after source changes.
- After any suite run, `bun run docs:verify`; regenerate with `bun run docs:clean && bun test && bun run docs:build` if it drifts.

---

## File Structure

- `src/parse/types.ts` — add `mergeMembers?: CommitInfo[]` to `PRUnit` (Task 1).
- `src/parse/stack.ts` — `detectPRUnits` + `parseStack` gain merge awareness (Task 2).
- `src/commands/stack-analysis.ts` — `analyzeStack` stops flagging a merge commit's own missing id (Task 3).
- `src/commands/sync.ts` — `checkSync` reads merge-group state + enriches members; body build/splice pass the merge-note (Tasks 4, 5).
- `src/gh/pr-body.ts` — no change (helpers already exist); a new pure `mergeNoteFor(unit, commits)` lives in `src/commands/sync.ts` (Task 5).
- Tests: `tests/parse/stack.test.ts`, `tests/commands/land.test.ts`, `tests/commands/sync.test.ts`, `tests/commands/land.doc.test.ts`, `tests/commands/sync.doc.test.ts`.

---

## Task 1: Add `mergeMembers` to `PRUnit`

**Files:**

- Modify: `src/parse/types.ts:19-26`
- Test: `tests/parse/stack.test.ts`

- [ ] **Step 1: Add the field**

In `src/parse/types.ts`, change the `PRUnit` interface:

```ts
export interface PRUnit {
  type: "single" | "group";
  id: string;
  title: string | undefined;
  commitIds: string[];
  commits: string[];
  subjects: string[];
  // Present ONLY for a materialized merge group: the merge's side-branch member
  // commits (oldest-first). Its presence is the signal that this single unit is a
  // merge — its one `commits` entry is the merge commit itself, its `commitIds`
  // are the members' ids, and `sp sync` renders a merge-note from these members.
  // Absent on every ordinary single/group unit (behavior byte-unchanged).
  mergeMembers?: CommitInfo[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors (the field is optional; nothing sets it yet).

- [ ] **Step 3: Commit**

```bash
git add src/parse/types.ts
git commit -m "feat(merge-groups): PRUnit.mergeMembers field for merge units"
```

---

## Task 2: `detectPRUnits` builds a merge unit

**Files:**

- Modify: `src/parse/stack.ts:104-150` (`detectPRUnits`), `:152-206` (`parseStack`)
- Test: `tests/parse/stack.test.ts`

Background: `detectPRUnits(commits, titles, commitGroups)` walks the oldest-first commit list. A materialized merge commit has `parents.length >= 2`, `mergeMembers` populated (by the caller — Task 4), and no `Spry-Commit-Id`. It must become its own `single` unit rather than falling into the plain `else` branch. Its id is the merge-group id resolved from a new `mergeGroups: CommitMergeGroupMap` param (the id every member agrees on), falling back to `mergeSha.slice(0,8)` when unrecorded.

- [ ] **Step 1: Write the failing test**

Add to `tests/parse/stack.test.ts` (import `detectPRUnits` and types as the file already does; add `CommitMergeGroupMap` usage inline):

```ts
import { detectPRUnits } from "../../src/parse/stack.ts";
import type { CommitWithTrailers } from "../../src/parse/stack.ts";

function c(hash: string, subject: string, id?: string, extra: Partial<CommitWithTrailers> = {}): CommitWithTrailers {
  return { hash, subject, body: "", trailers: id ? { "Spry-Commit-Id": id } : {}, ...extra };
}

test("detectPRUnits: a merge commit becomes a single unit keyed by its merge-group id, with member ids", () => {
  const m1 = c("aaaa", "feat: add model", "m1m1m1m1");
  const m2 = c("bbbb", "feat: add handler", "m2m2m2m2");
  // The merge commit: 2 parents, members populated, NO Spry-Commit-Id.
  const merge = c("cccc", "Merge: feat: add model", undefined, {
    parents: ["pppp", "bbbb"],
    mergeMembers: [m1, m2],
  });
  const p1 = c("pppp", "feat: base", "p1p1p1p1");

  // Oldest-first first-parent walk: base commit, then the merge commit.
  const units = detectPRUnits([p1, merge], {}, {}, { m1m1m1m1: "mgmgmgmg", m2m2m2m2: "mgmgmgmg" });

  expect(units).toHaveLength(2);
  const mergeUnit = units[1];
  expect(mergeUnit?.type).toBe("single");
  expect(mergeUnit?.id).toBe("mgmgmgmg");
  expect(mergeUnit?.commits).toEqual(["cccc"]);
  expect(mergeUnit?.commitIds).toEqual(["m1m1m1m1", "m2m2m2m2"]);
  expect(mergeUnit?.subjects).toEqual(["Merge: feat: add model"]);
  expect(mergeUnit?.mergeMembers?.map((m) => m.hash)).toEqual(["aaaa", "bbbb"]);
});

test("detectPRUnits: an unrecorded merge falls back to the merge SHA prefix but keeps member ids", () => {
  const m1 = c("aaaaaaaa1111", "feat: a", "m1m1m1m1");
  const merge = c("ccccdddd9999", "Merge: feat: a", undefined, {
    parents: ["pppp", "aaaaaaaa1111"],
    mergeMembers: [m1],
  });
  const units = detectPRUnits([merge], {}, {}, {}); // empty merge map => unrecorded
  expect(units[0]?.id).toBe("ccccdddd"); // first 8 of the merge SHA
  expect(units[0]?.commitIds).toEqual(["m1m1m1m1"]);
  expect(units[0]?.mergeMembers).toHaveLength(1);
});

test("detectPRUnits: a merge-free stack is byte-identical to before (new branch inert)", () => {
  const a = c("h1", "A", "aaa11111");
  const b = c("h2", "B", "bbb22222");
  const withMap = detectPRUnits([a, b], {}, {}, { aaa11111: "ignored" });
  const withoutMap = detectPRUnits([a, b], {}, {});
  expect(withMap).toEqual(withoutMap);
  expect(withMap[0]?.mergeMembers).toBeUndefined();
  expect(withMap[1]?.mergeMembers).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/parse/stack.test.ts -t "detectPRUnits: a merge"`
Expected: FAIL — `detectPRUnits` takes 3 args today, so the 4th arg is ignored and the merge commit becomes `{ id: "cccc"... , commitIds: [] }`; assertions on id/commitIds/mergeMembers fail.

- [ ] **Step 3: Implement — add the merge param + branch**

In `src/parse/stack.ts`, change `detectPRUnits`'s signature and add a merge branch. Full replacement of the function body:

```ts
export function detectPRUnits(
  commits: CommitWithTrailers[],
  titles: GroupTitles = {},
  commitGroups: CommitGroupMap = {},
  mergeGroups: CommitMergeGroupMap = {},
): PRUnit[] {
  const units: PRUnit[] = [];
  let currentGroup: PRUnit | null = null;

  const flushGroup = () => {
    if (currentGroup) {
      units.push(currentGroup);
      currentGroup = null;
    }
  };

  for (const commit of commits) {
    // A materialized merge commit (2+ parents / members set) is its own PR unit:
    // it carries no Spry-Commit-Id and is identified by its members. Handle it
    // before the id/group logic so it never falls into the degenerate else path.
    const isMerge = (commit.parents?.length ?? 0) >= 2 || (commit.mergeMembers?.length ?? 0) > 0;
    if (isMerge) {
      flushGroup();
      const members = commit.mergeMembers ?? [];
      const memberIds = members
        .map((m) => m.trailers["Spry-Commit-Id"])
        .filter((id): id is string => !!id);
      // Resolve the stable merge-group id: the id every recorded member agrees on.
      const seen = new Set<string>();
      for (const id of memberIds) {
        const gid = mergeGroups[id];
        if (gid) seen.add(gid);
      }
      const mergeGroupId = seen.size === 1 ? [...seen][0] : undefined;
      units.push({
        type: "single",
        id: mergeGroupId ?? commit.hash.slice(0, 8),
        title: commit.subject,
        commitIds: memberIds,
        commits: [commit.hash],
        subjects: [commit.subject],
        mergeMembers: members,
      });
      continue;
    }

    const commitId = commit.trailers["Spry-Commit-Id"];
    const groupId = commitId ? commitGroups[commitId] : undefined;

    if (groupId) {
      if (currentGroup && currentGroup.id === groupId) {
        if (commitId) currentGroup.commitIds.push(commitId);
        currentGroup.commits.push(commit.hash);
        currentGroup.subjects.push(commit.subject);
      } else {
        flushGroup();
        currentGroup = {
          type: "group",
          id: groupId,
          title: titles[groupId],
          commitIds: commitId ? [commitId] : [],
          commits: [commit.hash],
          subjects: [commit.subject],
        };
      }
    } else {
      flushGroup();
      units.push({
        type: "single",
        id: commitId || commit.hash.slice(0, 8),
        title: commit.subject,
        commitIds: commitId ? [commitId] : [],
        commits: [commit.hash],
        subjects: [commit.subject],
      });
    }
  }

  flushGroup();
  return units;
}
```

Then thread the param through `parseStack` — change its signature and the final return:

```ts
export function parseStack(
  commits: CommitWithTrailers[],
  titles: GroupTitles = {},
  commitGroups: CommitGroupMap = {},
  mergeGroups: CommitMergeGroupMap = {},
): StackParseResult {
```

and at the end of `parseStack` (currently `return { ok: true, units: detectPRUnits(commits, titles, commitGroups) };`):

```ts
  return { ok: true, units: detectPRUnits(commits, titles, commitGroups, mergeGroups) };
}
```

Note: `CommitMergeGroupMap` is already imported in `src/parse/stack.ts` (line 6).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/parse/stack.test.ts`
Expected: PASS (all three new tests + existing tests unchanged).

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bunx oxlint --type-aware src/parse/stack.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/parse/stack.ts tests/parse/stack.test.ts
git commit -m "feat(merge-groups): detectPRUnits models a materialized merge as a PR unit"
```

---

## Task 3: `analyzeStack` — don't flag a merge commit's own missing id

**Files:**

- Modify: `src/commands/stack-analysis.ts:83-97` (the per-unit loop in `analyzeStack`)
- Test: `tests/commands/land.test.ts`

Background: `analyzeStack` (line 89) sets `missingId = unit.commits.some((sha) => missing.has(sha))`, where `missing` is every commit lacking a `Spry-Commit-Id`. A merge unit's single commit is the merge SHA, which legitimately has no id, so this would flag the merge unit `missingId: true` and land would refuse it. A merge unit's identity is its members, not the merge commit's trailer — so exclude the merge commit's own SHA from the check for merge units.

- [ ] **Step 1: Write the failing test**

Add to `tests/commands/land.test.ts` (it already imports `analyzeStack` indirectly via land; add a direct unit test — import at top: `import { analyzeStack } from "../../src/commands/stack-analysis.ts";`):

```ts
test("analyzeStack: a merge unit is NOT flagged missingId for the merge commit's own missing trailer", async () => {
  const repo = await makeConfiguredRepo();
  const git = createRealGitRunner();
  // Build a merge unit by hand: commits = [mergeSha] (no id), mergeMembers set.
  const mergeUnit = {
    type: "single" as const,
    id: "mgmgmgmg",
    title: "Merge: x",
    commitIds: ["m1m1m1m1", "m2m2m2m2"],
    commits: ["deadbeef"],
    subjects: ["Merge: x"],
    mergeMembers: [
      { hash: "aaaa", subject: "m1", body: "", trailers: { "Spry-Commit-Id": "m1m1m1m1" } },
      { hash: "bbbb", subject: "m2", body: "", trailers: { "Spry-Commit-Id": "m2m2m2m2" } },
    ],
  };
  const ctx = makeCtx(repo, stubGh(ghPrStub({}))!.gh);
  const analysis = await analyzeStack(
    ctx,
    {
      units: [mergeUnit],
      // The merge commit "deadbeef" has no id in the commit list => in `missing`.
      commits: [{ hash: "deadbeef", subject: "Merge: x", body: "", trailers: {} }],
      prCache: {},
      config: { trunk: "main", remote: "origin", branchPrefix: "spry/test" } as any,
    },
    { cwd: repo.path },
  );
  expect(analysis.units[0]?.missingId).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/commands/land.test.ts -t "NOT flagged missingId"`
Expected: FAIL — `missingId` is currently `true` because the merge SHA is in the `missing` set.

- [ ] **Step 3: Implement**

In `src/commands/stack-analysis.ts`, replace the `missingId` line inside the `analyzeStack` loop (line 89):

```ts
    // A merge unit's single commit is the merge commit, which carries no
    // Spry-Commit-Id by design (its identity is its members). Exclude that
    // merge SHA from the missing-id check; only real (non-merge) commits count.
    const mergeSha = unit.mergeMembers ? unit.commits.at(-1) : undefined;
    const missingId = unit.commits.some((sha) => sha !== mergeSha && missing.has(sha));
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/commands/land.test.ts -t "NOT flagged missingId"`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + full land file**

Run: `bunx tsc --noEmit && bunx oxlint --type-aware src/commands/stack-analysis.ts && bun test tests/commands/land.test.ts`
Expected: no errors; all land tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/stack-analysis.ts tests/commands/land.test.ts
git commit -m "feat(merge-groups): analyzeStack ignores a merge commit's own missing id"
```

---

## Task 4: `checkSync` reads merge-group state + enriches members

**Files:**

- Modify: `src/commands/sync.ts:172-183` (`checkSync` unit detection), and `:1088-1092` (`sp sync --all` per-branch path)
- Test: `tests/commands/sync.test.ts` (or a focused test file if sync.test.ts is unwieldy)

Background: `checkSync` reads the stack via `getStackCommits` (which populates `parents` but not `mergeMembers`) and calls `parseStack(withTrailers, groupTitles, commitGroups)`. It must (a) enrich each merge commit with its members via `getMergeMembers`, and (b) load merge-group records and pass the `CommitMergeGroupMap` to `parseStack`.

- [ ] **Step 1: Write the failing test**

Add to `tests/commands/sync.test.ts` a test that materializes a merge (via `groupCommand({apply})`) then calls `checkSync` and asserts the merge unit is well-formed. Imports: `import { checkSync } from "../../src/commands/sync.ts";` `import { groupCommand } from "../../src/commands/group.ts";` (add if absent).

```ts
test("checkSync: a materialized merge surfaces as a unit keyed by merge-group id with member ids", async () => {
  const repo = await makeConfiguredRepo(); // sets spry.trunk/remote/branchPrefix
  const git = createRealGitRunner();
  await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "feat: p1\n\nSpry-Commit-Id: p1p1p1p1"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "feat: m1\n\nSpry-Commit-Id: m1m1m1m1"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "feat: m2\n\nSpry-Commit-Id: m2m2m2m2"], { cwd: repo.path });
  const ctx = makeCtx(repo, stubGh(ghPrStub({}))!.gh);
  // Materialize the merge group over m1,m2.
  await runApply(ctx, repo, {
    stack: [
      { type: "commit", id: "p1p1p1p1" },
      { type: "merge", id: "mgmgmgmg", commits: [{ type: "commit", id: "m1m1m1m1" }, { type: "commit", id: "m2m2m2m2" }] },
    ],
  });
  const checked = await checkSync(ctx, { cwd: repo.path });
  const mergeUnit = checked.units.find((u) => u.mergeMembers);
  expect(mergeUnit).toBeDefined();
  expect(mergeUnit?.id).toBe("mgmgmgmg");
  expect(mergeUnit?.commitIds).toEqual(["m1m1m1m1", "m2m2m2m2"]);
  expect(mergeUnit?.commits).toHaveLength(1);
});
```

Add the `runApply` helper near the top of the test file (mirrors the pattern in `tests/commands/view-merge.test.ts`):

```ts
async function runApply(ctx: SpryContext, repo: TestRepo, docObj: unknown): Promise<void> {
  const logs = await captureLogs();
  const trap = trapExit();
  try {
    await groupCommand(ctx, { cwd: repo.path, apply: JSON.stringify(docObj) });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "process.exit") throw e;
  } finally {
    trap.restore();
    logs.restore();
  }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/commands/sync.test.ts -t "materialized merge surfaces"`
Expected: FAIL — today the merge unit has `id = <mergeSha prefix>`, `commitIds: []`, and `mergeMembers` undefined, so `find(u => u.mergeMembers)` is undefined.

- [ ] **Step 3: Preserve `parents` through `parseCommitTrailers`**

CRITICAL: `parseCommitTrailers` (`src/parse/trailers.ts:118-133`) currently rebuilds each commit with only `hash/subject/body/trailers` and **drops `parents`**. The enrichment in the next step reads `withTrailers[].parents` to find merge commits, so it must be preserved. Change the `.map` in `parseCommitTrailers`:

```ts
  return commits.map((commit) => ({
    hash: commit.hash,
    subject: commit.subject,
    body: commit.body,
    // Preserve topology fields so downstream (checkSync merge enrichment) can
    // still see which commits are merges. parseTrailersSync only reads the
    // message; it never needed these, but dropping them lost the merge signal.
    parents: commit.parents,
    mergeMembers: commit.mergeMembers,
    trailers: parseTrailersSync(reconstructMessage(commit)),
  }));
```

Add a focused test in `tests/parse/trailers.test.ts`:

```ts
test("parseCommitTrailers preserves parents (topology)", () => {
  const [out] = parseCommitTrailers([
    { hash: "m", subject: "Merge", body: "", trailers: {}, parents: ["p1", "p2"] },
  ]);
  expect(out?.parents).toEqual(["p1", "p2"]);
});
```

Run: `bun test tests/parse/trailers.test.ts` — Expected: PASS (and existing trailer tests unaffected).

- [ ] **Step 4: Implement — enrich members + read state in checkSync**

In `src/commands/sync.ts`, add imports at the top with the other git imports:

```ts
import { getMergeMembers } from "../git/queries.ts";
import { loadMergeGroupRecords, buildCommitMergeGroupMap } from "../git/merge-groups.ts";
```

Then replace lines 172-178 (`const commits = await getStackCommits...` through the `parseStack` call):

```ts
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = parseCommitTrailers(commits, ctx.git, { cwd });

  // Enrich merge commits (2+ parents) with their side-branch members so unit
  // detection can key a merge unit by its members. getStackCommits gives parents
  // (now preserved through parseCommitTrailers) but not members; getMergeMembers
  // walks the second parent. Members are re-run through parseCommitTrailers so
  // each carries its Spry-Commit-Id (required to derive the unit's commitIds).
  for (const c of withTrailers) {
    if ((c.parents?.length ?? 0) >= 2) {
      const members = await getMergeMembers(ctx.git, c.hash, { cwd });
      c.mergeMembers = parseCommitTrailers(members, ctx.git, { cwd });
    }
  }

  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);
  const mergeRecords = await loadMergeGroupRecords(ctx.git, { cwd });
  const mergeGroups = buildCommitMergeGroupMap(mergeRecords);
  const parsed = parseStack(withTrailers, groupTitles, commitGroups, mergeGroups);
```

Note: `CommitWithTrailers.mergeMembers` is typed `CommitWithTrailers[]`; `parseCommitTrailers` returns exactly that, so the assignment typechecks.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/commands/sync.test.ts -t "materialized merge surfaces"`
Expected: PASS.

- [ ] **Step 6: Apply the same enrichment to `sp sync --all`**

In `src/commands/sync.ts` around line 1088-1092 (the `--all` per-branch loop using `getStackCommitsForBranch` + `parseStack`), add the same member enrichment + merge-map read. Replace:

```ts
    const commits = await getStackCommitsForBranch(ctx.git, branch, ref, { cwd });
    const withTrailers = parseCommitTrailers(commits, ctx.git, { cwd });
    ...
    const result = parseStack(withTrailers, groupTitles, commitGroups);
```

with member enrichment before `parseStack` and the merge map passed in (mirror Step 4; `mergeRecords`/`mergeGroups` may be loaded once outside the loop if the loop structure allows — otherwise load per-branch). Confirm the exact surrounding variable names by reading the function first.

- [ ] **Step 7: Typecheck + lint + full sync file**

Run: `bunx tsc --noEmit && bunx oxlint --type-aware src/commands/sync.ts && bun test tests/commands/sync.test.ts`
Expected: no errors; sync tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "feat(merge-groups): checkSync reads merge-group state and enriches merge members"
```

---

## Task 5: `sp sync` writes the PR-body merge-note

**Files:**

- Modify: `src/commands/sync.ts` — new pure `mergeNoteFor`, wired into `buildInitialBody` (line ~614) and `spliceBody` (line ~922-925)
- Test: `tests/commands/sync.test.ts`

Background: both body sites have `unit` and `commits` in scope. `MergeNote` needs `{ subject, memberSubjects, mergeParentSubject? }`. For a merge unit: `subject = unit.subjects[0]`, `memberSubjects = unit.mergeMembers.map(m => m.subject)`, `mergeParentSubject = ` the subject of the merge's first parent (the commit just below it in the stack).

- [ ] **Step 1: Write the failing test**

Add to `tests/commands/sync.test.ts`:

```ts
import { MARKERS } from "../../src/gh/pr-body.ts";

test("sync: a merge unit's created PR body contains the spry:merge-note region", async () => {
  const repo = await makeConfiguredRepo();
  const git = createRealGitRunner();
  await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "feat: p1\n\nSpry-Commit-Id: p1p1p1p1"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "feat: m1\n\nSpry-Commit-Id: m1m1m1m1"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "feat: m2\n\nSpry-Commit-Id: m2m2m2m2"], { cwd: repo.path });
  const { gh, calls } = stubGh(ghPrStub({}));
  const ctx = makeCtx(repo, gh);
  await runApply(ctx, repo, {
    stack: [
      { type: "commit", id: "p1p1p1p1" },
      { type: "merge", id: "mgmgmgmg", commits: [{ type: "commit", id: "m1m1m1m1" }, { type: "commit", id: "m2m2m2m2" }] },
    ],
  });
  // Open PRs for the stack; capture the merge unit's create body.
  await runSyncOpen(ctx, repo, ["p1p1p1p1", "mgmgmgmg"]); // helper: sync --open with ids
  const createCall = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create" && (c.args.join(" ").includes("mgmgmgmg")));
  expect(createCall).toBeDefined();
  const bodyArg = createCall!.args[createCall!.args.indexOf("--body") + 1];
  expect(bodyArg).toContain(MARKERS.MERGE_NOTE_BEGIN);
  expect(bodyArg).toContain("Merge:");
  expect(bodyArg).toContain("| * feat: m2"); // members rendered newest-first
});
```

If `runSyncOpen` doesn't exist in the file, add a helper that calls `syncCommand(ctx, { cwd: repo.path, open: ids })` wrapped in `trapExit`/`captureLogs` like `runApply`. Read the existing sync tests for the exact `syncCommand` open-option name before writing it.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/commands/sync.test.ts -t "merge-note region"`
Expected: FAIL — the create body has no `MERGE_NOTE_BEGIN` (sync passes no `mergeNote`).

- [ ] **Step 3: Implement — add `mergeNoteFor` + wire both sites**

In `src/commands/sync.ts`, add the import:

```ts
import { generateMergeNote } from "../gh/index.ts";
import type { MergeNote } from "../gh/index.ts";
```

Add a pure helper near the other module-level helpers:

```ts
// Build the merge-note for a PR unit: "" unless the unit is a materialized merge
// (mergeMembers present). The merge-parent subject is the commit directly below
// the merge in the stack — found by the merge unit's position in `commits`.
function mergeNoteFor(unit: PRUnit, commits: CommitWithTrailers[]): string {
  if (!unit.mergeMembers || unit.mergeMembers.length === 0) return "";
  const mergeSha = unit.commits.at(-1);
  const idx = commits.findIndex((c) => c.hash === mergeSha);
  const parentSubject = idx > 0 ? commits[idx - 1]?.subject : undefined;
  const note: MergeNote = {
    subject: unit.subjects[0] ?? "",
    memberSubjects: unit.mergeMembers.map((m) => m.subject),
    mergeParentSubject: parentSubject,
  };
  return generateMergeNote([note]);
}
```

Wire the create-body site (line ~614). Change:

```ts
    const body = buildInitialBody({ unit, commits: commitInfos, stackLinks, prTemplate });
```

to:

```ts
    const body = buildInitialBody({
      unit,
      commits: commitInfos,
      stackLinks,
      prTemplate,
      mergeNote: mergeNoteFor(unit, commitInfos),
    });
```

Wire the splice site (line ~922). Change:

```ts
      const next = spliceBody(existing, {
        bodyContent: generateBodyContent(unit, commits),
        stackLinks,
      });
```

to:

```ts
      const next = spliceBody(existing, {
        bodyContent: generateBodyContent(unit, commits),
        stackLinks,
        mergeNote: mergeNoteFor(unit, commits),
      });
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/commands/sync.test.ts -t "merge-note region"`
Expected: PASS.

- [ ] **Step 5: Confirm merge-free PRs are byte-unchanged**

Run: `bun test tests/commands/sync.test.ts`
Expected: PASS — `mergeNoteFor` returns "" for every non-merge unit, so `buildInitialBody`/`spliceBody` omit the region exactly as before (see `tests/gh/pr-body.test.ts` "omits the merge-note region entirely when there is no note").

- [ ] **Step 6: Typecheck + lint**

Run: `bunx tsc --noEmit && bunx oxlint --type-aware src/commands/sync.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "feat(merge-groups): sp sync writes the PR-body merge-note for merge units"
```

---

## Task 6: End-to-end land test — the `--merges` gate

**Files:**

- Test: `tests/commands/land.test.ts`

Background: prove that with Tasks 2-4 done, `sp land` over a materialized merge reaches the `--merges` gate (not "not ready"): refuses without `--merges`, lands with it.

- [ ] **Step 1: Write the failing test (should already pass after Tasks 2-4 — this pins it)**

Add to `tests/commands/land.test.ts` a helper that builds + materializes + pushes a merge stack, then two cases. Model the push on `publishedStack`; the merge unit's branch is `spry/test/<merge-group-id>` and its tip is the merge SHA.

```ts
async function publishedMergeStack(repo: TestRepo, git: ReturnType<typeof createRealGitRunner>) {
  await git.run(["checkout", "-b", "feature"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "feat: p1\n\nSpry-Commit-Id: p1p1p1p1"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "feat: m1\n\nSpry-Commit-Id: m1m1m1m1"], { cwd: repo.path });
  await git.run(["commit", "--allow-empty", "-m", "feat: m2\n\nSpry-Commit-Id: m2m2m2m2"], { cwd: repo.path });
  const ctx = makeCtx(repo, stubGh(ghPrStub({}))!.gh);
  await runApply(ctx, repo, {
    stack: [
      { type: "commit", id: "p1p1p1p1" },
      { type: "merge", id: "mgmgmgmg", commits: [{ type: "commit", id: "m1m1m1m1" }, { type: "commit", id: "m2m2m2m2" }] },
    ],
  });
  const mergeSha = (await git.run(["rev-parse", "HEAD"], { cwd: repo.path })).stdout.trim();
  const p1 = (await git.run(["rev-parse", "HEAD^1"], { cwd: repo.path })).stdout.trim();
  await git.run(["push", "origin", `${p1}:refs/heads/spry/test/p1p1p1p1`], { cwd: repo.path });
  await git.run(["push", "origin", `${mergeSha}:refs/heads/spry/test/mgmgmgmg`], { cwd: repo.path });
  return { mergeSha };
}

test("land over a materialized merge: refuses without --merges (the gate, not 'not ready')", async () => {
  const repo = await makeConfiguredRepo();
  const git = createRealGitRunner();
  await publishedMergeStack(repo, git);
  const { gh } = stubGh(ghPrStub({
    "spry/test/p1p1p1p1": { number: 1, base: "main" },
    "spry/test/mgmgmgmg": { number: 2, base: "spry/test/p1p1p1p1" },
  }));
  const ctx = makeCtx(repo, gh);
  const logs = await captureLogs();
  const trap = trapExit();
  await runLand(ctx, { cwd: repo.path, through: "mgmgmgmg" });
  trap.restore();
  logs.restore();
  const text = logs.err.join("\n");
  expect(text).toContain("merge commit");        // the gate message
  expect(text).toContain("--merges");
  expect(text).not.toContain("not ready");        // NOT the readiness failure
});

test("land over a materialized merge: --merges advances origin/main to the merge tip", async () => {
  const repo = await makeConfiguredRepo();
  const git = createRealGitRunner();
  const { mergeSha } = await publishedMergeStack(repo, git);
  const { gh } = stubGh(ghPrStub({
    "spry/test/p1p1p1p1": { number: 1, base: "main" },
    "spry/test/mgmgmgmg": { number: 2, base: "spry/test/p1p1p1p1" },
  }));
  const ctx = makeCtx(repo, gh);
  const logs = await captureLogs();
  const trap = trapExit();
  await runLand(ctx, { cwd: repo.path, through: "mgmgmgmg", merges: true });
  trap.restore();
  logs.restore();
  const originMain = (await git.run(["rev-parse", "origin/main"], { cwd: repo.path })).stdout.trim();
  expect(originMain).toBe(mergeSha);
});
```

- [ ] **Step 2: Run**

Run: `bun test tests/commands/land.test.ts -t "over a materialized merge"`
Expected: PASS (both). If the first fails with "not ready", Task 3 is incomplete; if it fails resolving `mgmgmgmg`, Task 2/4 is incomplete.

- [ ] **Step 3: Full land + sync suites**

Run: `bun test tests/commands/land.test.ts tests/commands/sync.test.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/commands/land.test.ts
git commit -m "test(merge-groups): end-to-end sp land --merges over a materialized merge"
```

---

## Task 7: Doc/story tests (unblocks spry-jxqg.1)

**Files:**

- Test: `tests/commands/land.doc.test.ts`, `tests/commands/sync.doc.test.ts`

Background: with the feature reachable end-to-end, add the two human-facing doc tests deferred in `spry-jxqg.1`. The `--merges` land doc test can run offline via the in-process `landCommand` + stub gh pattern OR through the cassette-backed doc harness; prefer offline if the existing `land.doc.test.ts` infra supports a `runLand`-style in-process capture. The sync merge-note doc test shows a rendered PR body region.

- [ ] **Step 1: Write the `--merges` land doc test**

Follow the offline `docTest` pattern (see `tests/commands/view.doc.test.ts` for `docTest` + `runSp`, and Task 6 for the merge-stack setup). Assert the refusal names the merge and `--merges`, and (second capture) the acknowledged land advances trunk. Capture with `doc.command(...)` + `doc.output(...)`. Use `{ section: "commands/land", order: <next-free> }`.

- [ ] **Step 2: Write the sync merge-note doc test**

Add to `tests/commands/sync.doc.test.ts` a case that materializes a merge, opens its PR (cassette-backed if that file is cassette-backed; otherwise stub-gh capture), and shows the PR body's `spry:merge-note` region. Assert the rendered region contains `Merge:` and a member subject.

- [ ] **Step 3: Run the doc tests + regenerate docs**

Run: `bun test tests/commands/land.doc.test.ts tests/commands/sync.doc.test.ts`
Then: `bun run docs:build`
Expected: PASS; new merge sections appear in `docs/generated/commands/land.*` and `sync.*`.

- [ ] **Step 4: Full-suite docs determinism**

Run: `bun run docs:clean && bun test && bun run docs:build && bun test && bun run docs:verify`
Expected: `docs:verify` passes (docs deterministic and in sync).

- [ ] **Step 5: Commit**

```bash
git add tests/commands/land.doc.test.ts tests/commands/sync.doc.test.ts docs/generated/ CHANGELOG.md
git commit -m "test(merge-groups): doc tests for sp land --merges and PR-body merge-note"
```

- [ ] **Step 6: Close the beads issues**

```bash
br close spry-phl7 --reason "sp land readiness now merge-aware; --merges works end-to-end (Tasks 2-6)"
br close spry-w6qk --reason "sp sync writes the PR-body merge-note for merge units (Tasks 4-5)"
br close spry-jxqg.1 --reason "doc tests for --merges + merge-note added (Task 7)"
```

---

## Final verification (before merge)

- [ ] `bunx tsc --noEmit` — clean
- [ ] `bunx oxlint --type-aware src/` — 0 errors
- [ ] `bun run test:concurrent` (or serial `bun test`) — 0 fail
- [ ] `bun run docs:verify` — in sync
- [ ] CHANGELOG.md updated under `[Unreleased]` describing the two now-wired surfaces
- [ ] Dogfood: `sp sync` then `sp sync --open <top-id>` to open a PR for this work
